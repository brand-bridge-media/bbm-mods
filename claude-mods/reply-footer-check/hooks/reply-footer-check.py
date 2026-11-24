#!/usr/bin/env python3
"""Stop hook — every reply ends with the tracker footer, and its keys are real (LCH-528, LC-2172).

WHAT IT DOES. When a turn ends, reads the final reply from the transcript and
blocks the stop ONCE (the model gets one more pass) when:

  * the reply does not end with one of the three tracker footers from the operator's
    preferences (2026-11-16, LC-2172):

        Noted separately: nothing found.
        Noted separately: nothing filed (<N> minor, below the bar: <a few words>).
        Noted separately:
        - <KEY or lcc_issues row> (<short name>) · <epic> · now | this week | someday · <why>
        - Deferred: <KEY> until <trigger>

    The third is MULTI-LINE: a bare `Noted separately:` header, then only bullet lines
    to the end of the reply. Every bullet needs an urgency word; every Deferred line
    needs `until <trigger>`.
  * a Jira key the footer names (bullet or Deferred line) was never touched by an
    Atlassian tool call this session — a footer naming a ticket nobody filed is worse
    than no footer, because the operator trusts it. An `lcc_issues` row reference is
    taken as written (no Jira lookup; its exact form is LC-2171's to settle).

THE OLD ONE-LINE FOOTER (`Noted separately: Nothing` / `Noted separately: LC-1, LC-2` /
bare `Nothing`) is still accepted until LEGACY_UNTIL (the 14-day transition, LC-2172), so
sessions that started before the preference changed are not blocked. After that date it
is refused, EXCEPT in Stature sessions: the operator's Stature section defines no footer
of its own, so Stature keeps the old one-liner indefinitely and is never asked for the
BBM format. A session is Stature when its working directory names `stature`.

WHY. The operator's preference: adjacent findings go to the tracker, and the end of
every reply says which. As a preference it was followed when remembered. The key check
is the reason this is a hook and not a regex in a skill: only the transcript knows
whether the ticket exists.

WHY IT CANNOT LOOP. Claude Code sets `stop_hook_active` on the stop that follows a
block; this hook always passes then. Worst case is one extra model pass per turn.

Self-test: python3 reply-footer-check.py --selftest
"""
from __future__ import annotations

import datetime as dt
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import transcript_reader as tr  # noqa: E402

KEY = r"[A-Z][A-Z0-9]+-\d+"
# LC-2172: the old one-line footer is accepted through this date (14 days from the
# preference change on 2026-11-16), then refused outside Stature. Delete LEGACY_FOOTER
# and this constant once the date has passed and nobody has asked for an extension.
LEGACY_UNTIL = dt.date(2026, 11, 30)
LEGACY_FOOTER = re.compile(rf"^(?:noted separately:\s*)?(nothing|{KEY}(?:\s*,\s*{KEY})*)\s*\.?$",
                           re.IGNORECASE)
HEADER = re.compile(r"^noted separately:\s*(.*)$", re.IGNORECASE)
NOTHING_FOUND = re.compile(r"^nothing found\s*\.?$", re.IGNORECASE)
NOTHING_FILED = re.compile(r"^nothing filed\s*\(\s*\d+\s+minor\s*,\s*below the bar\s*:\s*\S.*\)\s*\.?$",
                           re.IGNORECASE)
SEP = r"\s*[·•|]\s*"
LCC_ROW = r"lcc_issues(?:\s*(?:row)?\s*[#:/]?\s*[\w-]+)"
BULLET = re.compile(rf"^(?P<ref>{KEY}|{LCC_ROW})\s*\((?P<name>[^)]*\S[^)]*)\){SEP}(?P<epic>[^·•|]*\S[^·•|]*?)"
                    rf"{SEP}(?P<urgency>now|this week|someday){SEP}(?P<why>\S.*)$", re.IGNORECASE)
DEFERRED = re.compile(rf"^deferred:\s*(?P<ref>{KEY})\s+until\s+\S", re.IGNORECASE)
_BULLET_MARK = re.compile(r"^\s*[-*•]\s+")
_MARKUP = re.compile(r"[*_`>]")
_INLINE = re.compile(r"\*\*|`")  # bullets keep `_` (lcc_issues) but lose bold and code ticks

