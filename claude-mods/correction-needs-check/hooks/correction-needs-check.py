#!/usr/bin/env python3
"""correction-needs-check — ONE question: "is this write recording a correction without naming what enforces it?" (LC-2151).

WHAT IT DOES. Before one of these runs, it looks at the text being written:

  * a Supabase `execute_sql` that INSERTs into knowledge_memories a `lesson` or `preference` memory, or any memory that
    reads like a correction (correction, wrong, mistake, again, repeatedly, keeps happening);
  * a Write / Edit / MultiEdit that ADDS a "Why this rule exists" block to a CLAUDE.md;
  * one that adds "Why this rule exists", "Operator decision" or "correction" to a skill's SKILL.md;
  * one that writes a Claude Code memory file (`.../memory/*.md`) of `type: feedback`.

If the new text carries no `Enforced by:` and no `Not checkable because:` line, it adds a note asking for one, with the
two exact ways to close it. The write itself always goes ahead.

WHY. A correction written only as prose gets missed: CLAUDE.md records the same lesson being re-learned four and five
times ("written here rather than into a sixth memory"). The ai-software-development-philosophy skill now says a
correction is closed only by an enforcer or a recorded reason; this delivers that rule at the one moment it matters,
when the correction is being written down. Advisory first (single-job-module rule: a new check runs on real data and a
person reads the result before it may block).

Self-test: python3 correction-needs-check.py --selftest
"""
from __future__ import annotations

import json
import os
import re
import sys

MOD = "[mod:correction-needs-check]"
ENFORCER = re.compile(r"(?i)\b(enforced[ _-]by|not[ _-]check(?:ed|able)[ _-]because)\s*:")
MEMORY_INSERT = re.compile(r"(?i)\binsert\s+into\s+(?:public\.)?knowledge_memories\b")
CORRECTION_TYPE = re.compile(r"(?i)'(lesson|preference)'")
CORRECTION_WORDS = re.compile(r"(?i)\b(correction|corrected|wrong(?:ly)?|mistake|again|repeated(?:ly)?|keeps happening)\b")
WHY_BLOCK = re.compile(r"(?i)why this rule exists")
SKILL_MARKERS = re.compile(r"(?i)why this rule exists|operator decision|\bcorrection\b")
FEEDBACK_MEMORY = re.compile(r"(?im)^\s*type:\s*feedback\s*$")
MEMORY_PATH = re.compile(r"(?:^|/)memory/[^/]+(?:/[^/]+)*\.md$")

ASK = (" A correction is closed by a check, not by prose (LC-2151; owner: ai-software-development-philosophy, "
       "'Every correction ends as a check'). Name the check that enforces it, or the reason none can: "
       "(1) give it an enforcer: add an entry to infra/corrections.json in bbm-infrastructure, preferably with a `check` "
       "block (paths, must / must_not, and wrong / why / fix sentences; see scripts/ci/CHECK-MESSAGES.md), or name one "
       "that exists (quick:<id>, mod:<name>, hook:<file>, workflow:<file>, script:<path>), then add the line "
       "`Enforced by: <that reference>` to this text; or "
       "(2) if no machine can check it, add `Not checkable because: <reason>` to this text and record the same reason in "
       "infra/corrections.json. If this is not a correction, ignore this note.")


def _added_removed(tool_input: dict) -> tuple[str, str]:
    """(text this write adds, text it replaces)."""
    if isinstance(tool_input.get("content"), str):
        return tool_input["content"], ""
    edits = tool_input.get("edits")
    if isinstance(edits, list):
        pairs = [(str(e.get("new_string") or ""), str(e.get("old_string") or "")) for e in edits if isinstance(e, dict)]
        return "\n".join(p[0] for p in pairs), "\n".join(p[1] for p in pairs)
    return str(tool_input.get("new_string") or ""), str(tool_input.get("old_string") or "")


def _newly(pattern: re.Pattern, added: str, removed: str) -> bool:
    """The pattern occurs more often in the new text than in the text it replaces (so an edit near an old block is quiet)."""
    return len(pattern.findall(added)) > len(pattern.findall(removed))


