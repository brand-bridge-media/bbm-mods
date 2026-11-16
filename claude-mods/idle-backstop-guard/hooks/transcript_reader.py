#!/usr/bin/env python3
"""Shared reader for the session transcript JSONL that hooks are handed (LCH-528).

WHAT IT DOES. Claude Code passes every hook a `transcript_path`. Each line is one
event; an assistant turn is split into one entry per block (thinking, text,
tool_use) and tool results come back as `user` entries whose content is a list of
`tool_result` blocks. This module turns that into three questions guards ask:

  * final_reply_text()  — the assistant text written since the last real prompt
  * tool_uses()         — (name, input) for every tool call, in order
  * tool_results_text() — (tool name, result text) pairs

WHY A MODULE. reply-footer-check and recurring-successor-guard both read it; the
format is undocumented and has already changed shape once (per-block entries), so
it is parsed in one place and pinned by one selftest.

Unreadable lines are skipped, never raised: a hook that crashes on a transcript
quirk blocks nothing and gets disabled.

Self-test: python3 transcript_reader.py --selftest
"""
from __future__ import annotations

import json
import sys


def load(path: str | None) -> list[dict]:
    rows: list[dict] = []
    if not path:
        return rows
    try:
        with open(path, encoding="utf-8") as fh:
            for line in fh:
                try:
                    r = json.loads(line)
                except ValueError:
                    continue
                if isinstance(r, dict):
                    rows.append(r)
    except OSError:
        pass
    return rows


def rows_for(payload: dict) -> list[dict]:
    """Transcript rows for a hook payload.

    Inline `transcript_rows` when given: a classic.PreToolUse hook carries no transcript
    path, so a mod that needs one keeps its own record of the calls that matter and hands
    it over. Otherwise the file at `transcript_path`.
    """
    inline = payload.get("transcript_rows") if isinstance(payload, dict) else None
    if isinstance(inline, list):
        return [r for r in inline if isinstance(r, dict)]
    return load(payload.get("transcript_path") if isinstance(payload, dict) else None)


def _blocks(row: dict) -> list[dict]:
    msg = row.get("message")
    c = msg.get("content") if isinstance(msg, dict) else None
    if isinstance(c, str):
        return [{"type": "text", "text": c}]
    return [b for b in c if isinstance(b, dict)] if isinstance(c, list) else []


def _is_prompt(row: dict) -> bool:
    """A user entry a person (or the harness) typed, not a tool result."""
    if row.get("type") != "user" or row.get("isSidechain"):
        return False
    return not any(b.get("type") == "tool_result" for b in _blocks(row))


def final_reply_text(rows: list[dict]) -> str:
    last = max((i for i, r in enumerate(rows) if _is_prompt(r)), default=-1)
    texts = [b.get("text") or "" for r in rows[last + 1:]
             if r.get("type") == "assistant" and not r.get("isSidechain")
             for b in _blocks(r) if b.get("type") == "text"]
    return texts[-1] if texts else ""


def tool_uses(rows: list[dict]) -> list[tuple[str, dict, str]]:
    """(name, input, tool_use_id) for main-thread tool calls."""
    out = []
    for r in rows:
        if r.get("type") != "assistant" or r.get("isSidechain"):
            continue
        for b in _blocks(r):
            if b.get("type") == "tool_use":
                inp = b.get("input") if isinstance(b.get("input"), dict) else {}
                out.append((b.get("name") or "", inp, b.get("id") or ""))
    return out


def tool_results_text(rows: list[dict]) -> list[tuple[str, str]]:
    return [(name, text) for name, _, text in tool_calls_with_results(rows)]


def tool_calls_with_results(rows: list[dict]) -> list[tuple[str, dict, str]]:
    """(tool name, tool input, result text) for every tool result in the transcript."""
    calls = {tid: (name, inp) for name, inp, tid in tool_uses(rows)}
    out = []
    for r in rows:
        if r.get("type") != "user":
            continue
        for b in _blocks(r):
            if b.get("type") != "tool_result":
                continue
            c = b.get("content")
            if isinstance(c, list):
                c = "\n".join(x.get("text", "") for x in c if isinstance(x, dict))
            name, inp = calls.get(b.get("tool_use_id"), ("", {}))
            out.append((name, inp, c if isinstance(c, str) else ""))
    return out