FORMS = ("`Noted separately: nothing found.` / `Noted separately: nothing filed (<N> minor, below "
         "the bar: <a few words>).` / `Noted separately:` followed by bullet lines `- <KEY or "
         "lcc_issues row> (<short name>) · <epic> · now | this week | someday · <why>` and "
         "`- Deferred: <KEY> until <trigger>`")


def _header_line(line: str) -> str:
    return _MARKUP.sub("", line).strip()


def parse_footer(reply: str, legacy_ok: bool) -> tuple[list[str] | None, str | None]:
    """(Jira keys to verify, problem). keys is None when there is no acceptable footer;
    problem then says what is wrong, or is None when there is no footer at all."""
    lines = [ln for ln in (reply or "").splitlines() if ln.strip()]
    if not lines:
        return None, None
    last = _header_line(lines[-1])
    if legacy_ok:
        m = LEGACY_FOOTER.match(last)
        if m and (last.lower().startswith("noted separately") or m.group(1).lower() == "nothing"):
            # a bare "LC-12" line is a sentence, not the footer
            return ([] if m.group(1).lower() == "nothing" else re.findall(KEY, m.group(1).upper())), None
    m = HEADER.match(last)
    if m:
        rest = m.group(1).strip()
        if NOTHING_FOUND.match(rest) or NOTHING_FILED.match(rest):
            return [], None
        return None, (f"`{last}` is not a footer form" if rest else
                      "`Noted separately:` is the last line but no bullet follows it")
    # Multi-line form: walk back over bullets to the header.
    i = len(lines) - 1
    while i >= 0 and _BULLET_MARK.match(lines[i]):
        i -= 1
    bullets = lines[i + 1:]
    # No guard needed for "no bullets" (lines[i] is then the last line, already known not to be
    # a header) or "all bullets" (i == -1 reads the last bullet, which is not a header either):
    # both fall through to `not hm`. A guard here was an equivalent mutant (mutate.py, LC-2172).
    hm = HEADER.match(_header_line(lines[i]))
    if not hm:
        return None, None
    if hm.group(1).strip():
        return None, "a `Noted separately:` header followed by bullets must have nothing after the colon"
    keys: list[str] = []
    for raw in bullets:
        body = _INLINE.sub("", _BULLET_MARK.sub("", raw, count=1)).strip()
        d = DEFERRED.match(body)
        if d:
            keys.append(d.group("ref").upper())
            continue
        if body.lower().startswith("deferred"):
            return None, f"Deferred line `{body}` needs `Deferred: <KEY> until <trigger>`"
        b = BULLET.match(body)
        if not b:
            return None, (f"bullet `{body}` needs `<KEY or lcc_issues row> (<short name>) · <epic> · "
                          "now | this week | someday · <why>`")
        if not b.group("ref").lower().startswith("lcc_issues"):
            keys.append(b.group("ref").upper())
    return keys, None


def footer_keys(reply: str, legacy_ok: bool = True) -> list[str] | None:
    """Keys in the footer ([] for none), or None when there is no acceptable footer."""
    return parse_footer(reply, legacy_ok)[0]


def is_stature(payload: dict, rows: list[dict]) -> bool:
    """Stature sessions keep the old footer (their preferences define none)."""
    cwds = [payload.get("cwd")] + [r.get("cwd") for r in rows if isinstance(r, dict)]
    return any(isinstance(c, str) and "stature" in c.lower() for c in cwds)


def legacy_allowed(payload: dict, rows: list[dict], today: dt.date | None = None) -> bool:
    return is_stature(payload, rows) or (today or dt.date.today()) <= LEGACY_UNTIL


def touched_keys(rows: list[dict]) -> set[str]:
    seen: set[str] = set()
    for name, inp, _ in tr.tool_uses(rows):
        if "atlassian" in name.lower():
            seen.update(re.findall(KEY, json.dumps(inp).upper()))  # `lc-77` touches LC-77
    for name, text in tr.tool_results_text(rows):
        if "atlassian" in name.lower() and "createjiraissue" in name.lower():
            seen.update(re.findall(KEY, text.upper()))
    return seen


