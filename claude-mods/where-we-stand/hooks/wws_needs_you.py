#!/usr/bin/env python3
"""wws_needs_you — the NEEDS YOU guard (LC-1907).

ONE JOB: read the reply a session is about to send and, when it opens with the NEEDS YOU banner
(CLAUDE.md section 5) and names a ticket as a pending decision, say whether the operator is about to be
asked something that is already over. Mechanical, like wws_gate, because on 2026-10-23 the rule "check the
state before you ask" existed and an orchestrator still put LC-1755's moot "Most Durable" ruling to the
operator under a NEEDS YOU banner.

  * No banner: nothing to check, the reply passes.
  * A ticket the banner (or a decision sentence below it) names, with NO where-we-stand card produced this
    turn: blocked. Asking the operator needs a read of the state, not a memory of it.
  * Its card's `decision_moot` receipt BLOCKed for that ticket: blocked, with the evidence.
  * Its card's `decision_moot` is NOT CHECKED: blocked the same way; NOT CHECKED never reads as "open".
  A banner naming a pending decision goes out only once `decision_moot` is PASS for that ticket, so a re-send is blocked
  again (Claude Code's stop_hook_active is not consulted). The one way out is MAX_REPEAT blocks in a session, so a reply
  is never held forever.

A sentence that says the decision is settled (moot, ruled, decided...) does not name a pending decision, so
the honest rewrite ("LC-1755's ruling is moot, dropped") passes. The detection of "moot" is wws_moot, the same
function the card and the status generator use. The ledger of cards is the one wws_gate checks against.

Self-test: python3 wws_needs_you.py --selftest
"""
from __future__ import annotations

import datetime
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import transcript_reader as tr  # noqa: E402
import wws_card  # noqa: E402
import wws_moot  # noqa: E402

BANNER = re.compile(r"^\s*>\s*\*{0,2}NEEDS YOU:?\*{0,2}", re.IGNORECASE)
MAX_REPEAT = 3
PREFIX = "[mod:where-we-stand] NEEDS YOU guard: "


def banner_tickets(reply: str) -> list:
    """Tickets the reply puts to the operator as pending: those in the banner sentence(s) and in any other sentence that
    asks for a ruling, minus every sentence that says the matter is settled. [] when the reply has no banner."""
    lines = [ln for ln in str(reply or "").split("\n")]
    first = next((ln for ln in lines if ln.strip()), "")
    if not BANNER.match(first):
        return []
    out: list = []
    for i, ln in enumerate(lines):
        banner = ln is first
        # The banner marker is itself an open cue ("NEEDS YOU"); it must not make the sentence after it look open.
        for sent in wws_moot.sentences(BANNER.sub("", ln, count=1) if banner else ln):
            if not wws_moot.names_pending(sent):
                continue
            if banner or (wws_moot.OPEN.search(sent) and not ln.lstrip().startswith("```")):
                out += [k for k in wws_card.keys_in(sent) if k not in out]
    return out


def _when(v):
    if isinstance(v, (int, float)):
        return datetime.datetime.fromtimestamp(v / 1000, datetime.timezone.utc)
    return wws_moot.parse_ts(v)


def _turn_start(rows: list):
    last = max((i for i, r in enumerate(rows) if tr._is_prompt(r)), default=-1)
    return _when(rows[last].get("timestamp")) if last >= 0 else None


