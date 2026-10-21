#!/usr/bin/env python3
"""SessionStart + PostToolUse nudge — sessions are named by their ticket (LCH-528).

WHAT IT DOES.
  * SessionStart: injects the naming convention, so the first thing a session
    knows is to title itself `<TICKET> — <3-6 word summary>`.
  * PostToolUse on createJiraIssue: when a ticket is born mid-session, injects
    "if this session is still <PROJ>-TBD, rename it to <KEY> — ...".

WHY A NUDGE, NOT A BAND. A hook cannot read the session's current title (no MCP
client, LC-1017), so it cannot tell a misnamed session from a well-named one. It can
put the rule in front of the model at the two moments it matters: the start, and
the moment the ticket key first exists. Operator preference: an untracked session is named <PROJ>-TBD,
renamed once the ticket exists.

Self-test: python3 session-title-nudge.py --selftest
"""
from __future__ import annotations

import json
import re
import sys

KEY = re.compile(r'"key"\s*:\s*"([A-Z][A-Z0-9]+-\d+)"')

START = ("[mod:session-title-nudge] Name this session by its ticket: `<TICKET> — <3-6 word "
         "summary>` (LC / BBM / LCH / LCC; the ticket most of the work serves) via "
         "set_session_title. Untracked: `<PROJ>-TBD — …`, renamed once the ticket exists. "
         "No project: `NOJIRA — …`.")


def evaluate(payload: dict) -> tuple[str, str] | None:
    event = payload.get("hook_event_name") or ""
    if event == "SessionStart":
        return "SessionStart", START
    if event == "PostToolUse" and str(payload.get("tool_name") or "").endswith("__createJiraIssue"):
        resp = payload.get("tool_response")
        text = resp if isinstance(resp, str) else json.dumps(resp, default=str)
        m = KEY.search(text.replace('\\"', '"'))
        if m:
            return "PostToolUse", (
                f"[mod:session-title-nudge] {m.group(1)} now exists. If this session's title is "
                f"still `<PROJ>-TBD — …` and {m.group(1)} is the ticket most of the work serves, "
                f"rename it to `{m.group(1)} — <same summary>` with set_session_title.")
    return None


def _selftest() -> int:
    checks = fails = 0

    def ck(cond: bool, label: str) -> None:
        nonlocal checks, fails
        checks += 1
        if not cond:
            fails += 1
            sys.stderr.write(f"  FAIL: {label}\n")

    r = evaluate({"hook_event_name": "SessionStart"})
    ck(r and r[0] == "SessionStart" and "-TBD" in r[1], "SessionStart injects the convention")
    resp = {"issues": {"nodes": [{"key": "LCH-528", "fields": {}}]}}
    r = evaluate({"hook_event_name": "PostToolUse", "tool_name": "mcp__Atlassian__createJiraIssue",
                  "tool_response": resp})
    ck(r and "LCH-528 now exists" in r[1], "createJiraIssue result names the new key")
    r = evaluate({"hook_event_name": "PostToolUse", "tool_name": "mcp__Atlassian__createJiraIssue",
                  "tool_response": json.dumps(json.dumps(resp))})
    ck(r and "LCH-528" in r[1], "escaped string response is read")
    ck(evaluate({"hook_event_name": "PostToolUse", "tool_name": "mcp__Atlassian__createJiraIssue",
                 "tool_response": "error"}) is None, "no key in result -> silent")
    ck(evaluate({"hook_event_name": "PostToolUse", "tool_name": "mcp__Atlassian__getJiraIssue",
                 "tool_response": resp}) is None, "other Jira tools untouched")
    ck(evaluate({"hook_event_name": "Stop"}) is None and evaluate({}) is None, "other events silent")
    ck(evaluate({"hook_event_name": "PostToolUse", "tool_name": "mcp__Atlassian__createJiraIssue",
                 "tool_response": {"o": object()}}) is None, "unserialisable response tolerated")

    import os
    import subprocess
    run = lambda s: subprocess.run([sys.executable, os.path.abspath(__file__)], input=s,  # noqa: E731
                                   capture_output=True, text=True)
    p = run(json.dumps({"hook_event_name": "SessionStart"}))
    out = json.loads(p.stdout)["hookSpecificOutput"]
    ck(p.returncode == 0 and out["hookEventName"] == "SessionStart" and "TICKET" in out["additionalContext"],
       "main(): SessionStart emits additionalContext")
    p = run("{x")
    ck(p.returncode == 1 and p.stdout == "", "main(): junk fails open and visible")

    print(f"session-title-nudge selftest: {checks - fails}/{checks} checks passed")
    return 1 if fails else 0


def main() -> int:
    if "--selftest" in sys.argv:
        return _selftest()
    try:
        raw = sys.stdin.read()
        payload = json.loads(raw) if raw.strip() else {}
        r = evaluate(payload if isinstance(payload, dict) else {})
    except Exception as e:  # noqa: BLE001
        sys.stderr.write(f"session-title-nudge: could not evaluate ({e}).\n")
        return 1
    if r:
        json.dump({"hookSpecificOutput": {"hookEventName": r[0], "additionalContext": r[1]}},
                  sys.stdout)
        sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
