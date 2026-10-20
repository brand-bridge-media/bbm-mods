#!/usr/bin/env python3
"""PreToolUse guard — Supabase exposure rules, applied before SQL runs or a migration is written (LCH-531).

WHAT IT DOES. Runs supabase_rules.evaluate (the same module the PR gate runs) on what a
session is about to do:

  * Supabase MCP `execute_sql` / `apply_migration`: the query.
  * Write / Edit / MultiEdit of a `supabase/migrations/*.sql` file: the file as it will
    be AFTER the edit (an Edit's new text alone could not show a fix elsewhere in it).

Any BLOCK (R1 table without RLS, R2 view without security_invoker, R3 SECURITY DEFINER
unrevoked or without search_path, R4 unmarked GRANT to anon/authenticated) DENIES the
call, naming every blocking rule and its fix. WARN (R5) and NOT CHECKED (a DO block)
ride along as context; the call runs.

WHY. Each rule broke in a real migration a reviewed PR shipped (LC-1550, LC-1611,
LC-1099; LCH-530). The PR gate catches a PR; this catches the session before the file
exists or the SQL runs, which is where those started.

Self-test: python3 supabase-guard.py --selftest
"""
from __future__ import annotations

import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import supabase_rules as rules  # noqa: E402

MIGRATION = re.compile(r"(?:^|/)supabase/migrations/[^/]+\.sql$")
CALLOUT = "[mod:supabase-guard]"


def _after_edit(path: str, edits: list[dict]) -> str:
    """The file's text once the edits apply; the edits' new text alone if it cannot be read."""
    try:
        with open(path, encoding="utf-8") as fh:
            text = fh.read()
    except OSError:
        return "\n".join(str(e.get("new_string") or "") for e in edits)
    for e in edits:
        old, new = str(e.get("old_string") or ""), str(e.get("new_string") or "")
        text = text.replace(old, new) if e.get("replace_all") else text.replace(old, new, 1)
    return text


def sql_for(tool_name: str, tool_input: dict) -> str | None:
    """The SQL this call would run or leave in a migration file; None when it is none of ours."""
    low = tool_name.lower()
    if low.startswith("mcp__") and (low.endswith("__execute_sql") or low.endswith("__apply_migration")):
        q = tool_input.get("query")
        return q if isinstance(q, str) else ""
    path = str(tool_input.get("file_path") or "").replace("\\", "/")
    if not MIGRATION.search(path):
        return None
    if tool_name == "Write":
        return str(tool_input.get("content") or "")
    if tool_name == "Edit":
        return _after_edit(path, [tool_input])
    if tool_name == "MultiEdit":
        edits = tool_input.get("edits")
        return _after_edit(path, [e for e in edits if isinstance(e, dict)] if isinstance(edits, list) else [])
    return None


def evaluate(tool_name: str, tool_input: dict) -> dict | None:
    sql = sql_for(tool_name or "", tool_input)
    if sql is None:  # not ours (equivalent-mutant note: the rules would also pass "", this just says so first)
        return None
    results = rules.evaluate(sql)
    blocks = [r for r in results if r.verdict == rules.BLOCK]
    if blocks:
        return {"permissionDecision": "deny", "permissionDecisionReason": f"{CALLOUT} REFUSED: " + " || ".join(
            f"{r.rule} {r.reason}" for r in blocks)}
    notes = [f"{r.rule} {r.verdict}: {r.reason}" for r in results if r.verdict in (rules.WARN, rules.NOT_CHECKED)]
    return {"additionalContext": f"{CALLOUT} " + " | ".join(notes)} if notes else None