def evaluate(payload: dict) -> str | None:
    """Block reason, or None to let the turn end."""
    reply = tr.final_reply_text(tr.rows_for(payload))
    tickets = banner_tickets(reply)
    try:
        repeats = int(payload.get("moot_blocks") or 0)
    except (TypeError, ValueError):
        repeats = 0  # an unreadable count keeps the guard ON (more blocking), never off
    if repeats >= MAX_REPEAT:
        return None  # the only way out of the loop; a reply is never held forever
    start = _turn_start(tr.rows_for(payload))
    cards = [c for c in payload.get("cards") or [] if isinstance(c, dict)]
    # A card from before this turn's prompt says nothing about now; a card with no stamp (or a transcript with none) is accepted.
    fresh = [c for c in cards if start is None or c.get("at") is None or (_when(c["at"]) or start) >= start]
    moot, missing, unchecked = [], [], []
    for k in tickets:
        mine = [c for c in fresh if k in (c.get("tickets") or [])]
        if not mine:
            missing.append(k)
            continue
        dm = mine[-1].get("moot") or {}
        # Each ticket on its OWN assessment, never on the card-level verdict (which is BLOCK as soon as any ticket is moot).
        if k in (dm.get("tickets") or {}):
            moot.append((k, dm["tickets"][k]))
        elif k in (dm.get("unchecked") or {}):
            unchecked.append((k, dm["unchecked"][k]))
        elif k in (dm.get("open") or []) or k in (dm.get("clean") or []):
            continue  # assessed: an open decision tied to nothing that has happened, or no decision at all
        else:
            unchecked.append((k, dm.get("reason") or "the decision_moot receipt was not recorded"))
    if moot:
        return (PREFIX + "this reply puts " + "; ".join(k for k, _ in moot) + " to the operator as an open decision, but the where-we-stand "
                "decision_moot check says it may be moot: " + " | ".join(m for _, m in moot) + ". Read the state it is about, then re-send the reply "
                "without it under NEEDS YOU (say it is moot and dropped, or ask the operator only the part that is still open).")
    # NOT CHECKED and "no card" are held exactly like a BLOCK: a banner that names a pending decision goes out only once
    # decision_moot is PASS for that ticket. Claude Code's stop_hook_active is NOT consulted; MAX_REPEAT bounds the loop.
    if missing:
        shown = ", ".join(missing)
        return (PREFIX + f"this reply puts {shown} to the operator as a pending decision with no where-we-stand card this turn. Call "
                f'mcp__where-we-stand__lookup with {{"tickets": {missing!r}}}, which checks the decision against the article and run it is about, '
                "then re-send the reply using the card's facts.").replace("'", '"')
    if unchecked:
        return (PREFIX + "the card's decision_moot check is NOT CHECKED for " + "; ".join(f"{k} ({r})" for k, r in unchecked)
                + ". NOT CHECKED is not open: read the run and the article the decision is about, or say in the reply that you did not check.")
    return None


