#!/usr/bin/env python3
"""PreToolUse guard — a session write must PROVE it touches 5 rows or fewer (LCH-528, LC-1683).

WHAT IT DOES. Reads every data-modifying statement in a Supabase MCP `execute_sql`
call and DENIES it unless the text itself bounds the write to at most 5 rows:

  * UPDATE / DELETE  -> a top-level AND conjunct `<key> = <literal>` or
                        `<key> IN (<= 5 literals)`, key in KEY_COLUMNS, no top-level OR.
  * INSERT ... VALUES -> at most 5 row tuples.
  * INSERT ... SELECT -> only with a trailing LIMIT <= 5.
  * TRUNCATE, MERGE, COPY ... FROM -> always denied.

Everything above 5 rows goes through a `data-changes/` package PR: lint, a production
dry-run with real counts on the PR, a CI apply that writes the data_change_runs
ledger, and a rollback.sql. That is CLAUDE.md §4 and the operator's gate (bulk writes to live
data need explicit approval), made mechanical.

WHY STATIC, NOT A COUNT. A hook gets no credentials and no MCP client (LC-1017,
memory 995e6ea9 — rejected on blast radius), so it cannot run SELECT count(*). What
it CAN do is demand the one shape that is provably small: an explicit id list. The
session runs its own count, and if the answer is <= 5 it rewrites the write against
those ids. That costs one extra query and leaves the exact rows in the transcript,
which is also the audit record a direct write was missing.

WHY KEY_COLUMNS IS SO NARROW. `slug`, `run_id`, `brand_id` look like keys and are not:
refresh_runs has many rows per slug, refresh_run_sections many per run_id. Only
columns that are a primary or unique key across the tables sessions write to are
accepted. A narrow list costs a rewrite; a loose one is a hole.

NOT GATED. Function calls (`select registrar_fn(...)`): the sanctioned RPCs carry
their own guards (e.g. the LC-1550 price registrar). DDL: prod-deploy-guard.

Self-test: python3 bulk-write-guard.py --selftest
"""
from __future__ import annotations

import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import sql_lexer  # noqa: E402

MAX_ROWS = 5
KEY_COLUMNS = {"id", "uuid", "webflow_id", "webflow_item_id"}

_LIT = r"(?:'\?'|-?\d+(?:\.\d+)?|\$\d+)(?:::\w+(?:\[\])?)?"
_COL = r"(?:(\w+)\.)?(\w+)"
EQ = re.compile(rf"^\(?\s*{_COL}\s*=\s*{_LIT}\s*\)?$")
EQ_REV = re.compile(rf"^\(?\s*{_LIT}\s*=\s*{_COL}\s*\)?$")
IN = re.compile(rf"^{_COL}\s+in\s*\((.*)\)$")
ANY = re.compile(rf"^{_COL}\s*=\s*any\s*\(\s*(?:array\s*)?\[(.*)\](?:::\w+\[\])?\s*\)$")
LIT_ONLY = re.compile(rf"^{_LIT}$")

# Words that look like a DML verb but belong to another clause.
_NOT_DML_BEFORE = {"for", "do", "on", "key", "of"}
DML = re.compile(r"\b(update|delete|insert|merge|truncate|copy)\b")
_CLAUSE_END = re.compile(r"\b(returning|order by|limit)\b")


def _key_bound(cond: str, own: set[str]) -> int | None:
    """Rows a single conjunct provably bounds the write to, else None.

    `own` is the write target's name and alias: `b.id = 'x'` on a joined table `b`
    bounds `b`, not the rows being written, so a qualifier must name the target.
    """
    cond = cond.strip()
    for rx in (EQ, EQ_REV):
        m = rx.match(cond)
        if m and m.group(2) in KEY_COLUMNS and (m.group(1) is None or m.group(1) in own):
            return 1
    for rx in (IN, ANY):
        m = rx.match(cond)
        if m and m.group(2) in KEY_COLUMNS and (m.group(1) is None or m.group(1) in own):
            items = [x for x in sql_lexer.split_top(m.group(3), ",") if x]
            if items and all(LIT_ONLY.match(x) for x in items):
                return len(items)
    return None


def _and_bound(expr: str, own: set[str]) -> int | None:
    bounds = [b for b in (_key_bound(p, own) for p in sql_lexer.split_top(expr, " and ")) if b]
    return min(bounds) if bounds else None


