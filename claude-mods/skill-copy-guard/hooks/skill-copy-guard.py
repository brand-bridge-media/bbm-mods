#!/usr/bin/env python3
"""PreToolUse guard — never edit a skill's byte copy (LCH-528).

WHAT IT DOES. DENIES Write / Edit / NotebookEdit on any path under `.claude/skills/`.

WHY. Skills live in brand-bridge-media/claude-skills; merging a PR there is the whole
deploy, and every Claude Code repo receives a byte copy by CI mirror (e.g. BBM-83
"Mirror skills from claude-skills@..."). An edit to the copy changes nothing at the
source, is overwritten by the next mirror, and meanwhile makes this repo's sessions
read a skill no other surface sees. Stan's preference: "Never save_skill a skill
copy" — this is the same rule for the copy that lives in git.

NOT GATED. The CI mirror (it is not a session). Bash writes: deliberately — the
mirror's own scripts run from Bash in CI, and gating a shell text match would trade
a real false-positive for a rare miss.

Self-test: python3 skill-copy-guard.py --selftest
"""
from __future__ import annotations

import json
import re
import sys

COPY_PATH = re.compile(r"(?:^|[/\\])\.claude[/\\]skills[/\\]")
TOOLS = {"Write", "Edit", "NotebookEdit", "MultiEdit"}

REASON = ("[mod:skill-copy-guard] REFUSED: {path} is a byte copy mirrored from "
          "brand-bridge-media/claude-skills; edits here are overwritten by the next mirror and never "
          "reach chat or Cowork. Change the skill in claude-skills (add_repo it, branch, PR; the "
          "merge is the deploy), and the mirror brings it here.")


def evaluate(tool_name: str, tool_input: dict) -> tuple[str, str] | None:
    if tool_name not in TOOLS:
        return None
    path = str(tool_input.get("file_path") or tool_input.get("notebook_path") or "")
    if COPY_PATH.search(path):
        return "deny", REASON.format(path=path)
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

    P = "/home/user/bbm-infrastructure/.claude/skills/webflow-cms/SKILL.md"
    for t in ("Write", "Edit", "MultiEdit"):
        ck(d(t, file_path=P) == "deny", f"{t} on a skill copy denied")
    ck(d("NotebookEdit", notebook_path=".claude/skills/x/n.ipynb") == "deny", "relative notebook path")
    ck(d("Edit", file_path="C:\\repo\\.claude\\skills\\x\\SKILL.md") == "deny", "windows path")
    for p in ("/home/user/bbm-infrastructure/.claude/hooks/x.py",
              "/home/user/claude-skills/skills/webflow-cms/SKILL.md",
              "/home/user/bbm-infrastructure/.claude/settings.json",
              "/home/user/x/my.claude/skills-notes.md", "/home/user/x/.claude/skillsets/a.md"):
        ck(d("Edit", file_path=p) is None, f"allowed: {p}")
    ck(d("Read", file_path=P) is None, "reading a copy is fine")
    ck(d("Bash", command=f"cat {P}") is None, "Bash untouched")
    ck(d("Edit") is None, "missing path does not crash")
    r = evaluate("Edit", {"file_path": P})
    ck("[mod:skill-copy-guard]" in r[1] and "claude-skills" in r[1], "reason names the source repo")

    import os
    import subprocess
    run = lambda s: subprocess.run([sys.executable, os.path.abspath(__file__)], input=s,  # noqa: E731
                                   capture_output=True, text=True)
    p = run(json.dumps({"tool_name": "Write", "tool_input": {"file_path": P}}))
    ck(p.returncode == 0 and json.loads(p.stdout)["hookSpecificOutput"]["permissionDecision"]
       == "deny", "main(): emits deny")
    p = run(json.dumps({"tool_name": "Write", "tool_input": None}))
    ck(p.returncode == 0 and p.stdout == "", "main(): null input is silent")
    p = run("{x")
    ck(p.returncode == 1 and p.stdout == "", "main(): junk fails open and visible")

    print(f"skill-copy-guard selftest: {checks - fails}/{checks} checks passed")
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
        sys.stderr.write(f"skill-copy-guard: could not evaluate ({e}); allowing the call.\n")
        return 1
    if verdict:
        json.dump({"hookSpecificOutput": {"hookEventName": "PreToolUse",
                                          "permissionDecision": verdict[0],
                                          "permissionDecisionReason": verdict[1]}}, sys.stdout)
        sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