def _selftest() -> int:
    fails: list[str] = []
    total = [0]

    def ck(cond: bool, msg: str) -> None:
        total[0] += 1
        if not cond:
            fails.append(msg)

    ask = "> **NEEDS YOU:** LC-1755 — stan's ruling on the \"Most Durable\" heading (3 options). Pick one."
    ck(banner_tickets(ask) == ["LC-1755"], "the banner sentence names the ticket")
    ck(banner_tickets("LC-1755 needs a ruling.") == [], "no banner: nothing to guard")
    ck(banner_tickets("") == [] and banner_tickets(None) == [], "empty reply")
    ck(banner_tickets("> **NEEDS YOU:** LC-1 — approve the DDL.\n\nAlso LC-2 is awaiting operator ruling on colours. LC-3 shipped.") == ["LC-1", "LC-2"], "a decision sentence below the banner counts; a status sentence does not")
    ck(banner_tickets("> **NEEDS YOU:** LC-1755 — the Most Durable ruling is moot, dropped.") == [], "a sentence that says it is moot is not a pending decision")
    ck(banner_tickets("> **NEEDS YOU:** LC-5 — We no longer need the old path; this still needs stan's lock click.") == ["LC-5"], "a settled clause does not hide the ticket whose clause is still waiting (review blocker)")
    ck(banner_tickets("> **NEEDS YOU:** LC-6 — the old ruling is moot; LC-7 — still awaiting operator ruling.") == ["LC-6", "LC-7"], "a sentence with one open clause names every ticket in it (over-blocks LC-6 rather than miss LC-7)")
    ck(banner_tickets("\n\n> **NEEDS YOU:** LC-9 — pick.") == ["LC-9"], "leading blank lines are skipped")
    ck(banner_tickets("Intro line\n> **NEEDS YOU:** LC-9 — pick.") == [], "the banner must be the FIRST line")
    ck(banner_tickets("> **NEEDS YOU:** SHA-256 and UTF-8 need you.") == [], "keys of other projects are not tickets")

    def pay(reply, cards, **kw):
        rows = [{"type": "user", "timestamp": "2026-10-23T10:00:00Z", "message": {"role": "user", "content": "go"}},
                {"type": "assistant", "message": {"role": "assistant", "content": [{"type": "text", "text": reply}]}}]
        return {"transcript_rows": rows, "cards": cards, **kw}

    t0 = int(datetime.datetime(2026, 10, 23, 10, 5, tzinfo=datetime.timezone.utc).timestamp() * 1000)
    moot_card = {"topic": "LC-1755", "tickets": ["LC-1755"], "terms": [], "prs": [], "at": t0,
                 "moot": {"verdict": "BLOCK", "reason": "x", "tickets": {"LC-1755": "open decision on LC-1755 may be moot: best-kid-pet-friendly-sofas published 2026-10-21 after it was raised (comment 122959, 2026-10-10)"}}}
    why = evaluate(pay(ask, [moot_card]))
    ck(why is not None and why.startswith("[mod:where-we-stand] NEEDS YOU guard: ") and "LC-1755" in why and "published 2026-10-21" in why, "LC-1755 case: a NEEDS YOU reply listing the moot decision is blocked, with the evidence")
    ck(evaluate(pay(ask, [moot_card], stop_hook_active=True)) is not None, "the moot block is repeated on the re-sent reply: a stop_hook_active pass would let the same ask through")
    ck(evaluate(pay(ask, [moot_card], moot_blocks="garbage")) is not None, "an unreadable block count keeps the guard on")
    ck(evaluate(pay(ask, [moot_card], moot_blocks=2)) is not None and evaluate(pay(ask, [moot_card], moot_blocks=3)) is None, "the loop ends at MAX_REPEAT blocks")
    ck(evaluate(pay(ask, [moot_card], stop_hook_active=True, moot_blocks=3)) is None, "... but only MAX_REPEAT times a session, so it cannot loop")
    ck(evaluate(pay("> **NEEDS YOU:** LC-1755 — the Most Durable ruling is moot (article live 2026-10-21), dropped. Nothing for you.", [moot_card])) is None, "the honest rewrite passes")
    open_card = {**moot_card, "moot": {"verdict": "PASS", "reason": "1 open decision(s)", "tickets": {}, "open": ["LC-1755"], "clean": [], "unchecked": {}}}
    ck(evaluate(pay(ask, [open_card])) is None, "negative: an open decision with no published article or closed run is put to the operator")
    ck(evaluate(pay(ask, [])) is not None and "no where-we-stand card this turn" in evaluate(pay(ask, [])), "no card at all: blocked, naming the tool call")
    ck('mcp__where-we-stand__lookup with {"tickets": ["LC-1755"]}' in evaluate(pay(ask, [])), "the block says exactly which call produces the card")
    ck(evaluate(pay(ask, [], stop_hook_active=True)) is not None and evaluate(pay(ask, [], moot_blocks=3)) is None, "a missing card blocks on the re-send too, until MAX_REPEAT")
    old = {**open_card, "at": int(datetime.datetime(2026, 10, 23, 9, 0, tzinfo=datetime.timezone.utc).timestamp() * 1000)}
    ck(evaluate(pay(ask, [old])) is not None, "a card from before this turn's prompt does not count")
    ck(evaluate(pay(ask, [{**open_card, "at": None}])) is None, "a card with no stamp is accepted")
    nc = {**moot_card, "moot": {"verdict": "NOT CHECKED", "reason": "production was not read", "tickets": {}}}
    ck("NOT CHECKED" in (evaluate(pay(ask, [nc])) or "") and "NOT CHECKED" in (evaluate(pay(ask, [nc], stop_hook_active=True)) or "") and evaluate(pay(ask, [nc], moot_blocks=3)) is None, "NOT CHECKED is held like a BLOCK on the re-send, and is never read as open")
    ck("receipt was not recorded" in (evaluate(pay(ask, [{**moot_card, "moot": {"verdict": "NOT CHECKED"}}])) or ""), "NOT CHECKED with no reason still says why")
    ck(evaluate(pay(ask, [{**moot_card, "moot": None}])) is not None, "a card with no decision_moot receipt is NOT CHECKED, not a pass")
    ck(evaluate(pay("Built the module.", [moot_card])) is None, "a reply with no banner is not this guard's business")
    ck(evaluate({"transcript_rows": [], "cards": []}) is None, "no reply, nothing to check")
    ck(evaluate(pay(ask, [{"tickets": ["LC-1"], "at": t0, "moot": {"verdict": "PASS", "tickets": {}, "open": ["LC-1"]}}])) is not None, "a card for another ticket does not cover this one")
    two = "> **NEEDS YOU:** LC-1755 — ruling needed. LC-9 — approve the DDL."
    w2 = evaluate(pay(two, [moot_card, {"tickets": ["LC-9"], "at": t0, "moot": {"verdict": "PASS", "tickets": {}, "open": ["LC-9"]}}]))
    ck(w2 is not None and "LC-1755" in w2 and "LC-9" not in w2.split("operator as an open decision")[0].split("puts")[-1], "only the moot ticket is named; the open one is left alone")
    # review warning: one card, a moot ticket AND an open one; the banner names only the open one
    mixed_card = {"topic": "LC-1755 LC-9", "tickets": ["LC-1755", "LC-9"], "terms": [], "prs": [], "at": t0,
                  "moot": {"verdict": "BLOCK", "reason": "x", "tickets": {"LC-1755": "open decision on LC-1755 may be moot: x"}, "open": ["LC-9"], "clean": [], "unchecked": {}}}
    only9 = "> **NEEDS YOU:** LC-9 — approve the DDL."
    ck(evaluate(pay(only9, [mixed_card])) is None, "mixed card: a ticket assessed OPEN passes even though the card-level verdict is BLOCK")
    ck(evaluate(pay(ask, [mixed_card])) is not None and "LC-1755" in evaluate(pay(ask, [mixed_card])), "mixed card: the moot ticket is still blocked")
    both = evaluate(pay("> **NEEDS YOU:** LC-1755 — ruling needed. LC-9 — approve the DDL.", [mixed_card]))
    ck(both is not None and "LC-1755" in both and "NOT CHECKED" not in both, "mixed card: naming both blocks only for the moot one, and says nothing about LC-9")
    clean_card = {**mixed_card, "moot": {**mixed_card["moot"], "tickets": {}, "verdict": "PASS", "open": [], "clean": ["LC-9"]}}
    ck(evaluate(pay(only9, [clean_card])) is None, "a ticket with no open decision on the card passes")
    unk_card = {**mixed_card, "moot": {**mixed_card["moot"], "unchecked": {"LC-9": "comment history missing"}, "open": []}}
    w = evaluate(pay(only9, [unk_card]))
    ck(w is not None and "LC-9 (comment history missing)" in w, "a ticket the card marked unchecked is blocked with its own reason")
    ck(evaluate(pay("> **NEEDS YOU:** LC-77 — approve.", [mixed_card] + [{**mixed_card, "tickets": ["LC-77"]}])) is not None, "a ticket the card covers but never assessed is NOT CHECKED, never open")
    legacy = {**mixed_card, "moot": {"verdict": "PASS", "reason": "r", "tickets": {}}}
    ck(evaluate(pay(only9, [legacy])) is not None, "a card with no per-ticket data cannot vouch for a ticket (NOT CHECKED), whatever its card-level verdict")
    for f in fails:
        print("FAIL:", f)
    print(f"wws_needs_you selftest: {total[0] - len(fails)}/{total[0]} checks passed")
    return 1 if fails else 0


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        sys.exit(_selftest())
    print(__doc__)
