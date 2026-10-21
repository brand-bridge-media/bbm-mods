#!/usr/bin/env python3
"""PostToolUse nudge — a knowledge query result is read at its ACTIVE node (LCH-528).

WHAT IT DOES. After a Supabase `execute_sql` that reads `knowledge_memories` or
`knowledge_articles`, injects context when:

  * a returned row carries a non-null `superseded_by` — names each superseded id and
    its replacement, so the session walks to the active node before trusting it;
  * the query neither filters `is_active` nor selects `superseded_by` — the result
    may silently include retired memories.

WHY. The operator's preference and the knowledge-system skill both say "walk superseded_by
before trusting a memory". The query that skips it looks exactly like the one that
does; only the result tells them apart, and PostToolUse is the one place a hook
sees the result. A nudge, not a block: the read already happened and is harmless.

Self-test: python3 knowledge-superseded-check.py --selftest
"""
from __future__ import annotations

import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import sql_lexer  # noqa: E402

# A READ of the knowledge tables: literals stripped first, so a table name inside a
# string (information_schema lookups) or an INGEST INSERT does not count.
KNOWLEDGE_READ = re.compile(r"\b(?:from|join)\s+(?:public\.)?knowledge_(?:memories|articles)\b")
UUID = r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
ROW_SUPERSEDED = re.compile(
    rf'"id"\s*:\s*"({UUID})"[^{{}}]*?"superseded_by"\s*:\s*"({UUID})"'
    rf'|"superseded_by"\s*:\s*"({UUID})"[^{{}}]*?"id"\s*:\s*"({UUID})"', re.IGNORECASE)
ANY_SUPERSEDED = re.compile(rf'"superseded_by"\s*:\s*"({UUID})"', re.IGNORECASE)


def _text(resp) -> str:
    if isinstance(resp, str):
        return resp
    try:
        return json.dumps(resp)
    except (TypeError, ValueError):
        return ""


def evaluate(tool_name: str, tool_input: dict, tool_response) -> str | None:
    low = (tool_name or "").lower()
    if not (low.startswith("mcp__") and "supabase" in low and low.endswith("__execute_sql")):
        return None
    q = tool_input.get("query") or ""
    if not isinstance(q, str) or not any(
            st.startswith(("select", "with")) and KNOWLEDGE_READ.search(st)
            for st in sql_lexer.statements(q)):
        return None
    # Results arrive JSON-in-a-string; unescape one level so the row regex can see keys.
    body = _text(tool_response).replace('\\"', '"')
    notes = []
    pairs = [(m.group(1) or m.group(4), m.group(2) or m.group(3)) for m in ROW_SUPERSEDED.finditer(body)]
    if pairs:
        notes.append("Superseded rows in this result: " + "; ".join(
            f"{old[:8]} -> superseded by {new[:8]}" for old, new in pairs[:10])
            + ". Read the replacement before trusting the old row.")
    elif ANY_SUPERSEDED.search(body):
        ids = sorted({m.group(1)[:8] for m in ANY_SUPERSEDED.finditer(body)})
        notes.append("This result includes superseded rows (superseded_by -> "
                     + ", ".join(ids[:10]) + "). Walk to the active node before trusting them.")
    if not re.search(r"\bis_active\b", q, re.I) and not re.search(r"\bsuperseded_by\b", q, re.I):
        notes.append("The query neither filters `is_active = true` nor selects `superseded_by`, "
                     "so retired memories may be in the result (knowledge-system QUERY).")
    return ("[mod:knowledge-superseded-check] " + " ".join(notes)) if notes else None


