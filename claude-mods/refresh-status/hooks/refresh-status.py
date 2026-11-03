#!/usr/bin/env python3
"""UserPromptSubmit check: "refresh status" -> the Overseer's tables, verbatim (LC-2020).

WHAT IT DOES. When the prompt starts with "refresh status" (any case), the mod reads
public.v_refresh_status (the latest per-stage table the Refresh Overseer wrote for every run it
is monitoring) and this script turns the rows into the context the model must show verbatim.

TWO CALLS, ONE SCRIPT (stdlib only; the .ts file only moves bytes and does the Supabase read):
  1. {"prompt": "..."}                    -> no match: no output.  Match: {"match": true, "sql": "<select>"}
  2. {"prompt": "...", "rows": [...]}     -> hookSpecificOutput.additionalContext with every table
     {"prompt": "...", "error": "why"}    -> NOT CHECKED context (never a table)

Rules: no rows -> "No refresh is being monitored."; a failed read -> NOT CHECKED with the reason;
a row without a Markdown table is never rendered or invented. Everything is prefixed [mod:refresh-status].

Self-test: python3 refresh-status.py --selftest
"""
from __future__ import annotations

import json
import re
import sys

MATCH = re.compile(r"^\s*refresh status\b", re.IGNORECASE)
TAG = "[mod:refresh-status]"
SQL = ("select run_id, article_slug, run_status, tick_at, stale, status_table_md "
       "from public.v_refresh_status order by tick_at desc")
SHOW = "Show these tables to the operator verbatim, then answer."


def matches(prompt: object) -> bool:
    return isinstance(prompt, str) and bool(MATCH.match(prompt))


def context_for(rows: object = None, error: object = None) -> str:
    if error:
        return (f"{TAG} NOT CHECKED: could not read v_refresh_status ({str(error)[:160]}). Tell the operator the "
                "refresh status was not checked and why. Do not invent or recall a table.")
    if not isinstance(rows, list):
        return f"{TAG} NOT CHECKED: the read returned no row list. Do not invent a table."
    blocks, unreadable = [], 0
    for r in rows:
        md = r.get("status_table_md") if isinstance(r, dict) else None
        if not isinstance(md, str) or not md.strip():
            unreadable += 1
            continue
        stale = ""
        if r.get("stale") is True:
            stale = f"**STALE: the Overseer has not checked this refresh since {r.get('tick_at') or 'an unknown time'}.**\n\n"
        blocks.append(stale + md.strip())
    if not blocks and unreadable:
        return f"{TAG} NOT CHECKED: {unreadable} monitored run(s) have no readable table. Do not invent one."
    if not blocks:
        return f"{TAG} No refresh is being monitored."
    note = f"\n\n({unreadable} other monitored run(s) had no readable table: NOT CHECKED.)" if unreadable else ""
    return f"{TAG} {SHOW}\n\n" + "\n\n---\n\n".join(blocks) + note


def evaluate(payload: dict) -> dict | None:
    if not matches(payload.get("prompt")):
        return None
    if "rows" not in payload and "error" not in payload:
        return {"match": True, "sql": SQL}
    return {"hookSpecificOutput": {"hookEventName": "UserPromptSubmit",
                                   "additionalContext": context_for(payload.get("rows"), payload.get("error"))}}


def _selftest() -> int:
    checks = fails = 0

    def ck(cond: bool, label: str) -> None:
        nonlocal checks, fails
        checks += 1
        if not cond:
            fails += 1
            sys.stderr.write(f"  FAIL: {label}\n")

    for p in ("refresh status", "Refresh Status", "  REFRESH STATUS please", "refresh status\nfor sofa", "refresh status?"):
        ck(matches(p), f"matches {p!r}")
    for p in ("what is the refresh status", "refresh statuses", "please refresh status", "refreshstatus", "", None, 5):
        ck(not matches(p), f"no match {p!r}")
    ck(evaluate({"prompt": "hello"}) is None, "no match: silent")
    ck(evaluate({}) is None, "empty payload: silent")
    first = evaluate({"prompt": "refresh status"})
    ck(first == {"match": True, "sql": SQL} and "v_refresh_status" in SQL, "match, no rows yet: asks for the select")
    one = {"run_id": "r1", "tick_at": "2026-11-02T19:57:00+00:00", "stale": False, "status_table_md": "| Stage |\n| 1 |"}
    c = evaluate({"prompt": "refresh status", "rows": [one]})["hookSpecificOutput"]
    ck(c["hookEventName"] == "UserPromptSubmit" and c["additionalContext"].startswith(TAG), "context is tagged")
    ck(SHOW in c["additionalContext"] and "| Stage |\n| 1 |" in c["additionalContext"], "verbatim instruction + the table")
    ck("STALE" not in c["additionalContext"], "fresh row: no STALE line")
    two = dict(one, run_id="r2", stale=True, status_table_md="| Stage |\n| 2 |")
    t = context_for([one, two])
    ck("| 1 |" in t and "| 2 |" in t and t.count("---") == 1, "every run's table, separated")
    ck("STALE: the Overseer has not checked this refresh since 2026-11-02T19:57:00+00:00" in t, "stale row flagged with the tick time")
    ck(context_for([]) == f"{TAG} No refresh is being monitored.", "no rows: says so")
    ck("NOT CHECKED" in context_for(None, "HTTP 500") and "HTTP 500" in context_for(None, "HTTP 500"), "failed read: NOT CHECKED with reason")
    ck("| 1 |" not in context_for(None, "x"), "failed read: no table")
    ck("returned no row list" in context_for("junk"), "non-list rows: NOT CHECKED, named as such")
    ck("NOT CHECKED" in context_for([{"run_id": "r", "status_table_md": None}]) and "No refresh" not in context_for([{"status_table_md": ""}]),
       "a row with no table is NOT CHECKED, never 'not monitored'")
    mixed = context_for([one, {"status_table_md": None}, "junk"])
    ck("| 1 |" in mixed and "2 other monitored run(s) had no readable table" in mixed, "mixed: shows the good, names the unreadable")
    ck(len(context_for(None, "x" * 900)) < 400, "reason is capped")

    import os
    import subprocess
    run = lambda s: subprocess.run([sys.executable, "-I", os.path.abspath(__file__)], input=s, capture_output=True, text=True)  # noqa: E731
    p = run(json.dumps({"prompt": "refresh status"}))
    ck(p.returncode == 0 and json.loads(p.stdout)["match"] is True, "main(): match asks for rows")
    p = run(json.dumps({"prompt": "refresh status", "rows": [one]}))
    ck(p.returncode == 0 and "| 1 |" in json.loads(p.stdout)["hookSpecificOutput"]["additionalContext"], "main(): rows render")
    p = run(json.dumps({"prompt": "nothing"}))
    ck(p.returncode == 0 and p.stdout == "", "main(): no match prints nothing")
    p = run("{x")
    ck(p.returncode == 1 and p.stdout == "", "main(): junk fails open and visible")

    print(f"refresh-status selftest: {checks - fails}/{checks} checks passed")
    return 1 if fails else 0


def main() -> int:
    if "--selftest" in sys.argv:
        return _selftest()
    try:
        raw = sys.stdin.read()
        payload = json.loads(raw) if raw.strip() else {}
        out = evaluate(payload if isinstance(payload, dict) else {})
    except Exception as e:  # noqa: BLE001
        sys.stderr.write(f"refresh-status: could not evaluate ({e}).\n")
        return 1
    if out:
        print(json.dumps(out))
    return 0


if __name__ == "__main__":
    sys.exit(main())
