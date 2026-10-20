#!/usr/bin/env python3
"""PreToolUse guard — a recurring ticket is not closed until its successor exists (LCH-528).

WHAT IT DOES. On `transitionJiraIssue`, reads this session's transcript and DENIES
the call when all three hold:

  1. the ticket is RECURRING: its getJiraIssue result (which jira-write-needs-read
     already forces the session to fetch) carries the `recurring` label or a
     "next due" line;
  2. the transition goes to a DONE-category status, per this session's
     getTransitionsForJiraIssue result for that ticket;
  3. nothing this session scheduled the next occurrence: no createJiraIssue, and no
     scheduled task (create_trigger, send_later, CronCreate).

WHY. Stan's preference: "recurring work gets its successor scheduled before it's
closed". Closing a recurring ticket without one is how a monthly check silently
stops happening; nobody notices an absence.

WHAT IT CANNOT KNOW, STATED PLAINLY. A hook has no Jira client (LC-1017). If the
session never read the ticket or its transitions, the guard cannot tell recurring
or Done and it passes. jira-write-needs-read makes the ticket read mandatory, so
in practice (1) is known; (2) is known whenever the transition id came from a
getTransitions call, which is the only way a session learns it.

Self-test: python3 recurring-successor-guard.py --selftest
"""
from __future__ import annotations

import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import transcript_reader as tr  # noqa: E402

RECURRING = re.compile(r'"recurring"|\bnext[\s_-]+due\b', re.IGNORECASE)
SUCCESSOR_TOOLS = ("createjiraissue", "create_trigger", "send_later", "croncreate")


def _json(text: str):
    try:
        return json.loads(text)
    except (ValueError, TypeError):
        return None


def _results(rows: list[dict], tool_suffix: str, key: str) -> list[str]:
    return [text for name, inp, text in tr.tool_calls_with_results(rows)
            if name.endswith(tool_suffix) and str(inp.get("issueIdOrKey", "")).upper() == key]


def _issue_text(rows: list[dict], key: str) -> str | None:
    """Concatenated getJiraIssue results for this key, or None if never read."""
    texts = _results(rows, "__getJiraIssue", key)
    return "\n".join(texts) if texts else None


def _done_ids(rows: list[dict], key: str) -> set[str] | None:
    """Transition ids that land in a done-category status, or None if never read."""
    found: set[str] | None = None
    for text in _results(rows, "__getTransitionsForJiraIssue", key):
        data = _json(text)
        if not isinstance(data, dict):
            continue
        found = found or set()
        for t in data.get("transitions") or []:
            cat = (((t or {}).get("to") or {}).get("statusCategory") or {}).get("key")
            if cat == "done":
                found.add(str(t.get("id")))
    return found


def evaluate(tool_name: str, tool_input: dict, rows: list[dict]) -> tuple[str, str] | None:
    if not (tool_name or "").endswith("__transitionJiraIssue"):
        return None
    key = str(tool_input.get("issueIdOrKey") or "").upper()
    tid = str((tool_input.get("transition") or {}).get("id") or "")
    issue = _issue_text(rows, key)
    if not key or issue is None or not RECURRING.search(issue):
        return None
    done = _done_ids(rows, key)
    if done is None or tid not in done:
        return None
    # The successor must name this ticket ("Successor of LC-5", "Refs LC-5"), so an
    # unrelated ticket created in the same session does not count.
    if any(any(s in name.lower() for s in SUCCESSOR_TOOLS) and re.search(rf"\b{re.escape(key)}\b", json.dumps(inp).upper())
           for name, inp, _ in tr.tool_uses(rows)):
        return None
    return "deny", (
        f"[mod:recurring-successor-guard] REFUSED: {key} is recurring (label `recurring` or a "
        "'next due' line) and this transition closes it, but nothing this session scheduled the "
        "next occurrence. Stan's rule: recurring work gets its successor before it is closed. "
        f"Create the successor ticket (createJiraIssue, with its next-due date and `Successor of "
        f"{key}` in the description) or a scheduled task (create_trigger / send_later) whose "
        f"prompt names {key}, then transition.")