def _selftest() -> int:
    import os
    import tempfile
    checks = fails = 0

    def ck(cond: bool, label: str) -> None:
        nonlocal checks, fails
        checks += 1
        if not cond:
            fails += 1
            sys.stderr.write(f"  FAIL: {label}\n")

    rows = [
        {"type": "user", "message": {"content": "first prompt"}},
        {"type": "assistant", "message": {"content": [{"type": "text", "text": "old reply"}]}},
        {"type": "user", "message": {"content": [{"type": "text", "text": "second prompt"}]}},
        {"type": "assistant", "message": {"content": [{"type": "thinking", "thinking": "x"}]}},
        {"type": "assistant", "message": {"content": [
            {"type": "tool_use", "id": "t1", "name": "mcp__Atlassian__createJiraIssue",
             "input": {"projectKey": "LCH"}}]}},
        {"type": "user", "message": {"content": [
            {"type": "tool_result", "tool_use_id": "t1",
             "content": [{"type": "text", "text": '{"key":"LCH-9"}'}]}]}},
        {"type": "assistant", "isSidechain": True,
         "message": {"content": [{"type": "text", "text": "subagent text"}]}},
        {"type": "assistant", "message": {"content": [{"type": "text", "text": "interim"}]}},
        {"type": "assistant", "message": {"content": [{"type": "text", "text": "final\nNothing"}]}},
    ]
    ck(final_reply_text(rows) == "final\nNothing", "final reply is the last main-thread text")
    ck(final_reply_text(rows[:3]) == "", "no text since the last prompt -> empty")
    side = rows + [
        {"type": "assistant", "isSidechain": True, "message": {"content": [
            {"type": "text", "text": "late subagent text"},
            {"type": "tool_use", "id": "s1", "name": "SideTool", "input": {}}]}},
        {"type": "assistant", "message": {"content": [
            {"type": "tool_result", "tool_use_id": "t1", "content": "not a result"}]}}]
    ck(final_reply_text(side) == "final\nNothing", "a later sidechain text is not the final reply")
    ck([n for n, _, _ in tool_uses(side)] == ["mcp__Atlassian__createJiraIssue"],
       "sidechain tool calls are excluded")
    ck(len(tool_calls_with_results(side)) == 1, "a tool_result block on an assistant row is ignored")
    ck(final_reply_text([{"type": "user", "message": {"content": "p"}},
                         {"type": "assistant", "message": {"content": "plain string"}}])
       == "plain string", "string message content is a text block")
    ck(tool_uses(rows) == [("mcp__Atlassian__createJiraIssue", {"projectKey": "LCH"}, "t1")],
       "tool_uses lists main-thread calls")
    ck(tool_results_text(rows) == [("mcp__Atlassian__createJiraIssue", '{"key":"LCH-9"}')],
       "results are paired with their tool name, list content flattened")
    ck(tool_calls_with_results(rows) == [("mcp__Atlassian__createJiraIssue", {"projectKey": "LCH"},
                                          '{"key":"LCH-9"}')], "results carry their call's input")
    ck(tool_results_text([{"type": "user", "message": {"content": [
        {"type": "tool_result", "tool_use_id": "zz", "content": "plain"}]}}]) == [("", "plain")],
       "string result content, unknown tool id")

    with tempfile.NamedTemporaryFile("w", suffix=".jsonl", delete=False) as fh:
        fh.write(json.dumps(rows[0]) + "\nnot json\n[1]\n" + json.dumps(rows[1]) + "\n")
    try:
        ck(len(load(fh.name)) == 2, "load skips junk lines and non-objects")
    finally:
        os.unlink(fh.name)
    ck(load("/nonexistent/x.jsonl") == [] and load(None) == [], "missing transcript is empty")
    ck(rows_for({"transcript_rows": [rows[0], "junk", 7]}) == [rows[0]],
       "inline transcript_rows win, non-objects dropped")
    ck(rows_for({"transcript_rows": None, "transcript_path": "/nonexistent"}) == [],
       "no inline rows -> the transcript file")
    ck(rows_for("not a dict") == [], "a non-dict payload is empty, not a crash")
    ck(final_reply_text([{"type": "assistant", "message": None}]) == "", "malformed rows tolerated")

    print(f"transcript_reader selftest: {checks - fails}/{checks} checks passed")
    return 1 if fails else 0


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        raise SystemExit(_selftest())
    raise SystemExit(0)