# Review by 2027-02-23: in a project thread (mods load there since LC-2200) the person sees only the text argument of
# `mcp__hearthbot__post_message`; the trailing assistant text is never shown, so the footer must be read from the former
# (LC-2206, same rule as idle-backstop-guard's final_reply).
THREAD_REPLY_TOOL = "hearthbot__post_message"
SILENT_TOOL = "hearthbot__no_reply_needed"


def _turn_tool_uses(rows: list[dict]) -> list[tuple[str, dict]]:
    last = max((i for i, r in enumerate(rows) if tr._is_prompt(r)), default=-1)
    return [(str(b.get("name") or ""), b["input"] if isinstance(b.get("input"), dict) else {})
            for r in rows[last + 1:] if r.get("type") == "assistant" and not r.get("isSidechain")
            for b in tr._blocks(r) if b.get("type") == "tool_use"]


def final_reply(rows: list[dict]) -> str:
    """What the person reads: this turn's LAST post_message text when it has one, else the trailing text (CLI)."""
    posted = [i["text"] for n, i in _turn_tool_uses(rows)
              if n.endswith(THREAD_REPLY_TOOL) and isinstance(i.get("text"), str)]
    return posted[-1] if posted else tr.final_reply_text(rows)


def silent_turn(rows: list[dict]) -> bool:
    """A thread turn that ended in no_reply_needed with no post_message: nothing was shown, nothing to check."""
    names = [n for n, _ in _turn_tool_uses(rows)]
    return any(n.endswith(SILENT_TOOL) for n in names) and not any(n.endswith(THREAD_REPLY_TOOL) for n in names)


