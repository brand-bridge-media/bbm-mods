#!/usr/bin/env python3
"""wws_gate — the enforcement backstop for the where-we-stand card (LC-1893).

ONE JOB: read the reply a session is about to send and say whether it STATES a status it has no card
for. Mechanical, so it does not rely on the model remembering a rule:

  * a ticket key in a sentence with a status word (Done, In Progress, closed, open...);
  * a PR number in a sentence that says merged / open / closed / landed / live;
  * an article or job slug (three hyphenated words) in a sentence that says published / live /
    deployed / merged / shipped

is a CLAIM. A claim is COVERED when a card produced in this session names that ticket, PR or slug.
An uncovered claim blocks the turn's end ONCE (Claude Code sets stop_hook_active on the stop after a
block, and this always passes then, so it cannot loop). A sentence that says it did not check
("not checked", "unverified") is not a claim: that is the honest alternative to reading the source.

Why a gate. CLAUDE.md section 1 already says "read the ticket's newest comment before stating its status".
On 2026-09-14 and 2026-10-20 a session stated a status from a title and from its own stale task list.
The rule existed both times; nothing checked the reply.

Self-test: python3 wws_gate.py --selftest
"""
from __future__ import annotations

import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import transcript_reader as tr  # noqa: E402
import wws_card  # noqa: E402

STATUS = re.compile(r"\b(?:done|closed|resolved|in progress|to do|blocked|cancell?ed|won'?t (?:do|fix)|open|merged|shipped|live|published|deployed)\b", re.IGNORECASE)
PR_STATUS = re.compile(r"\b(?:merged|open|closed|landed|live|shipped|deployed)\b", re.IGNORECASE)
ARTICLE_STATUS = re.compile(r"\b(?:published|live|deployed|merged|shipped)\b", re.IGNORECASE)
SLUG = re.compile(r"\b[a-z0-9]+(?:-[a-z0-9]+){2,}\b")
HEDGE = re.compile(r"\b(?:not checked|unchecked|unverified|not verified|haven'?t (?:checked|verified|read)|have not (?:checked|verified|read)|cannot confirm|can'?t confirm)\b", re.IGNORECASE)
FENCE = re.compile(r"```.*?```", re.DOTALL)
MAX_SHOWN = 5


def claims(reply: str) -> list:
    """Subjects the reply states a status for, in order, as `LC-1`, `#694` or a slug."""
    text = FENCE.sub(" ", str(reply or ""))
    out: list = []
    for line in text.split("\n"):
        if line.lstrip().startswith(">") or "[mod:where-we-stand]" in line or line.startswith("WHERE WE STAND"):
            continue
        for sent in re.split(r"(?<=[.!?])\s+", line):
            if not sent.strip() or HEDGE.search(sent):
                continue
            found: list = []
            if STATUS.search(sent):
                found += wws_card.keys_in(sent)
            if PR_STATUS.search(sent):
                found += [f"#{n}" for n in wws_card.pr_refs(sent)]
            if ARTICLE_STATUS.search(sent):
                found += [m for m in SLUG.findall(sent) if not re.search(r"\d{4}-\d{2}-\d{2}", m) and m not in wws_card.OTHER_REPOS]
            for f in found:
                if f not in out:
                    out.append(f)
    return out


def _in_topic(subject: str, topic: str) -> bool:
    """The subject as a WHOLE token of the topic: `LC-1` is not in `LC-1345`, `catalog` is not in `catalog-ingest`."""
    return re.search(r"(?<![A-Za-z0-9-])" + re.escape(subject) + r"(?![A-Za-z0-9-])", topic, re.IGNORECASE) is not None


def covered(subject: str, cards: list) -> bool:
    for c in cards or []:
        if subject.startswith("#"):
            if subject[1:].isdigit() and int(subject[1:]) in [int(n) for n in c.get("prs") or [] if str(n).isdigit()]:
                return True
        elif subject in (c.get("tickets") or []) or subject in (c.get("terms") or []) or _in_topic(subject, str(c.get("topic") or "")):
            return True
    return False


def evaluate(payload: dict) -> str | None:
    """Block reason, or None to let the turn end."""
    if payload.get("stop_hook_active"):
        return None
    reply = tr.final_reply_text(tr.rows_for(payload))
    missing = [s for s in claims(reply) if not covered(s, payload.get("cards") or [])]
    if not missing:
        return None
    shown = ", ".join(missing[:MAX_SHOWN]) + (f" (+{len(missing) - MAX_SHOWN} more)" if len(missing) > MAX_SHOWN else "")
    tickets = [m for m in missing if re.fullmatch(r"[A-Z][A-Z0-9]+-\d+", m)]
    terms = [m for m in missing if not m.startswith("#") and m not in tickets]
    return (f"[mod:where-we-stand] This reply states a status with no where-we-stand card for: {shown}. A title, a census line or "
            "an earlier turn is not a read of the source. Call the tool mcp__where-we-stand__lookup with "
            f"{{\"tickets\": {tickets!r}, \"terms\": {terms!r}}} (add \"kind\": \"article-status\" for a slug), or read the Jira issue / query the "
            "surface, which injects the card. Then re-send the reply using the card's facts and dates, or mark the claim 'not checked'.").replace("'", '"')


