#!/usr/bin/env python3
"""PreToolUse guard — no driving Stan's own browser or desktop (LCH-528).

WHAT IT DOES. DENIES the Skill tool for the browser/desktop-control skills
(chrome-browser, computer-use, built-in-browser) and any MCP tool from a
Chrome-extension or computer-use server.

WHY. Stan's hard rail: "No browser-as-me. Prefer MCP/API -> WebSearch/WebFetch ->
agent research." A session acting inside his logged-in browser acts with every
account he has open, and nothing in our audit trail records what it clicked.

NOT GATED. Headless Playwright from Bash (the container's own Chromium, no Stan
session), WebFetch, WebSearch: those are the sanctioned alternatives.

Self-test: python3 no-browser-as-me.py --selftest
"""
from __future__ import annotations

import json
import re
import sys

BLOCKED_SKILLS = re.compile(r"(?:^|:)(?:chrome-browser|computer-use|built-in-browser)$")
# Judged on the SERVER segment (mcp__<server>__tool), any casing or separator style:
# Claude_in_Chrome, claude-in-chrome, ClaudeInChrome, computer_use, ComputerUse.
_SERVER = re.compile(r"^mcp__(.+?)__")
_BLOCKED_SERVER = re.compile(r"chrome|computer[-_ ]?use", re.IGNORECASE)

REASON = ("[mod:no-browser-as-me] REFUSED: {what} drives Stan's own browser/desktop. Hard rail: "
          "no browser-as-me. Use, in order: an MCP/API tool, WebSearch/WebFetch, a research "
          "subagent, or headless Playwright in this container (it has no Stan session).")


def evaluate(tool_name: str, tool_input: dict) -> tuple[str, str] | None:
    name = tool_name or ""
    if name == "Skill":
        skill = str(tool_input.get("skill") or "").strip().lstrip("/")
        if BLOCKED_SKILLS.search(skill):
            return "deny", REASON.format(what=f"skill `{skill}`")
        return None
    m = _SERVER.match(name)
    if m and _BLOCKED_SERVER.search(m.group(1)):
        return "deny", REASON.format(what=f"`{name}`")
    return None


def _selftest() -> int:
    checks = fails = 0

    def ck(cond: bool, label: str) -> None:
        nonlocal checks, fails
        checks += 1
        if not cond:
            fails += 1
            sys.stderr.write(f"  FAIL: {label}\n")

    def d(tool, **inp):
        r = evaluate(tool, inp)
        return r[0] if r else None

    for s in ("anthropic-skills:chrome-browser", "anthropic-skills:computer-use",
              "anthropic-skills:built-in-browser", "/chrome-browser", "computer-use"):
        ck(d("Skill", skill=s) == "deny", f"skill {s} denied")
    for s in ("design-research", "anthropic-skills:deep-research", "run", "webflow-cms",
              "anthropic-skills:chrome-browser-notes"):
        ck(d("Skill", skill=s) is None, f"skill {s} allowed")
    for t in ("mcp__Claude_in_Chrome__navigate", "mcp__claude-in-chrome__click",
              "mcp__computer-use__screenshot", "mcp__computer_use__click", "mcp__chrome__open",
              "mcp__ClaudeInChrome__navigate", "mcp__ComputerUse__click", "mcp__plugin_x_chrome-devtools__eval"):
        ck(d(t) == "deny", f"tool {t} denied")
    for t in ("mcp__Webflow__data_cms_tool", "WebFetch", "Bash", "mcp__Supabase__execute_sql",
              "mcp__Figma__get_screenshot", "mcp__plugin_small-business_shopify__get-product",
              "mcp__Webflow__chrome_settings", "mcp__", "mcp__x"):
        ck(d(t) is None, f"tool {t} allowed")
    ck(d("Skill") is None, "Skill with no input does not crash")
    r = evaluate("Skill", {"skill": "computer-use"})
    ck("[mod:no-browser-as-me]" in r[1] and "WebFetch" in r[1], "reason names the alternatives")

    import os
    import subprocess
    run = lambda s: subprocess.run([sys.executable, os.path.abspath(__file__)], input=s,  # noqa: E731
                                   capture_output=True, text=True)
    p = run(json.dumps({"tool_name": "Skill", "tool_input": {"skill": "computer-use"}}))
    ck(p.returncode == 0 and json.loads(p.stdout)["hookSpecificOutput"]["permissionDecision"]
       == "deny", "main(): emits deny")
    p = run(json.dumps({"tool_name": "Skill", "tool_input": "x"}))
    ck(p.returncode == 0 and p.stdout == "", "main(): non-dict input is silent")
    p = run("{x")
    ck(p.returncode == 1 and p.stdout == "", "main(): junk fails open and visible")

    print(f"no-browser-as-me selftest: {checks - fails}/{checks} checks passed")
    return 1 if fails else 0


def main() -> int:
    if "--selftest" in sys.argv:
        return _selftest()
    try:
        raw = sys.stdin.read()
        payload = json.loads(raw) if raw.strip() else {}
        tool_input = payload.get("tool_input") or {}
        verdict = evaluate(payload.get("tool_name") or "",
                           tool_input if isinstance(tool_input, dict) else {})
    except Exception as e:  # noqa: BLE001
        sys.stderr.write(f"no-browser-as-me: could not evaluate ({e}); allowing the call.\n")
        return 1
    if verdict:
        json.dump({"hookSpecificOutput": {"hookEventName": "PreToolUse",
                                          "permissionDecision": verdict[0],
                                          "permissionDecisionReason": verdict[1]}}, sys.stdout)
        sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