def _selftest() -> int:
    checks = fails = 0

    def ck(cond: bool, label: str) -> None:
        nonlocal checks, fails
        checks += 1
        if not cond:
            fails += 1
            sys.stderr.write(f"  FAIL: {label}\n")

    TRANS = json.dumps({"transitions": [
        {"id": "31", "to": {"statusCategory": {"key": "indeterminate"}}},
        {"id": "41", "to": {"statusCategory": {"key": "done"}}}]})

    def rows(issue_body: str | None, transitions: bool = True, extra: tuple = (),
             key: str = "LC-5") -> list[dict]:
        out: list[dict] = []
        calls = []
        if issue_body is not None:
            calls.append(("mcp__Atlassian__getJiraIssue", {"issueIdOrKey": key}, issue_body))
        if transitions:
            calls.append(("mcp__Atlassian__getTransitionsForJiraIssue", {"issueIdOrKey": key},
                          [{"type": "text", "text": TRANS}]))
        calls.extend(extra)
        for i, (name, inp, res) in enumerate(calls):
            out.append({"type": "assistant", "message": {"content": [
                {"type": "tool_use", "id": f"t{i}", "name": name, "input": inp}]}})
            out.append({"type": "user", "message": {"content": [
                {"type": "tool_result", "tool_use_id": f"t{i}", "content": res}]}})
        return out

    T = "mcp__Atlassian__transitionJiraIssue"
    close = {"issueIdOrKey": "lc-5", "transition": {"id": "41"}}
    REC = '{"key":"LC-5","fields":{"labels":["recurring","ops"]}}'
    NEXT = '{"key":"LC-5","fields":{"description":"Monthly. Next due: 2026-11-20"}}'

    def v(*a, **k):
        r = evaluate(*a, **k)
        return r[0] if r else None

    ck(v(T, close, rows(REC)) == "deny", "recurring label + done transition + no successor -> deny")
    ck(v(T, close, rows(NEXT)) == "deny", "'Next due' line counts as recurring")
    ck(v(T, close, rows('{"fields":{"labels":["recurringly"]}}')) is None,
       "a label merely containing the word is not 'recurring'")
    ck(v(T, close, rows('{"fields":{"labels":["ops"]}}')) is None, "non-recurring ticket passes")
    ck(v(T, {"issueIdOrKey": "LC-5", "transition": {"id": "31"}}, rows(REC)) is None,
       "a non-done transition passes")
    ck(v(T, close, rows(REC, transitions=False)) is None, "transitions never read -> cannot know -> pass")
    ck(v(T, close, rows(None)) is None, "ticket never read -> pass (jira-write-needs-read owns that)")
    ck(v(T, close, rows(REC, key="LC-6")) is None, "another ticket's data is not this ticket's")
    for succ in ("mcp__Atlassian__createJiraIssue", "mcp__claude-code-remote__create_trigger",
                 "mcp__claude-code-remote__send_later", "CronCreate"):
        ck(v(T, close, rows(REC, extra=((succ, {"description": "Successor of LC-5"}, "ok"),))) is None,
           f"successor via {succ} naming the ticket -> pass")
        ck(v(T, close, rows(REC, extra=((succ, {"description": "unrelated LC-50"}, "ok"),))) == "deny",
           f"{succ} not naming this ticket is not its successor")
    ck(v(T, close, rows(REC, extra=(("mcp__Atlassian__addCommentToJiraIssue", {}, "ok"),))) == "deny",
       "a comment is not a successor")
    ck(v("mcp__Atlassian__editJiraIssue", close, rows(REC)) is None, "other Jira tools untouched")
    ck(v(T, {}, rows(REC)) is None, "missing input does not crash")
    junk = rows(REC)
    junk[-1]["message"]["content"][0]["content"] = "not json"
    ck(v(T, close, junk) is None, "unparseable transitions -> pass")
    r = evaluate(T, close, rows(REC))
    ck("LC-5" in r[1] and "[mod:recurring-successor-guard]" in r[1], "reason names ticket and mod")

    import subprocess
    import tempfile
    fh = tempfile.NamedTemporaryFile("w", suffix=".jsonl", delete=False)
    fh.write("\n".join(json.dumps(x) for x in rows(REC)))
    fh.close()
    try:
        r = subprocess.run([sys.executable, os.path.abspath(__file__)], capture_output=True, text=True,
                           input=json.dumps({"tool_name": T, "tool_input": close,
                                             "transcript_path": fh.name}))
        ck(r.returncode == 0 and json.loads(r.stdout)["hookSpecificOutput"]["permissionDecision"]
           == "deny", "main(): emits deny")
    finally:
        os.unlink(fh.name)
    r = subprocess.run([sys.executable, os.path.abspath(__file__)], capture_output=True, text=True,
                       input=json.dumps({"tool_name": T, "tool_input": close, "transcript_rows": rows(REC)}))
    ck(r.returncode == 0 and json.loads(r.stdout)["hookSpecificOutput"]["permissionDecision"]
       == "deny", "main(): inline transcript_rows (the mod's record) are read")
    r = subprocess.run([sys.executable, os.path.abspath(__file__)], input="{x",
                       capture_output=True, text=True)
    ck(r.returncode == 1 and r.stdout == "", "main(): junk input fails open and visible")

    print(f"recurring-successor-guard selftest: {checks - fails}/{checks} checks passed")
    return 1 if fails else 0


def main() -> int:
    if "--selftest" in sys.argv:
        return _selftest()
    try:
        raw = sys.stdin.read()
        payload = json.loads(raw) if raw.strip() else {}
        tool_input = payload.get("tool_input") or {}
        verdict = evaluate(payload.get("tool_name") or "",
                           tool_input if isinstance(tool_input, dict) else {},
                           tr.rows_for(payload))
    except Exception as e:  # noqa: BLE001
        sys.stderr.write(f"recurring-successor-guard: could not evaluate ({e}); allowing the "
                         "call. The guard is not protecting this one.\n")
        return 1
    if verdict:
        json.dump({"hookSpecificOutput": {"hookEventName": "PreToolUse",
                                          "permissionDecision": verdict[0],
                                          "permissionDecisionReason": verdict[1]}}, sys.stdout)
        sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
