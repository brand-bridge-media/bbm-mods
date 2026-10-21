#!/usr/bin/env python3
"""Stop hook — every reply ends with the "Noted separately" line, and its keys are real (LCH-528).

WHAT IT DOES. When a turn ends, reads the final reply from the transcript and
blocks the stop ONCE (the model gets one more pass) when:

  * the last non-empty line is not `Noted separately: <KEY, KEY>` /
    `Noted separately: Nothing` / `Nothing`, or
  * a key in that line was never touched by an Atlassian tool call this session
    (not created, read, commented or transitioned) — a footer naming a ticket
    nobody filed is worse than no footer, because the operator trusts it.

WHY. The operator's preference: adjacent findings go to Jira silently, and the last line of
every reply says which. As a preference it was followed when remembered. The second
check is the reason this is a hook and not a regex in a skill: only the transcript
knows whether the ticket exists.

WHY IT CANNOT LOOP. Claude Code sets `stop_hook_active` on the stop that follows a
block; this hook always passes then. Worst case is one extra model pass per turn.

Self-test: python3 reply-footer-check.py --selftest
"""
from __future__ import annotations

import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import transcript_reader as tr  # noqa: E402

KEY = r"[A-Z][A-Z0-9]+-\d+"
FOOTER = re.compile(rf"^(?:noted separately:\s*)?(nothing|{KEY}(?:\s*,\s*{KEY})*)\s*\.?$",
                    re.IGNORECASE)
_MARKUP = re.compile(r"[*_`>]")


def footer_keys(reply: str) -> list[str] | None:
    """Keys in the footer ([] for Nothing), or None when there is no footer."""
    lines = [ln for ln in (reply or "").splitlines() if ln.strip()]
    if not lines:
        return None
    last = _MARKUP.sub("", lines[-1]).strip()
    m = FOOTER.match(last)
    if not m:
        return None
    if not last.lower().startswith("noted separately") and m.group(1).lower() != "nothing":
        return None  # a bare "LC-12" line is a sentence, not the footer
    return [] if m.group(1).lower() == "nothing" else re.findall(KEY, m.group(1).upper())


def touched_keys(rows: list[dict]) -> set[str]:
    seen: set[str] = set()
    for name, inp, _ in tr.tool_uses(rows):
        if "atlassian" in name.lower():
            seen.update(re.findall(KEY, json.dumps(inp).upper()))  # `lc-77` touches LC-77
    for name, text in tr.tool_results_text(rows):
        if "atlassian" in name.lower() and "createjiraissue" in name.lower():
            seen.update(re.findall(KEY, text.upper()))
    return seen


def evaluate(payload: dict) -> str | None:
    """Block reason, or None to let the turn end."""
    if payload.get("stop_hook_active"):
        return None
    rows = tr.load(payload.get("transcript_path"))
    reply = tr.final_reply_text(rows)
    if not reply.strip():
        return None  # no prose this turn (tool-only or empty); nothing to footer
    keys = footer_keys(reply)
    if keys is None:
        return ("[mod:reply-footer-check] The reply's last line must be `Noted separately: "
                "<KEY, KEY>` or `Noted separately: Nothing` (operator preference: adjacent findings "
                "go to Jira silently, the footer says which). Re-send the reply with that line.")
    missing = [k for k in keys if k not in touched_keys(rows)]
    if missing:
        return (f"[mod:reply-footer-check] The footer names {', '.join(missing)}, but no Jira "
                "call this session created or touched it. File it (Purpose = Claude "
                "Observations) or drop it from the footer, then re-send the reply.")
    return None