def what_correction(tool_name: str, tool_input: dict) -> tuple[str, str] | None:
    """(what is being written, its text) when this write records a correction; else None."""
    low = (tool_name or "").lower()
    if low.startswith("mcp__") and "supabase" in low and low.endswith("__execute_sql"):
        q = tool_input.get("query")
        if isinstance(q, str) and MEMORY_INSERT.search(q) and (CORRECTION_TYPE.search(q) or CORRECTION_WORDS.search(q)):
            return "a knowledge memory that records a lesson or correction", q
        return None
    if tool_name not in ("Write", "Edit", "MultiEdit"):
        return None
    path = str(tool_input.get("file_path") or "").replace("\\", "/")
    added, removed = _added_removed(tool_input)
    base = path.rsplit("/", 1)[-1]
    if base == "CLAUDE.md" and _newly(WHY_BLOCK, added, removed):
        return "a CLAUDE.md 'Why this rule exists' block", added
    if base == "SKILL.md" and _newly(SKILL_MARKERS, added, removed):
        return "a skill rule that records a correction or operator decision", added
    if MEMORY_PATH.search(path) and base != "MEMORY.md" and FEEDBACK_MEMORY.search(added):
        return "a feedback memory", added
    return None


def evaluate(tool_name: str, tool_input: dict) -> str | None:
    found = what_correction(tool_name, tool_input if isinstance(tool_input, dict) else {})
    if not found:
        return None
    kind, text = found
    if ENFORCER.search(text):
        return None
    return f"{MOD} This writes down {kind} with no `Enforced by:` or `Not checkable because:` line." + ASK