def _where_bound(stmt_tail: str, own: set[str]) -> int | None:
    # Only the statement's OWN where counts: one inside a SET subquery or a
    # FROM (subquery) bounds that subquery, not the rows being written.
    at = sql_lexer.find_top(stmt_tail, "where")
    if at < 0:  # explicit: slicing from -1 would read junk that only happens to fail the match
        return None
    where = _CLAUSE_END.split(stmt_tail[at + len("where"):])[0].strip()
    # A top-level OR is bounded only if EVERY branch is, and then by their sum:
    # `id = 'a' or id = 'b'` is 2 rows; `id = 'a' or b = 1` is unbounded.
    branches = [_and_bound(b, own) for b in sql_lexer.split_top(where, " or ")]
    return sum(branches) if all(branches) else None


def _clause(stmt: str, start: int) -> str:
    """Text of the DML clause starting at `start`, cut at the enclosing paren."""
    depth = 0
    for i in range(start, len(stmt)):
        if stmt[i] == "(":
            depth += 1
        elif stmt[i] == ")":
            depth -= 1
            if depth < 0:
                return stmt[start:i]
    return stmt[start:]


def _target(clause: str) -> str:
    m = re.match(r"\w+\s+(?:only\s+)?(?:from\s+|into\s+)?([\w.]+)", clause)
    return m.group(1) if m else "?"


_NOT_ALIAS = {"set", "where", "using", "from", "returning", "as"}


def _own_names(clause: str) -> set[str]:
    """The write target's names a qualifier may use: schema.table, table, alias."""
    m = re.match(r"\w+\s+(?:only\s+)?(?:from\s+)?([\w.]+)(?:\s+(?:as\s+)?(\w+))?", clause)
    if not m:
        return set()
    names = {m.group(1), m.group(1).rsplit(".", 1)[-1]}
    if m.group(2) and m.group(2) not in _NOT_ALIAS:
        names.add(m.group(2))
    return names


# VALUES counts only when it IS the row source: right after the target and its
# column list. A `values` inside a SELECT's join is a table, not the inserted rows.
_INSERT_HEAD = re.compile(r"^insert\s+into\s+[\w.]+(?:\s+as\s+\w+)?\s*(?:\([^()]*\))?\s*"
                          r"(?:overriding\s+\w+\s+value\s+)?")


def _insert_rows(clause: str) -> int | None:
    head = _INSERT_HEAD.match(clause)
    if not head:
        return None
    src = clause[head.end():]
    if src.startswith("default values"):
        return 1
    if src.startswith("values"):
        body = re.split(r"\b(on conflict|returning)\b", src[len("values"):])[0]
        tuples = [t for t in sql_lexer.split_top(body.strip(), ",") if t.startswith("(")]
        return len(tuples) or None
    # INSERT ... SELECT: bounded only by the SELECT's own top-level LIMIT.
    at = sql_lexer.find_top(src, "limit")
    # The number must stand alone: `limit 5 + 1000` is 1005.
    lim = (re.match(r"limit\s+(\d+)\s*(?:$|offset\b|on\s+conflict\b|returning\b|for\b)", src[at:])
           if at >= 0 else None)
    return int(lim.group(1)) if lim else None


def findings(sql: str) -> list[str]:
    """One line per write that is not provably <= MAX_ROWS."""
    out: list[str] = []
    for st in sql_lexer.statements(sql):
        for m in DML.finditer(st):
            verb = m.group(1)
            before = st[:m.start()].split()
            if before and before[-1] in _NOT_DML_BEFORE:
                continue
            if verb == "copy" and (re.match(r"copy\s*\(", st[m.start():])
                                   or not re.search(r"\bfrom\b", st[m.start():])):
                continue  # COPY (query) TO / COPY t TO is a read
            clause = _clause(st, m.start())
            tgt = _target(clause)
            if verb in ("truncate", "merge", "copy"):
                out.append(f"{verb.upper()} {tgt} (never bounded)")
                continue
            n = _insert_rows(clause) if verb == "insert" else _where_bound(clause, _own_names(clause))
            if n is None:
                why = ("row count not readable (INSERT ... SELECT needs LIMIT <= 5)"
                       if verb == "insert" else
                       "no WHERE on an id key (= literal or IN (literals)), or a top-level OR")
                out.append(f"{verb.upper()} {tgt}: {why}")
            elif n > MAX_ROWS:
                out.append(f"{verb.upper()} {tgt}: {n} rows > {MAX_ROWS}")
    return out


REASON_TAIL = (
    "\n\nWrites over 5 rows of a production table go through a data-changes/ package PR "
    "(CLAUDE.md §4, LC-1683; format in data-changes/README.md): lint, a production dry-run "
    "whose counts land on the PR, CI apply with the data_change_runs ledger, and a "
    "rollback.sql.\nIf you believe it is 5 rows or fewer: run SELECT id ... with the same "
    "predicate, then rewrite the write as `WHERE id IN ('<id1>', ...)` with those ids. "
    f"Accepted keys: {', '.join(sorted(KEY_COLUMNS))}. The guard cannot count rows (a hook "
    "has no database access, LC-1017); it accepts only a write whose text bounds it.")