def evaluate(payload: dict, today: dt.date | None = None) -> str | None:
    """Block reason, or None to let the turn end."""
    if payload.get("stop_hook_active"):
        return None
    rows = tr.load(payload.get("transcript_path"))
    if silent_turn(rows):
        return None
    reply = final_reply(rows)
    if not reply.strip():
        return None  # no prose this turn (tool-only or empty); nothing to footer
    legacy = legacy_allowed(payload, rows, today)
    keys, problem = parse_footer(reply, legacy)
    if keys is None:
        old = (" The old one-line `Noted separately: Nothing` / `<KEY, KEY>` is accepted until "
               f"{LEGACY_UNTIL.isoformat()} (LC-2172)." if legacy else "")
        why = f" Problem: {problem}." if problem else ""
        return ("[mod:reply-footer-check] The reply must end with the tracker footer, one of: "
                f"{FORMS} (operator preference: adjacent findings go to the tracker, the footer says "
                f"which).{old}{why} Re-send the reply with the footer.")
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

    # Old one-line footer, accepted while legacy_ok (transition / Stature).
    for txt, want in (("done\n\nNoted separately: Nothing", []),
                      ("done\nNothing", []), ("done\n`Noted separately: LC-12, LCH-3`", ["LC-12", "LCH-3"]),
                      ("done\n**Noted separately:** lc-1.", ["LC-1"]), ("x\nNoted separately: Nothing\n\n", []),
                      ("done", None), ("Noted separately: Nothing\nmore text", None),
                      ("see LC-12", None), ("x\nLC-12", None), ("", None),
                      ("x\nNoted separately: soon", None)):
        ck(footer_keys(txt) == want, f"footer_keys({txt!r}) == {want}")
    # ... and refused once legacy_ok is off.
    for txt in ("done\nNoted separately: Nothing", "done\nNothing", "done\nNoted separately: LC-12"):
        ck(footer_keys(txt, legacy_ok=False) is None, f"legacy off: {txt!r} refused")

    B1 = "- LC-77 (fix widget) · LC-2141 · now · breaks the publish"
    B2 = "- lcc_issues#a1b2 (dead sofa link) · LC-2170 · this week · link 404s"
    B3 = "- **LCH-9** (slow cron) | LC-2014 | someday | worth keeping"
    D1 = "- Deferred: LC-88 until LC-2171 closes"
    new_forms = (
        ("done\n\nNoted separately: nothing found.", []),
        ("done\nNoted separately: nothing found", []),
        ("done\n**Noted separately:** nothing found.", []),
        ("done\nNoted separately: nothing filed (3 minor, below the bar: typos, a stale alt).", []),
        ("done\nNoted separately: nothing filed (0 minor, below the bar: none)", []),
        (f"done\nNoted separately:\n{B1}", ["LC-77"]),
        (f"done\n**Noted separately:**\n{B1}\n{B2}\n{B3}\n{D1}\n", ["LC-77", "LCH-9", "LC-88"]),
        (f"done\nNoted separately:\n{B2}", []),
        (f"done\nNoted separately:\n* `LC-77` (fix) · LC-2141 · THIS WEEK · why", ["LC-77"]),
        (f"done\nNoted separately:\n- LC-77 (fix) • LC-2141 • someday • why", ["LC-77"]),
        (f"done\nNoted separately:\n{D1}", ["LC-88"]),
        # failures
        ("done\nNoted separately:", None),
        ("done\nNoted separately: nothing filed", None),
        ("done\nNoted separately: nothing filed (some minor, below the bar: x).", None),
        ("done\nNoted separately: nothing filed (2 minor, below the bar: ).", None),
        ("done\nNoted separately: found nothing.", None),
        ("done\nNoted separately:\n- LC-77 (fix widget) · LC-2141 · breaks the publish", None),
        ("done\nNoted separately:\n- LC-77 (fix widget) · LC-2141 · soon · why", None),
        ("done\nNoted separately:\n- LC-77 (fix widget) · LC-2141 · now ·", None),
        ("done\nNoted separately:\n- LC-77 · LC-2141 · now · why", None),
        ("done\nNoted separately:\n- LC-77 () · LC-2141 · now · why", None),
        ("done\nNoted separately:\n- LC-77 (fix) ·  · now · why", None),
        ("done\nNoted separately:\n- widget (fix) · LC-2141 · now · why", None),
        ("done\nNoted separately:\n- Deferred: LC-88", None),
        ("done\nNoted separately:\n- Deferred: LC-88 until", None),
        ("done\nNoted separately:\n- Deferred: until Friday", None),
        (f"done\nNoted separately:\n{B1}\nmore prose after", None),
        (f"done\nNoted separately: LC-1\n{B1}", None),
        (f"done\n{B1}", None),
        (f"done\nsome list:\n{B1}", None),
        (f"{B1}", None),
    )
    for txt, want in new_forms:
        for legacy in (True, False):
            ck(footer_keys(txt, legacy_ok=legacy) == want, f"footer_keys({txt!r}, {legacy}) == {want}")
    ck("no bullet" in (parse_footer("x\nNoted separately:", False)[1] or ""), "bare header: says no bullet")
    ck("now | this week" in (parse_footer(
        "x\nNoted separately:\n- LC-1 (a) · LC-2 · soon · b", False)[1] or ""), "bad bullet: quotes the form")
    ck("until" in (parse_footer("x\nNoted separately:\n- Deferred: LC-8", False)[1] or ""),
       "bad Deferred: quotes until")
    ck("nothing after the colon" in (parse_footer(f"x\nNoted separately: LC-1\n{B1}", False)[1] or ""),
       "header with text + bullets: says so")
    ck("not a footer form" in (parse_footer("x\nNoted separately: soon", False)[1] or ""),
       "unknown one-liner: says so")
    ck(parse_footer("x\nplain end", False) == (None, None), "no footer: no specific problem")
    ck(parse_footer("", False) == (None, None), "empty: no footer")

    # The transition window and Stature scope.
    ck(legacy_allowed({}, [], dt.date(2026, 11, 30)), "legacy accepted on LEGACY_UNTIL")
    ck(not legacy_allowed({}, [], dt.date(2026, 12, 1)), "legacy refused the day after")
    ck(legacy_allowed({"cwd": "/home/u/Stature"}, [], dt.date(2027, 6, 1)), "Stature payload cwd: always legacy")
    ck(legacy_allowed({}, [{"cwd": "/x/stature-llc/stature"}], dt.date(2027, 6, 1)),
       "Stature transcript cwd: always legacy")
    ck(not legacy_allowed({"cwd": "/home/claude/bbm-infrastructure"}, [{"cwd": 5}, "junk"],
                          dt.date(2027, 6, 1)), "BBM cwd after window: legacy refused")
    ck(legacy_allowed({}, []) == (dt.date.today() <= LEGACY_UNTIL), "default today is the real date")

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
    COMMENT = "mcp__Atlassian__addCommentToJiraIssue"
    IN, OUT = dt.date(2026, 11, 20), dt.date(2026, 12, 15)
    cases = (
        ("ok\nNoted separately: Nothing", [], None, IN),
        ("ok", [], "must end with the tracker footer", IN),
        ("ok\nNoted separately: LC-77", [(CREATE, {"projectKey": "LC"}, '{"key":"LC-77"}')], None, IN),
        ("ok\nNoted separately: LC-77", [(COMMENT, {"issueIdOrKey": "LC-77"}, "ok")], None, IN),
        ("ok\nNoted separately: LC-77", [], "LC-77", IN),
        ("ok\nNoted separately: LC-77", [(COMMENT, {"issueIdOrKey": "lc-77"}, "ok")], None, IN),
        ("ok\nNoted separately: LC-77", [(CREATE, {}, '{"key":"lc-77"}')], None, IN),
        ("ok\nNoted separately: LC-77", [("mcp__Supabase__execute_sql", {"q": "LC-77"}, "LC-77")],
         "LC-77", IN),
        ("ok\nNoted separately: LC-77", [("mcp__Atlassian__searchJiraIssuesUsingJql", {"jql": "x"},
                                          "LC-77")], "LC-77", IN),
        # after the window the old footer is refused, the new ones pass
        ("ok\nNoted separately: Nothing", [], "must end with the tracker footer", OUT),
        ("ok\nNothing", [], "must end with the tracker footer", OUT),
        ("ok\nNoted separately: nothing found.", [], None, OUT),
        ("ok\nNoted separately: nothing filed (2 minor, below the bar: typos).", [], None, OUT),
        ("ok\nNoted separately:\n- LC-77 (fix) · LC-2141 · now · why",
         [(CREATE, {}, '{"key":"LC-77"}')], None, OUT),
        ("ok\nNoted separately:\n- LC-77 (fix) · LC-2141 · now · why", [], "LC-77", OUT),  # fake key
        ("ok\nNoted separately:\n- LC-77 (fix) · LC-2141 · why", [(CREATE, {}, '{"key":"LC-77"}')],
         "now | this week", OUT),  # no urgency
        ("ok\nNoted separately:\n- lcc_issues#9 (dead link) · LC-2170 · now · 404", [], None, OUT),
        ("ok\nNoted separately:\n- Deferred: LC-88 until 2026-12-01", [], "LC-88", OUT),
        ("ok\nNoted separately:\n- Deferred: LC-88 until 2026-12-01", [(COMMENT, {"issueIdOrKey": "LC-88"},
                                                                      "ok")], None, OUT),
        ("ok\nNoted separately:", [], "no bullet", OUT),
    )
    for reply, jira, want, today in cases:
        p = transcript(reply, jira)
        try:
            r = evaluate({"transcript_path": p}, today)
            ck((r is None) if want is None else (r is not None and want in r), f"evaluate({reply!r}, {[j[0][-20:] for j in jira]}, {today}) -> {want}")
            ck(evaluate({"transcript_path": p, "stop_hook_active": True}, today) is None,
               "stop_hook_active always passes (cannot loop)")
        finally:
            os.unlink(p)
    p = transcript("ok\nNoted separately: Nothing", [])
    try:
        ck(evaluate({"transcript_path": p, "cwd": "/w/stature"}, OUT) is None,
           "Stature session: old footer passes after the window")
        ck(evaluate({"transcript_path": p, "cwd": "/w/bbm-infrastructure"}, OUT) is not None,
           "BBM session: old footer refused after the window")
    finally:
        os.unlink(p)
    p = transcript("no footer", [])
    try:
        ck("until 2026-11-30" in (evaluate({"transcript_path": p}, IN) or ""),
           "in the window the reason mentions the old form's end date")
        ck("until 2026-11-30" not in (evaluate({"transcript_path": p}, OUT) or "x"),
           "after the window the reason does not offer the old form")
    finally:
        os.unlink(p)
    # Project threads (LC-2206): the person reads only the post_message text.
    PM, NR = "mcp__hearthbot__post_message", "mcp__hearthbot__no_reply_needed"
    GOOD = "done\nNoted separately: nothing found."

    def thread(*steps: tuple[str, object]) -> str:
        rows = [{"type": "user", "message": {"content": "go"}}]
        for i, (kind, val) in enumerate(steps):
            blk = ({"type": "text", "text": val} if kind == "text" else
                   {"type": "tool_use", "id": f"p{i}", "name": kind, "input": val})
            rows.append({"type": "assistant", "message": {"content": [blk]}})
        fh = tempfile.NamedTemporaryFile("w", suffix=".jsonl", delete=False)
        fh.write("\n".join(json.dumps(r) for r in rows))
        fh.close()
        return fh.name

    for label, steps, want_block in (
        ("valid: post_message has the footer, trailing text has none",
         (("text", "thinking"), (PM, {"text": GOOD}), ("text", "Posted the summary.")), False),
        ("bad: post_message has no footer", ((PM, {"text": "done, no footer"}),), True),
        ("bad: footer only in the trailing text", ((PM, {"text": "done"}), ("text", GOOD)), True),
        ("the LAST post_message is the reply (earlier one valid, last bad)",
         ((PM, {"text": GOOD}), (PM, {"text": "more"})), True),
        ("the LAST post_message is the reply (earlier bad, last valid)",
         ((PM, {"text": "more"}), (PM, {"text": GOOD})), False),
        ("silent turn: no_reply_needed is not checked", ((NR, {}), ("text", "no footer here")), False),
        ("no_reply_needed plus a post_message is still checked", ((NR, {}), (PM, {"text": "no footer"})), True),
        ("CLI turn: no post_message falls back to trailing text", (("text", "no footer"),), True),
        ("CLI turn: trailing text with footer passes", (("text", GOOD),), False),
        ("non-text post_message input ignored, falls back", ((PM, {"text": 5}), ("text", GOOD)), False),
    ):
        p = thread(*steps)
        try:
            r = evaluate({"transcript_path": p}, IN)
            ck((r is not None) == want_block, label)
        finally:
            os.unlink(p)
    ck(final_reply([{"type": "user", "message": {"content": "old"}}]) == "", "empty turn: empty reply")
    old = [{"type": "assistant", "message": {"content": [{"type": "tool_use", "id": "o", "name": PM,
                                                          "input": {"text": GOOD}}]}},
           {"type": "user", "message": {"content": "next"}},
           {"type": "assistant", "message": {"content": [{"type": "text", "text": "plain"}]}}]
    ck(final_reply(old) == "plain", "a post_message from an earlier turn is not this turn's reply")
    ck(not silent_turn([{"type": "assistant", "message": {"content": [
        {"type": "tool_use", "id": "z", "name": NR, "input": {}}]}}] + old[1:]),
       "an earlier turn's no_reply_needed does not count")
    ck(final_reply([{"type": "user", "message": {"content": "p"}},
                    {"type": "assistant", "isSidechain": True, "message": {"content": [
                        {"type": "tool_use", "id": "s", "name": PM, "input": {"text": GOOD}}]}},
                    {"type": "assistant", "message": {"content": [{"type": "text", "text": "plain"}]}}]) == "plain",
       "a subagent's post_message is not the reply")

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
    r = subprocess.run([sys.executable, os.path.abspath(__file__), "--bogus"], input="",
                       capture_output=True, text=True)
    ck(r.returncode == 1 and r.stdout == "", "main(): an unknown argument is refused, not read as a hook call")

    print(f"reply-footer-check selftest: {checks - fails}/{checks} checks passed")
    return 1 if fails else 0


def main() -> int:
    # LCH-847: the hook is always run with no arguments (py.ts runArgs), so any argument other than `--selftest`
    # is refused. Without that, a mutant that breaks the `--selftest` dispatch read an empty stdin and exited 0
    # like a passing selftest; whether it was scored killed depended on whether the sweep's stdin was open (the
    # floor once claimed both kills, CI's /dev/null sweep said they survive). Now it lands on the refusal (exit 1).
    if "--selftest" in sys.argv:
        return _selftest()
    if len(sys.argv) > 1:
        sys.stderr.write(f"reply-footer-check: unexpected arguments {sys.argv[1:]}\n")
        return 1
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
