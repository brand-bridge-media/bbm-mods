#!/usr/bin/env python3
"""Doorbell for the cross-track request board (LC-2257).

WHAT IT DOES. The board (public.track_requests, migration 20261119142318) records a
question from one track to another, but a database row cannot wake a Claude session:
only another session's send_message can. So the board's functions return WHO to ring,
and this mod makes sure the session that holds that answer actually rings:

  * PostToolUse on execute_sql. When the result carries a doorbell, either a `ring`
    ({kind: session, session_id, message}, from ask_track / follow_up / rule_on_request)
    or a `ring_back` ({session_id, message}, from respond), it tells the session to send
    that message to that session now, then report it with mark_delivered. A `ring` of
    kind worker needs nothing (track_requests_tick starts the workflow). A
    `tell_operator` (follow_up past the response cap) is passed on as a NEEDS YOU.
  * Stop. Blocks the turn's end ONCE when this turn produced a session doorbell and no
    send_message to that session followed it. A ring nobody sends is the exact failure
    the board exists to remove (LC-1991: the desk answered, the asker never learned it).

WHY A MOD. The rule "message the other session after you ask" lived in a procedure doc
and was followed when remembered. Only the transcript knows whether the message went.

WHY IT CANNOT LOOP. Claude Code sets `stop_hook_active` on the stop after a block; this
hook always passes then. A session that cannot reach the other one (it ended) calls
mark_delivered(id, false, why) and the board's overdue clock takes over.

A RING STOPS AT THE PROJECT WALL (LC-2278, measured 2026-11-19). A Claude project thread
can wake sessions in its own project, or in no project, but every wake aimed at a session
in ANOTHER project (send_message, create_trigger, fire_trigger) returns "the requested
resource was not found". The address is not wrong and retrying never helps. So every note
says what to do then: record it with mark_delivered(id, false, CROSS_PROJECT_NOTE) and rely
on the other side's own scheduled board sweep, which is how desks and askers in other
projects find their work. The attempted send still satisfies the Stop check.

Fails open: unreadable input prints nothing and exits 1 (visible, never blocking).

Self-test: python3 track-doorbell.py --selftest
"""
from __future__ import annotations

import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import transcript_reader as tr  # noqa: E402

TAG = "[mod:track-doorbell]"
SQL_TOOL = re.compile(r"__execute_sql$")
SEND_TOOL = re.compile(r"(__send_message|^SendMessage)$")
# The board's doorbell objects are flat JSON (no nested braces), so one brace-to-brace
# match per object is exact. "ring" and "ring_back" are told apart by the key before it.
DOORBELL = re.compile(r'"(ring|ring_back)"\s*:\s*(\{[^{}]*\})')
TELL_OPERATOR = re.compile(r'"tell_operator"\s*:\s*"((?:[^"\\]|\\.)*)"')
REQUEST_NO = re.compile(r"request #(\d+)", re.IGNORECASE)
# LC-2278: the one agreed wording, so the board shows the same note for every cross-project ring.
# No apostrophe in it: it is pasted inside a single-quoted SQL literal.
CROSS_PROJECT_NOTE = "cross-project: send_message not found (platform limit); picked up by the other side on its board sweep"
CROSS_PROJECT_HINT = (
    "If the send fails with \"not found\", that session is in another Claude project: the platform blocks "
    "wakes across projects (LC-2278). Do not retry and do not re-register; run "
    "`select public.mark_delivered({rid}, false, '" + CROSS_PROJECT_NOTE + "');` and tell the user the other "
    "side picks it up on its own scheduled board sweep (a desk's claim clock is 30 minutes).")


def _text(resp) -> str:
    if isinstance(resp, str):
        text = resp
    else:
        try:
            text = json.dumps(resp, default=str)
        except (TypeError, ValueError):
            return ""
    # execute_sql results arrive JSON-in-a-string, sometimes escaped twice.
    for _ in range(3):
        if '\\"' not in text:
            break
        text = text.replace('\\"', '"')
    return text