def _selftest() -> int:
    import tempfile
    checks = fails = 0

    def ck(cond: bool, label: str) -> None:
        nonlocal checks, fails
        checks += 1
        if not cond:
            fails += 1
            sys.stderr.write(f"  FAIL: {label}\n")

    for txt, want in (("done\n\nNoted separately: Nothing", []),
                      ("done\nNothing", []), ("done\n`Noted separately: LC-12, LCH-3`", ["LC-12", "LCH-3"]),
                      ("done\n**Noted separately:** lc-1.", ["LC-1"]), ("x\nNoted separately: Nothing\n\n", []),
                      ("done", None), ("Noted separately: Nothing\nmore text", None),
                      ("see LC-12", None), ("x\nLC-12", None), ("", None),
                      ("x\nNoted separately: soon", None)):
        ck(footer_keys(txt) == want, f"footer_keys({txt!r}) == {want}")

    def transcript(reply: str, jira: list[tuple[str, dict, str]]) -> str:
        rows = [{"type": "user", "message": {"content": "go"}}]
        for i, (name, inp, result) in enumerate(jira):
            rows.append({"type": "assistant", "message": {"content": [
                {"type": "tool_use", "id": f"t{i}", "name": name, "input": inp}]}})
            rows.append({"type": "user", "message": {"content": [
                {"type": "tool_result", "tool_use_id": f"t{i}", "content": result}]}})
        rows.append({"type": "assistant", "message": {"content": [{"type": "text", "text": reply}]}})
        fh = tempfile.NamedTemporaryFile("w", suffix=".jsonl", delete=False)
        fh.write("\n".join(json.dumps(r) for r in rows))
        fh.close()
        return fh.name

    CREATE = "mcp__Atlassian__createJiraIssue"
    cases = (
        ("ok\nNoted separately: Nothing", [], None),
        ("ok", [], "must be"),
        ("ok\nNoted separately: LC-77", [(CREATE, {"projectKey": "LC"}, '{"key":"LC-77"}')], None),
        ("ok\nNoted separately: LC-77", [("mcp__Atlassian__addCommentToJiraIssue",
                                          {"issueIdOrKey": "LC-77"}, "ok")], None),
        ("ok\nNoted separately: LC-77", [], "LC-77"),
        ("ok\nNoted separately: LC-77", [("mcp__Atlassian__addCommentToJiraIssue",
                                          {"issueIdOrKey": "lc-77"}, "ok")], None),
        ("ok\nNoted separately: LC-77", [(CREATE, {}, '{"key":"lc-77"}')], None),
        ("ok\nNoted separately: LC-77", [("mcp__Supabase__execute_sql", {"q": "LC-77"}, "LC-77")],
         "LC-77"),
        ("ok\nNoted separately: LC-77", [("mcp__Atlassian__searchJiraIssuesUsingJql", {"jql": "x"},
                                          "LC-77")], "LC-77"),
    )
    for reply, jira, want in cases:
        p = transcript(reply, jira)
        try:
            r = evaluate({"transcript_path": p})
            ck((r is None) if want is None else (r is not None and want in r),
               f"evaluate({reply!r}, {[j[0][-20:] for j in jira]}) -> {want}")
            ck(evaluate({"transcript_path": p, "stop_hook_active": True}) is None,
               "stop_hook_active always passes (cannot loop)")
        finally:
            os.unlink(p)
    ck(evaluate({}) is None, "no transcript -> pass")
    ck("[mod:reply-footer-check]" in (evaluate({"transcript_path": transcript("x", [])}) or ""),
       "reason carries the mod callout")

    import subprocess
    p = transcript("no footer", [])
    try:
        r = subprocess.run([sys.executable, os.path.abspath(__file__)],
                           input=json.dumps({"transcript_path": p}), capture_output=True, text=True)
        ck(r.returncode == 0 and json.loads(r.stdout)["decision"] == "block",
           "main(): a missing footer emits decision=block")
    finally:
        os.unlink(p)
    r = subprocess.run([sys.executable, os.path.abspath(__file__)], input="{bad",
                       capture_output=True, text=True)
    ck(r.returncode == 1 and r.stdout == "", "main(): junk input fails open and visible")

    print(f"reply-footer-check selftest: {checks - fails}/{checks} checks passed")
    return 1 if fails else 0


def main() -> int:
    if "--selftest" in sys.argv:
        return _selftest()
    try:
        raw = sys.stdin.read()
        payload = json.loads(raw) if raw.strip() else {}
        reason = evaluate(payload if isinstance(payload, dict) else {})
    except Exception as e:  # noqa: BLE001
        sys.stderr.write(f"reply-footer-check: could not evaluate ({e}); letting the turn end.\n")
        return 1
    if reason:
        json.dump({"decision": "block", "reason": reason}, sys.stdout)
        sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