def evaluate(tool_name: str, tool_input: dict) -> tuple[str, str] | None:
    low = (tool_name or "").lower()
    if not (low.startswith("mcp__") and "supabase" in low and low.endswith("__execute_sql")):
        return None
    query = tool_input.get("query") or ""
    if not isinstance(query, str):
        # Fail closed on shape: a query we cannot read as text cannot be proven small.
        return "deny", ("[mod:bulk-write-guard] REFUSED: the query is not a string, so the guard "
                        "cannot read it. Send the SQL as plain text." + REASON_TAIL)
    hits = findings(query)
    if not hits:
        return None
    return "deny", ("[mod:bulk-write-guard] REFUSED: this write is not provably 5 rows or "
                    "fewer — " + "; ".join(hits) + "." + REASON_TAIL)


def emit(decision: str, reason: str) -> None:
    json.dump({"hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": decision,
        "permissionDecisionReason": reason,
    }}, sys.stdout)
    sys.stdout.write("\n")


def _selftest() -> int:
    checks = fails = 0

    def ck(cond: bool, label: str) -> None:
        nonlocal checks, fails
        checks += 1
        if not cond:
            fails += 1
            sys.stderr.write(f"  FAIL: {label}\n")

    SQL = "mcp__Supabase__execute_sql"

    def d(q: str) -> str | None:
        r = evaluate(SQL, {"query": q})
        return r[0] if r else None

    allowed = (
        "select * from products where price > 100",
        "select * from refresh_runs for update",
        "select * from t for no key update",
        "update knowledge_memories set superseded_by = 'b' where id = 'a'",
        "UPDATE products SET price = 10 WHERE id IN ('a','b','c','d','e')",
        "update products p set price = 1 where p.id = 'x'::uuid and price > 0",
        "update t set a = 1 where 'x' = id",
        "delete from link_redirects where id = any(array['a','b'])",
        "update products set x = 1 where webflow_id = 'w1' returning id",
        "insert into knowledge_memories(content) values ('a')",
        "insert into t(a) values (1),(2),(3),(4),(5)",
        "insert into t(a) values (1) on conflict (a) do update set a = excluded.a",
        "insert into t(a) select a from s limit 3",
        "insert into t default values",
        "copy (select 1) to stdout",
        "select update_price('a', 10)",
        "select * from t where note = 'delete from x'",
        "with u as (update t set a = 1 where id = 'x' returning *) select * from u",
        "update t set a = 1 where id = $1",
        "update t set a = (select x from y where y.k = t.k) where id = 'q'",
        "with i as (insert into t select a from s limit 2) select * from i",
        "insert into t(a) select a from s limit 3 on conflict do nothing",
        "insert into t(a) select a from s limit 3 offset 0",
        "update t set a=1 where id = 'a' or id = 'b'",
        "update products p set x = 1 from brands b where p.id = 'a' and p.brand_id = b.id",
        "update public.products set x = 1 where products.id = 'a'",
        "delete from products as p using brands b where p.id = 'a'",
        "insert into t(a) values (E'it\\'s')",
        "insert into t as x (a) values (1)", "update t set a=1 where t.id = 'x'",
        "update public.t set a=1 where t.id = 'x'", "update t set a=1 where t.id in ('a','b')", "copy t to stdout", "copy (select 1) to stdout",
    )
    for q in allowed:
        ck(d(q) is None, f"allowed: {q[:60]}")

    denied = (
        "update products set price = 1",
        "update products set price = 1 where brand_id = 'b'",
        "update refresh_runs set status = 'done' where slug = 'x'",
        "update t set a = 1 where id in ('a','b','c','d','e','f')",
        "update t set a = 1 where id in (select id from s)",
        "delete from t where created_at < now()",
        "delete from t",
        "insert into t(a) values (1),(2),(3),(4),(5),(6)",
        "insert into t(a) select a from s",
        "insert into t(a) select a from s limit 50",
        "truncate t",
        "merge into t using s on t.id = s.id when matched then update set a = 1",
        "copy t from stdin",
        "with u as (update t set a = 1 returning *) select * from u",
        "select 1; delete from t where a = 1",
        "update t set a = 1 where id = 'a' and (b = 1 or c = 2) or d = 3",
        "update t set a = (select x from y where id = 'z')",
        "update t set a = 1 from (select id from s where id = 'x') s",
        "delete from t using (select id from s where id = 'x') s",
        "update products set x = 1 from brands b where b.id = 'abc'",
        "delete from products using brands b where b.id = 'abc'",
        "update t set a=1 where id in ('a','b') and true or(true)",
        "update t set a=1 where id='a' and b=1 or(c=2)",
        "insert into t(a) values (E'it\\'s'); delete from t",
        "insert into t(a) select s.a from s join (values (1),(2)) v(x) on true",
        "insert into t(a) select a from s, (values (1)) v",
        "insert into t(a) (select a from s limit 2)",
        "update t set a=1 where id = 'a' or id = 'b' or id = 'c' or id in ('d','e','f')",
        "update t set a = 1 where id = any($1)",
        "update products set x = 1 from brands b where b.id in ('a')",
        'copy "My Table" from stdin', "insert into t(a) select a from s limit 5 + 1000",
    )
    for q in denied:
        ck(d(q) == "deny", f"denied: {q[:60]}")

    r = evaluate(SQL, {"query": "update t set a = 1 where id in ('1','2','3','4','5','6')"})
    ck("6 rows > 5" in r[1], "reason names the row count")
    ck("data-changes/" in r[1] and "WHERE id IN" in r[1], "reason gives both ways forward")
    ck("[mod:bulk-write-guard]" in r[1], "reason carries the mod callout")
    ck(evaluate("mcp__Supabase__apply_migration", {"query": "delete from t"}) is None,
       "apply_migration is prod-deploy-guard's job, not this one")
    ck(evaluate("Bash", {"command": "psql -c 'delete from t'"}) is None, "Bash untouched")
    ck(evaluate(SQL, {}) is None, "missing query does not crash")
    ck(evaluate(SQL, {"query": {"raw": "delete from t"}})[0] == "deny", "non-string query fails closed")
    ck(_own_names("update t set a = 1") == {"t"}, "SET is not an alias")
    ck(_own_names("update public.t p set a = 1") == {"public.t", "t", "p"}, "schema, table and alias")
    ck(_own_names("?") == set(), "unreadable target -> no names")
    ck(d("insert into (select 1)") == "deny", "an INSERT whose target cannot be read is denied")
    # A WHERE outside the CTE must not be credited to the UPDATE inside it.
    ck(d("with u as (update t set a = 1 returning *) select * from u where id = 'x'") == "deny",
       "a WHERE after a CTE does not bound the UPDATE inside it")
    r = evaluate(SQL, {"query": "truncate products"})
    ck("never bounded" in r[1], "TRUNCATE reason says it is never bounded")
    r = evaluate(SQL, {"query": "insert into t select * from s"})
    ck("LIMIT <= 5" in r[1], "INSERT ... SELECT reason says how to bound it")
    r = evaluate(SQL, {"query": "delete from t where a = 1"})
    ck("id key" in r[1], "UPDATE/DELETE reason says an id key is needed")

    # main(): the stdin -> JSON contract Claude Code actually calls.
    import subprocess
    def run(stdin: str) -> tuple[int, str, str]:
        r = subprocess.run([sys.executable, os.path.abspath(__file__)], input=stdin,
                           capture_output=True, text=True)
        return r.returncode, r.stdout, r.stderr
    rc, out, _ = run(json.dumps({'tool_name': 'mcp__Supabase__execute_sql', 'tool_input': {'query': 'delete from t'}}))
    ck(rc == 0 and json.loads(out)["hookSpecificOutput"]["permissionDecision"] == "deny",
       "main(): a bad call emits a deny")
    rc, out, _ = run(json.dumps({'tool_name': 'mcp__Supabase__execute_sql', 'tool_input': {'query': 'select 1'}}))
    ck(rc == 0 and out == "", "main(): a fine call emits nothing")
    rc, out, err = run("{not json")
    ck(rc == 1 and out == "" and "allowing" in err, "main(): junk input fails open and visible")
    rc, out, _ = run(json.dumps({"tool_name": 'mcp__Supabase__execute_sql', "tool_input": "str"}))
    ck(rc == 0 and out == "", "main(): a non-dict tool_input is treated as empty")
    rc, out, _ = run("")
    ck(rc == 0 and out == "", "main(): empty stdin is silent")

    print(f"bulk-write-guard selftest: {checks - fails}/{checks} checks passed")
    return 1 if fails else 0


def main() -> int:
    if "--selftest" in sys.argv:
        return _selftest()
    raw = sys.stdin.read()
    try:
        payload = json.loads(raw) if raw.strip() else {}
        tool_input = payload.get("tool_input") or {}
        if not isinstance(tool_input, dict):
            tool_input = {}
        verdict = evaluate(payload.get("tool_name") or "", tool_input)
    except Exception as e:  # noqa: BLE001
        # Fail OPEN and visible, like the sibling guards.
        sys.stderr.write(f"bulk-write-guard: could not evaluate ({e}); allowing the call. "
                         "The guard is not protecting this one.\n")
        return 1
    if verdict:
        emit(*verdict)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