def _selftest() -> int:
    checks = fails = 0

    def ck(cond: bool, label: str) -> None:
        nonlocal checks, fails
        checks += 1
        if not cond:
            fails += 1
            sys.stderr.write(f"  FAIL: {label}\n")

    S = "mcp__Supabase__execute_sql"
    A, B = "11111111-2222-3333-4444-555555555555", "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
    good_q = {"query": "select id, superseded_by from knowledge_memories where is_active"}
    row_old = json.dumps([{"id": A, "content": "x", "superseded_by": B}])
    row_new = json.dumps([{"id": B, "content": "x", "superseded_by": None}])

    r = evaluate(S, good_q, {"result": f"<untrusted>{row_old}</untrusted>"})
    ck(r and "11111111 -> superseded by aaaaaaaa" in r, "superseded row named with replacement")
    r = evaluate(S, good_q, json.dumps({"result": row_old}))  # double-encoded string
    ck(r and "superseded by aaaaaaaa" in r, "escaped JSON-in-string result is read")
    r = evaluate(S, good_q, json.dumps([{"superseded_by": B, "content": "no id selected"}]))
    ck(r and "aaaaaaaa" in r and "Walk to the active node" in r, "superseded without id still flagged")
    ck(evaluate(S, good_q, row_new) is None, "active rows, filtered query -> silent")
    r = evaluate(S, {"query": "select content from knowledge_memories where content ilike '%x%'"}, "[]")
    ck(r and "is_active" in r, "unfiltered query nudged")
    ck(evaluate(S, {"query": "select * from knowledge_articles where superseded_by is null"}, "[]")
       is None, "selecting/filtering superseded_by counts as handling it")
    ck(evaluate(S, {"query": "select * from products"}, row_old) is None, "non-knowledge query untouched")
    ck(evaluate(S, {"query": "select column_name from information_schema.columns "
                             "where table_name='knowledge_memories'"}, "[]") is None,
       "a table name inside a string literal is not a read")
    ck(evaluate(S, {"query": "insert into knowledge_memories(content) values ('x') returning id"},
                "[]") is None, "an INGEST insert is not a read")
    ck(evaluate(S, {"query": "select m.id from public.knowledge_memories m"}, "[]") is not None,
       "schema-qualified read is still checked")
    ck(evaluate(S, {"query": "select 1 from t join knowledge_articles a on true"}, "[]") is not None,
       "a JOIN read is checked")
    ck(evaluate("mcp__Other__execute_sql", good_q, row_old) is None, "non-Supabase untouched")
    ck(evaluate(S, {}, None) is None, "missing input does not crash")
    ck(evaluate(S, good_q, object()) is None, "unserialisable response does not crash")
    r = evaluate(S, {"query": "select * from knowledge_memories"}, row_old)
    ck(r.startswith("[mod:knowledge-superseded-check]") and "superseded" in r and "is_active" in r,
       "both notes together, with the mod callout")

    import os
    import subprocess
    run = lambda s: subprocess.run([sys.executable, os.path.abspath(__file__)], input=s,  # noqa: E731
                                   capture_output=True, text=True)
    p = run(json.dumps({"tool_name": S, "tool_input": good_q, "tool_response": row_old}))
    ck(p.returncode == 0 and "superseded" in json.loads(p.stdout)["hookSpecificOutput"]
       ["additionalContext"], "main(): emits additionalContext")
    p = run("{x")
    ck(p.returncode == 1 and p.stdout == "", "main(): junk input fails open and visible")

    print(f"knowledge-superseded-check selftest: {checks - fails}/{checks} checks passed")
    return 1 if fails else 0


def main() -> int:
    if "--selftest" in sys.argv:
        return _selftest()
    try:
        raw = sys.stdin.read()
        payload = json.loads(raw) if raw.strip() else {}
        tool_input = payload.get("tool_input") or {}
        note = evaluate(payload.get("tool_name") or "",
                        tool_input if isinstance(tool_input, dict) else {},
                        payload.get("tool_response"))
    except Exception as e:  # noqa: BLE001
        sys.stderr.write(f"knowledge-superseded-check: could not evaluate ({e}).\n")
        return 1
    if note:
        json.dump({"hookSpecificOutput": {"hookEventName": "PostToolUse",
                                          "additionalContext": note}}, sys.stdout)
        sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