def _selftest() -> int:
    import subprocess
    import tempfile
    checks = fails = 0

    def ck(cond: bool, label: str) -> None:
        nonlocal checks, fails
        checks += 1
        if not cond:
            fails += 1
            sys.stderr.write(f"  FAIL: {label}\n")

    SQL = "mcp__Supabase__execute_sql"
    BAD = "create table if not exists public.price_write_policy (mode text)"
    GOOD = BAD + "; alter table public.price_write_policy enable row level security"
    d = evaluate(SQL, {"query": BAD})
    ck(bool(d) and d["permissionDecision"] == "deny" and CALLOUT in d["permissionDecisionReason"]
       and "R1 " in d["permissionDecisionReason"], "execute_sql R1 replay denied, naming the rule")
    ck(evaluate(SQL, {"query": GOOD}) is None, "with RLS in the same call: allowed, silently")
    d = evaluate(SQL, {"query": rules.REPLAY_R3_R4_LC1099})
    ck(bool(d) and all(f"R{n} " in d["permissionDecisionReason"] for n in (2, 3, 4)),
       "the LC-1099 replay names R2, R3 and R4 together")
    ck((evaluate("mcp__Supabase__apply_migration", {"name": "m", "query": rules.REPLAY_R2_LC1611}) or {})
       .get("permissionDecision") == "deny", "apply_migration checked too (R2 replay)")
    ck(evaluate(SQL, {"query": "select 1"}) is None, "ordinary SQL untouched")
    ck(evaluate("mcp__Webflow__data_cms_tool", {"query": BAD}) is None,
       "a non-SQL MCP tool carrying a `query` field is not SQL")
    ck(evaluate(SQL, {"query": None}) is None, "a non-string query is not judged here")
    w = evaluate(SQL, {"query": "create function public.p() returns int language sql as $$ select 1 $$"})
    ck(bool(w) and "R5 WARN" in w.get("additionalContext", ""), "R5 warns, the call runs")
    n = evaluate(SQL, {"query": "do $$ begin perform 1; end $$"})
    ck(bool(n) and "NOT CHECKED" in n.get("additionalContext", ""), "a DO block is reported NOT CHECKED, not passed")

    with tempfile.TemporaryDirectory() as tmp:
        mig = os.path.join(tmp, "supabase", "migrations", "20261020000000_x.sql")
        os.makedirs(os.path.dirname(mig))
        deny = lambda v: bool(v) and v.get("permissionDecision") == "deny"  # noqa: E731
        ck(deny(evaluate("Write", {"file_path": mig, "content": BAD})), "Write of a migration without RLS denied")
        ck(evaluate("Write", {"file_path": mig, "content": GOOD}) is None, "Write with RLS allowed")
        with open(mig, "w") as fh:
            fh.write(GOOD)
        ck(evaluate("Edit", {"file_path": mig, "old_string": "(mode text)", "new_string": "(mode text, x int)"}) is None,
           "an Edit elsewhere in a file that already enables RLS is allowed (whole file judged)")
        ck(deny(evaluate("Edit", {"file_path": mig, "new_string": "",
                                  "old_string": "; alter table public.price_write_policy enable row level security"})),
           "an Edit that removes the ENABLE is denied")
        ck(evaluate("MultiEdit", {"file_path": mig, "edits": [
            {"old_string": "policy", "new_string": "pol", "replace_all": True}]}) is None,
           "MultiEdit replace_all applied before judging")
        ck(deny(evaluate("MultiEdit", {"file_path": mig, "edits": [
            {"old_string": "(mode text)", "new_string": "(mode text); create view public.v as select 1"}]})),
           "MultiEdit adding a view without security_invoker is denied (R2)")
        missing = os.path.join(tmp, "supabase", "migrations", "20261020000001_new.sql")
        ck(deny(evaluate("Edit", {"file_path": missing, "old_string": "", "new_string": BAD})),
           "an unreadable file is judged on the edit's new text")
    ck(evaluate("Write", {"file_path": "/r/notes/create-table.sql", "content": BAD}) is None,
       "a .sql outside supabase/migrations is not a migration")
    ck(evaluate("Write", {"file_path": "/r/supabase/migrations/README.md", "content": BAD}) is None, "non-.sql untouched")
    ck(evaluate("Read", {"file_path": "/r/supabase/migrations/x.sql"}) is None, "reads untouched")
    ck(evaluate("Bash", {"command": "psql -c 'create table t (a int)'"}) is None, "Bash untouched")

    def run(s: str):
        return subprocess.run([sys.executable, os.path.abspath(__file__)], input=s, capture_output=True, text=True)
    p = run(json.dumps({"tool_name": SQL, "tool_input": {"query": BAD}}))
    ck(p.returncode == 0 and json.loads(p.stdout or "{}").get("hookSpecificOutput", {}).get("permissionDecision") == "deny",
       "main(): emits deny")
    p = run(json.dumps({"tool_name": SQL, "tool_input": {"query": "select 1"}}))
    ck(p.returncode == 0 and p.stdout == "", "main(): a fine call emits nothing")
    p = run("{x")
    ck(p.returncode == 1 and p.stdout == "", "main(): junk fails open and visible")

    print(f"supabase-guard selftest: {checks - fails}/{checks} checks passed")
    return 1 if fails else 0


def main() -> int:
    if "--selftest" in sys.argv:
        return _selftest()
    try:
        raw = sys.stdin.read()
        payload = json.loads(raw) if raw.strip() else {}
        tool_input = payload.get("tool_input") or {}
        out = evaluate(payload.get("tool_name") or "", tool_input if isinstance(tool_input, dict) else {})
    except Exception as e:  # noqa: BLE001
        sys.stderr.write(f"supabase-guard: could not evaluate ({e}); allowing the call.\n")
        return 1
    if out:
        json.dump({"hookSpecificOutput": {"hookEventName": "PreToolUse", **out}}, sys.stdout)
        sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