def _selftest() -> int:
    fails: list[str] = []
    total = [0]

    def ck(cond: bool, msg: str) -> None:
        total[0] += 1
        if not cond:
            fails.append(msg)

    ck(claims("LC-1345 is Done.") == ["LC-1345"], "a ticket with a status word is a claim")
    ck(claims("I read LC-1345 yesterday.") == [], "a ticket with no status word is not")
    ck(claims("The ticket is Done.") == [], "a status word with no ticket key is not")
    ck(claims("SHA-256 is open source and UTF-8 is done") == [], "keys of other projects are not tickets")
    ck(claims("PR #694 merged on Thursday.") == ["#694"], "a PR with a merge word is a claim")
    ck(claims("See #694 for details.") == [], "a PR reference with no status word is not")
    ck(claims("bbm-refresh-agent #155 is merged.") == [], "another repo's PR number is not ours")
    ck(claims("most-comfortable-couches is live.") == ["most-comfortable-couches"], "a three-word slug with 'live' is a claim")
    ck(claims("two-word is live.") == [], "a two-word hyphenation is not a slug")
    ck(claims("It was published 2026-10-08-ish.") == [], "a date is not a slug")
    ck(claims("The catalog-ingest function is deployed.") == [], "catalog-ingest has two words: not a slug claim (the ticket and PR rules cover jobs)")
    ck(claims("LC-1345 is Done, but that is not checked.") == [], "a sentence that says it did not check is not a claim")
    ck(claims("LC-1345 is Done (unverified).") == [], "unverified is the honest alternative")
    ck(claims("```\nLC-1345 is Done\n```") == [], "code fences are skipped")
    ck(claims("> LC-1345 is Done\nWHERE WE STAND — x\n[mod:where-we-stand] LC-9 is Done") == [], "quoted text and the card itself are skipped")
    ck(claims("LC-1 is Done. LC-2 is Open. LC-1 is Done again.") == ["LC-1", "LC-2"], "subjects are deduplicated, in order")
    ck(claims("") == [] and claims(None) == [], "empty reply")

    cards = [{"tickets": ["LC-1345"], "terms": ["catalog-ingest"], "prs": [694, "770"], "topic": "most-comfortable-couches publish state"}]
    ck(covered("LC-1345", cards) and not covered("LC-1", cards), "a ticket is covered by a card that read it")
    ck(covered("#694", cards) and covered("#770", cards) and not covered("#1", cards), "a PR is covered by a card that checked it")
    ck(covered("most-comfortable-couches", cards) and covered("catalog-ingest", cards) and not covered("other-slug-here", cards), "a slug is covered by terms or topic")
    ck(not covered("LC-1", []) and not covered("#1", None), "no cards cover nothing")
    ck(not covered("LC-1", [{"tickets": ["LC-1345"], "terms": [], "prs": [], "topic": "LC-1345"}]), "a card for LC-1345 does not cover a claim about LC-1 (substring, not token)")
    ck(not covered("catalog-ingest", [{"tickets": [], "terms": [], "prs": [], "topic": "catalog-ingest-v2 notes"}]) and covered("catalog-ingest", [{"topic": "diagnosis of catalog-ingest, 546"}]), "a slug is covered by a whole token of the topic, not by a longer name that contains it")
    ck(covered("LC-1345", [{"topic": "x lc-1345"}]) and not covered("LC-13", [{"topic": "LC-1345"}]) and not covered("LC-1345", [{"topic": "LC-13456"}]), "token boundaries hold at both ends, case-insensitively")
    ck(not covered("#abc", cards), "a malformed PR subject is not covered")

    rows = [{"type": "user", "message": {"role": "user", "content": "q"}},
            {"type": "assistant", "message": {"role": "assistant", "content": [{"type": "text", "text": "LC-1345 is Done and PR #694 merged. most-comfortable-couches is live."}]}}]
    pay = {"transcript_rows": rows, "cards": []}
    why = evaluate(pay)
    ck(why is not None and why.startswith("[mod:where-we-stand] ") and "LC-1345, #694, most-comfortable-couches" in why, "an uncovered reply is blocked, naming every subject")
    ck('"tickets": ["LC-1345"]' in why and '"terms": ["most-comfortable-couches"]' in why, "the block says exactly which tool call produces the card")
    ck(evaluate({**pay, "stop_hook_active": True}) is None, "the stop after a block always passes")
    ck(evaluate({**pay, "cards": [{"tickets": ["LC-1345"], "prs": [694], "terms": ["most-comfortable-couches"]}]}) is None, "a covered reply passes")
    part = evaluate({**pay, "cards": [{"tickets": ["LC-1345"], "prs": [], "terms": []}]})
    ck(part is not None and "#694, most-comfortable-couches" in part and "LC-1345" not in part.split("card for:")[1].split(".")[0], "only the uncovered subjects are named")
    quiet = [{"type": "user", "message": {"role": "user", "content": "q"}}, {"type": "assistant", "message": {"role": "assistant", "content": [{"type": "text", "text": "Built the module and ran the tests."}]}}]
    ck(evaluate({"transcript_rows": quiet, "cards": []}) is None, "a reply with no status claim passes")
    ck(evaluate({"transcript_rows": [], "cards": []}) is None, "no reply, nothing to check")
    many = [{"type": "user", "message": {"role": "user", "content": "q"}}, {"type": "assistant", "message": {"role": "assistant", "content": [{"type": "text", "text": " ".join(f"LC-{i} is Done." for i in range(1, 9))}]}}]
    big = evaluate({"transcript_rows": many, "cards": []})
    ck(big is not None and "(+3 more)" in big and "LC-5" in big and "LC-6" not in big.split("card for:")[1].split(".")[0], "a long list is capped")
    for f in fails:
        print("FAIL:", f)
    print(f"wws_gate selftest: {total[0] - len(fails)}/{total[0]} checks passed")
    return 1 if fails else 0


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        sys.exit(_selftest())
    print(__doc__)