def _selftest() -> int:
    checks = fails = 0

    def ck(cond: bool, label: str) -> None:
        nonlocal checks, fails
        checks += 1
        if not cond:
            fails += 1
            sys.stderr.write(f"  FAIL: {label}\n")

    S = "mcp__Supabase__execute_sql"
    ins = "INSERT INTO public.knowledge_memories (content, memory_type) VALUES ('{c}', '{t}')"
    r = evaluate(S, {"query": ins.format(c="LESSON: never dispatch in parallel", t="lesson")})
    ck(bool(r) and r.startswith(MOD) and "knowledge memory" in r, "a lesson memory insert is nudged, with the callout")
    ck("infra/corrections.json" in r and "Enforced by:" in r and "Not checkable because:" in r, "the note says both ways out")
    ck(bool(evaluate(S, {"query": ins.format(c="x", t="preference")})), "a preference memory is a correction")
    ck(bool(evaluate(S, {"query": ins.format(c="we did it WRONG twice", t="decision")})), "correction words on a decision")
    ck(evaluate(S, {"query": ins.format(c="Webflow API caps page size at 100", t="context")}) is None,
       "a plain context memory is quiet")
    ck(evaluate(S, {"query": ins.format(c="x. Enforced by: quick:corrections (webflow-token-one-at-a-time)", t="lesson")})
       is None, "a lesson that names its enforcer is quiet")
    ck(evaluate(S, {"query": ins.format(c="x. Not checkable because: advice in chat", t="lesson")}) is None,
       "a lesson with a reason is quiet")
    ck(evaluate(S, {"query": ins.format(c="x. not_checked_because: chat only", t="lesson")}) is None,
       "the register's field spelling counts too")
    ck(evaluate(S, {"query": "insert into knowledge_memories_archive values ('lesson')"}) is None, "another table is quiet")
    ck(evaluate(S, {"query": "select * from knowledge_memories where memory_type = 'lesson'"}) is None, "a read is quiet")
    ck(evaluate("mcp__Other__execute_sql", {"query": ins.format(c="x", t="lesson")}) is None, "a non-Supabase SQL tool is quiet")
    ck(evaluate(S, {"query": None}) is None and evaluate(S, {}) is None, "a missing query does not crash")

    why = "> **Why this rule exists.** On 2026-11-11 four runs shared one token."
    r = evaluate("Edit", {"file_path": "/r/CLAUDE.md", "old_string": "a", "new_string": "a\n" + why})
    ck(bool(r) and "CLAUDE.md 'Why this rule exists'" in r, "a new CLAUDE.md Why block is nudged")
    ck(evaluate("Edit", {"file_path": "/r/CLAUDE.md", "old_string": why, "new_string": why + " Fixed typo."}) is None,
       "editing an existing Why block is quiet")
    ck(evaluate("Edit", {"file_path": "/r/CLAUDE.md", "old_string": "a", "new_string": why + "\nEnforced by: quick:x"}) is None,
       "a new Why block that names its enforcer is quiet")
    ck(evaluate("Edit", {"file_path": "/r/docs/NOTES.md", "old_string": "a", "new_string": why}) is None,
       "the Why phrase in another file is quiet")
    ck(bool(evaluate("Write", {"file_path": "/r/sub/CLAUDE.md", "content": why})), "a Write of a CLAUDE.md counts")
    ck(bool(evaluate("MultiEdit", {"file_path": "C:\\r\\CLAUDE.md", "edits": [{"old_string": "a", "new_string": "b"},
                                                                             {"old_string": "c", "new_string": why}]})),
       "MultiEdit edits are read, Windows paths too")
    ck(evaluate("MultiEdit", {"file_path": "/r/CLAUDE.md", "edits": ["junk", {"old_string": why, "new_string": why}]}) is None,
       "a malformed edit entry does not crash and a moved block is quiet")

    sk = "/s/living-cozy/skills/x/SKILL.md"
    ck(bool(evaluate("Edit", {"file_path": sk, "old_string": "", "new_string": "Operator decision (2026-11-16): never X."})),
       "an operator decision added to a skill is nudged")
    ck(bool(evaluate("Edit", {"file_path": sk, "old_string": "", "new_string": "This is a correction to rule 3."})),
       "a correction added to a skill is nudged")
    ck(evaluate("Edit", {"file_path": sk, "old_string": "", "new_string": "Run the audit before publishing."}) is None,
       "an ordinary skill edit is quiet")
    ck(evaluate("Edit", {"file_path": "/s/x/README.md", "old_string": "", "new_string": "Operator decision: x"}) is None,
       "a non-skill markdown file is quiet")

    fb = "---\nname: x\nmetadata:\n  type: feedback\n---\nDo not use bare PR numbers.\n"
    mp = "/tmp/claude/memory/team/silo/no-bare-pr.md"
    ck(bool(evaluate("Write", {"file_path": mp, "content": fb})), "a feedback memory file is nudged")
    ck(evaluate("Write", {"file_path": mp, "content": fb + "Not checkable because: chat replies only\n"}) is None,
       "a feedback memory with a reason is quiet")
    ck(evaluate("Write", {"file_path": mp, "content": fb.replace("feedback", "project")}) is None, "a project memory is quiet")
    ck(evaluate("Write", {"file_path": "/tmp/claude/memory/team/silo/MEMORY.md", "content": fb}) is None, "the index is quiet")
    ck(evaluate("Write", {"file_path": "/r/notes/feedback.md", "content": fb}) is None, "a non-memory path is quiet")
    ck(evaluate("Read", {"file_path": "/r/CLAUDE.md", "content": why}) is None, "other tools are quiet")
    ck(evaluate("NotebookEdit", {"file_path": "/r/CLAUDE.md", "new_string": why}) is None, "NotebookEdit is quiet")
    ck(evaluate("Edit", "not a dict") is None, "a non-dict input does not crash")

    import subprocess
    run = lambda s: subprocess.run([sys.executable, os.path.abspath(__file__)], input=s,  # noqa: E731
                                   capture_output=True, text=True)
    p = run(json.dumps({"tool_name": S, "tool_input": {"query": ins.format(c="x", t="lesson")}}))
    h = json.loads(p.stdout)["hookSpecificOutput"] if p.returncode == 0 and p.stdout else {}
    ck(h.get("hookEventName") == "PreToolUse" and h.get("additionalContext", "").startswith(MOD),
       "main(): emits additionalContext")
    ck("permissionDecision" not in h, "main(): never emits a deny or an ask")
    p = run(json.dumps({"tool_name": "Read", "tool_input": {}}))
    ck(p.returncode == 0 and p.stdout == "", "main(): silent when nothing to say")
    p = run("{x")
    ck(p.returncode == 1 and p.stdout == "", "main(): junk input fails open and visible")

    print(f"correction-needs-check selftest: {checks - fails}/{checks} checks passed")
    return 1 if fails else 0


def main() -> int:
    if "--selftest" in sys.argv:
        return _selftest()
    try:
        raw = sys.stdin.read()
        payload = json.loads(raw) if raw.strip() else {}
        tool_input = payload.get("tool_input") or {}
        note = evaluate(payload.get("tool_name") or "", tool_input if isinstance(tool_input, dict) else {})
    except Exception as e:  # noqa: BLE001
        sys.stderr.write(f"correction-needs-check: could not evaluate ({e}).\n")
        return 1
    if note:
        json.dump({"hookSpecificOutput": {"hookEventName": "PreToolUse", "additionalContext": note}}, sys.stdout)
        sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