def doorbells(resp) -> tuple[list[dict], list[str]]:
    """(session doorbells, operator notes) found in one execute_sql result.

    A session doorbell is {request_id, session_id, message, kind: ring|ring_back}.
    """
    text = _text(resp)
    found, seen = [], set()
    for kind, raw in DOORBELL.findall(text):
        try:
            obj = json.loads(raw)
        except ValueError:
            continue
        sid = obj.get("session_id")
        if not isinstance(sid, str) or not sid.strip():
            continue  # a worker desk: the tick starts its workflow, nobody rings
        msg = str(obj.get("message") or "")
        m = REQUEST_NO.search(msg)
        key = (sid, msg)
        if key in seen:
            continue
        seen.add(key)
        found.append({"kind": kind, "session_id": sid, "message": msg,
                      "request_id": m.group(1) if m else None})
    notes = [n.replace('\\n', ' ') for n in TELL_OPERATOR.findall(text)]
    return found, notes


def post_tool_note(payload: dict) -> str | None:
    if not SQL_TOOL.search(str(payload.get("tool_name") or "")):
        return None
    bells, notes = doorbells(payload.get("tool_response"))
    if not bells and not notes:
        return None
    lines = []
    for b in bells:
        rid = b["request_id"] or "<request id>"
        lines.append(
            f"{TAG} Ring now: send_message to session `{b['session_id']}` with this message: "
            f"\"{b['message']}\". Then run `select public.mark_delivered({rid}, true);` "
            f"(or `mark_delivered({rid}, false, '<why>')` if that session cannot be reached). "
            "The turn will not end until the message is sent. " + CROSS_PROJECT_HINT.format(rid=rid))
    for n in notes:
        lines.append(f"{TAG} {n} Open the reply with `NEEDS YOU:`.")
    return "\n".join(lines)


def _turn_rows(rows: list[dict]) -> list[dict]:
    last = max((i for i, r in enumerate(rows) if tr._is_prompt(r)), default=-1)
    return rows[last + 1:]


def unsent(rows: list[dict]) -> list[dict]:
    """Session doorbells raised this turn with no send_message to that session after them."""
    pending: dict[str, dict] = {}
    for name, inp, result in tr.tool_calls_with_results(_turn_rows(rows)):
        if SQL_TOOL.search(name):
            for b in doorbells(result)[0]:
                pending[b["session_id"]] = b
        elif SEND_TOOL.search(name):
            target = inp.get("session_id") or inp.get("to") or ""
            pending.pop(str(target), None)
    return list(pending.values())


def stop_reason(payload: dict) -> str | None:
    if payload.get("stop_hook_active"):
        return None
    missing = unsent(tr.rows_for(payload))
    if not missing:
        return None
    parts = [f"`{b['session_id']}` (request #{b['request_id'] or '?'})" for b in missing]
    return (f"{TAG} This turn rang the request board but never messaged {', '.join(parts)}. "
            "A row cannot wake a session: send_message the doorbell text to it now, then "
            "mark_delivered. If it cannot be reached, call mark_delivered(<id>, false, '<why>') "
            "and say so in the reply. " + CROSS_PROJECT_HINT.format(rid="<id>"))


def evaluate(payload: dict) -> tuple[str, str] | None:
    event = payload.get("hook_event_name") or ""
    if event == "PostToolUse":
        note = post_tool_note(payload)
        return ("context", note) if note else None
    if event == "Stop" or "stop_hook_active" in payload:
        reason = stop_reason(payload)
        return ("block", reason) if reason else None
    return None


# ---------------------------------------------------------------------------
def _selftest() -> int:
    checks = fails = 0

    def ck(cond, label: str) -> None:
        nonlocal checks, fails
        checks += 1
        if not cond:
            fails += 1
            sys.stderr.write(f"  FAIL: {label}\n")

    ask = [{"ask_track": {"request_id": 7, "status": "open", "ring": {
        "kind": "session", "session_id": "session_DESK",
        "message": "Cross-track request #7 for ci-speed (speed-review, turn 1): read it"}}}]
    worker = [{"ask_track": {"request_id": 8, "ring": {
        "kind": "worker", "workflow": "x.yml", "message": "No message needed"}}}]
    back = [{"respond": {"request_id": 7, "ring_back": {
        "session_id": "session_ASKER", "message": "Cross-track request #7 to ci-speed has response 1 of 3."}}}]
    paused = [{"follow_up": {"request_id": 7, "status": "paused",
                             "tell_operator": "Post a NEEDS YOU: cross-track request #7 reached its limit."}}]
    sql = "mcp__Supabase__execute_sql"

    # -- doorbells() on every shape the MCP returns ----------------------------
    b, n = doorbells(ask)
    ck(len(b) == 1 and b[0]["session_id"] == "session_DESK" and b[0]["request_id"] == "7"
       and b[0]["kind"] == "ring", "ask_track ring found with its request id")
    ck(doorbells(json.dumps(ask))[0] == b, "string result read")
    wrapped = ("Below is the result <untrusted-data>" + json.dumps(json.dumps(ask)) + "</untrusted-data>")
    ck(doorbells(wrapped)[0] == b, "escaped, wrapped result read")
    ck(doorbells(worker) == ([], []), "a worker ring needs no message")
    ck(doorbells(back)[0][0]["kind"] == "ring_back" and doorbells(back)[0][0]["session_id"] == "session_ASKER",
       "respond ring_back found")
    ck(doorbells(paused)[1] and "NEEDS YOU" in doorbells(paused)[1][0], "tell_operator found")
    ck(doorbells([{"ring": {"kind": "session", "session_id": ""}}]) == ([], []), "empty session id ignored")
    ck(doorbells("[]") == ([], []) and doorbells({"o": object()}) == ([], []), "nothing / unserialisable -> silent")
    ck(len(doorbells(ask + ask)[0]) == 1, "the same doorbell twice is one")

    # -- PostToolUse ------------------------------------------------------------
    r = evaluate({"hook_event_name": "PostToolUse", "tool_name": sql, "tool_response": ask})
    ck(r and r[0] == "context" and "session_DESK" in r[1] and "mark_delivered(7, true)" in r[1]
       and r[1].startswith(TAG), "ring -> send + mark_delivered instruction")
    ck(r and "another Claude project" in r[1] and "mark_delivered(7, false, '" + CROSS_PROJECT_NOTE + "')" in r[1],
       "ring note carries the cross-project fallback with this request's id (LC-2278)")
    ck("'" not in CROSS_PROJECT_NOTE, "the note is safe inside a single-quoted SQL literal (LC-2278)")
    r = evaluate({"hook_event_name": "PostToolUse", "tool_name": sql, "tool_response": paused})
    ck(r and "NEEDS YOU" in r[1], "pause -> NEEDS YOU note")
    ck(evaluate({"hook_event_name": "PostToolUse", "tool_name": "mcp__x__list_tables",
                 "tool_response": ask}) is None, "other tools untouched")
    ck(evaluate({"hook_event_name": "PostToolUse", "tool_name": sql, "tool_response": worker}) is None,
       "worker ring silent")

    # -- Stop ---------------------------------------------------------------------
    def a(i, name, inp):
        return {"type": "assistant", "message": {"content": [
            {"type": "tool_use", "id": i, "name": name, "input": inp}]}}

    def u(i, res):
        return {"type": "user", "message": {"content": [
            {"type": "tool_result", "tool_use_id": i, "content": json.dumps(res)}]}}

    prompt = {"type": "user", "message": {"content": "do the thing"}}
    send = "mcp__claude-code-remote__send_message"
    rang = [prompt, a("1", sql, {"query": "select ask_track(...)"}), u("1", ask)]
    r = evaluate({"hook_event_name": "Stop", "stop_hook_active": False, "transcript_rows": rang})
    ck(r and r[0] == "block" and "session_DESK" in r[1] and "#7" in r[1], "unsent ring blocks")
    ck(r and CROSS_PROJECT_NOTE in r[1], "block reason carries the cross-project fallback (LC-2278)")
    failed = rang + [a("2", send, {"session_id": "session_DESK", "message": "..."}),
                     u("2", "failed to send message: the requested resource was not found")]
    ck(evaluate({"hook_event_name": "Stop", "stop_hook_active": False, "transcript_rows": failed}) is None,
       "a send that failed across projects still counts as rung (LC-2278)")
    sent = rang + [a("2", send, {"session_id": "session_DESK", "message": "..."}), u("2", "ok")]
    ck(evaluate({"hook_event_name": "Stop", "stop_hook_active": False, "transcript_rows": sent}) is None,
       "sent ring passes")
    other = rang + [a("2", send, {"session_id": "session_OTHER", "message": "..."}), u("2", "ok")]
    ck(evaluate({"hook_event_name": "Stop", "stop_hook_active": False, "transcript_rows": other}),
       "a message to the wrong session still blocks")
    ck(evaluate({"hook_event_name": "Stop", "stop_hook_active": True, "transcript_rows": rang}) is None,
       "stop_hook_active always passes (cannot loop)")
    old = rang + [prompt]
    ck(evaluate({"hook_event_name": "Stop", "stop_hook_active": False, "transcript_rows": old}) is None,
       "a ring from an earlier turn is not this turn's")
    w = [prompt, a("1", sql, {}), u("1", worker)]
    ck(evaluate({"hook_event_name": "Stop", "stop_hook_active": False, "transcript_rows": w}) is None,
       "a worker ring never blocks")
    back_rows = [prompt, a("1", sql, {}), u("1", back),
                 a("2", "SendMessage", {"to": "session_ASKER", "message": "..."}), u("2", "ok")]
    ck(evaluate({"hook_event_name": "Stop", "stop_hook_active": False, "transcript_rows": back_rows}) is None,
       "ring_back sent via SendMessage passes")
    ck(evaluate({"hook_event_name": "Stop", "stop_hook_active": False}) is None, "no transcript -> pass")
    ck(evaluate({}) is None, "unknown event silent")

    # -- main() -------------------------------------------------------------------
    import subprocess
    run = lambda s: subprocess.run([sys.executable, os.path.abspath(__file__)], input=s,  # noqa: E731
                                   capture_output=True, text=True)
    p = run(json.dumps({"hook_event_name": "PostToolUse", "tool_name": sql, "tool_response": ask}))
    out = json.loads(p.stdout)["hookSpecificOutput"]
    ck(p.returncode == 0 and out["hookEventName"] == "PostToolUse" and TAG in out["additionalContext"],
       "main(): PostToolUse emits additionalContext")
    p = run(json.dumps({"hook_event_name": "Stop", "stop_hook_active": False, "transcript_rows": rang}))
    ck(p.returncode == 0 and json.loads(p.stdout)["decision"] == "block", "main(): Stop emits decision=block")
    p = run("{x")
    ck(p.returncode == 1 and p.stdout == "", "main(): junk fails open and visible")

    print(f"track-doorbell selftest: {checks - fails}/{checks} checks passed")
    return 1 if fails else 0


def main() -> int:
    if "--selftest" in sys.argv:
        return _selftest()
    try:
        raw = sys.stdin.read()
        payload = json.loads(raw) if raw.strip() else {}
        r = evaluate(payload if isinstance(payload, dict) else {})
    except Exception as e:  # noqa: BLE001
        sys.stderr.write(f"track-doorbell: could not evaluate ({e}).\n")
        return 1
    if r and r[0] == "context":
        json.dump({"hookSpecificOutput": {"hookEventName": "PostToolUse", "additionalContext": r[1]}}, sys.stdout)
        sys.stdout.write("\n")
    elif r and r[0] == "block":
        json.dump({"decision": "block", "reason": r[1]}, sys.stdout)
        sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
