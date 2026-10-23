#!/usr/bin/env python3
"""wws_regression — the three historical cases, frozen, run in CI (LC-1893).

ONE JOB: replay REAL evidence (captured from production on 2026-10-22 by the lookup itself) through the
four checks and the card, and fail if the card no longer says what the case needs it to say. No network;
the fixtures in ../tests/fixtures/case-*.json are the evidence objects exactly as the lookup built them.

The cases are the three times a session got a status wrong while the answer sat in a place nobody read:

  case-a  catalog-ingest 546 WORKER_RESOURCE_LIMIT. Memory 30d884a3 (2026-07-04) had the root cause and
          PR #694; the alert-calibration article carries PR #770; the 40s sweep budget (PR #922) and the
          cron stagger came later. A session re-derived all of it from scratch (CLAUDE.md section 1).
  case-b  LC-1345 "mutation-check required". The title said so; the newest comment and the settled
          memories said it was removed from the required list and moot (CLAUDE.md section 1, the LC-1345 story).
  case-c  most-comfortable-couches publish state. Live since 2026-10-08, run 896655cd done (LC-1860);
          a session said "not published" from a stale ticket and its own task list.

  case-d  LC-1755 "Most Durable" ruling (LC-1907). Raised 2026-10-10 (comment 122959), still listed as open by a
          STATE comment on 2026-10-22, while best-kid-pet-friendly-sofas had been live since 2026-10-21. The
          decision_moot receipt must BLOCK and the card must show the conflict.

Each fixture carries its expectations (`expect`): strings the card must contain, strings it must not,
the verdict, and the receipts. A case with no fixture FAILS: a regression suite that finds nothing to
run must never read as a pass (the LC-1307 defect class).

Self-test: python3 wws_regression.py --selftest
"""
from __future__ import annotations

import copy
import glob
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import wws_card  # noqa: E402
import wws_checks  # noqa: E402

FIXTURES = os.path.join(HERE, "..", "tests", "fixtures")
REQUIRED = ("case-a", "case-b", "case-c", "case-d")


def build(fx: dict, evidence: dict | None = None) -> tuple:
    """(card, verdict, receipts) for a fixture, exactly as the lookup's `render` command builds them."""
    receipts = wws_checks.run_all(evidence if evidence is not None else fx["evidence"])
    terms = list(fx.get("terms") or []) + list(fx.get("tickets") or [])
    found = wws_card.conflicts({}, receipts)
    card = wws_card.render(fx["topic"], fx["today"], receipts, terms)
    return card, wws_card.verdict(receipts, found), receipts


def load_all() -> dict:
    out = {}
    for path in sorted(glob.glob(os.path.join(FIXTURES, "case-*.json"))):
        with open(path, encoding="utf-8") as fh:
            out[os.path.basename(path)[:-5]] = json.load(fh)
    return out


def _selftest() -> int:
    fails: list[str] = []
    total = [0]

    def ck(cond: bool, msg: str) -> None:
        total[0] += 1
        if not cond:
            fails.append(msg)

    cases = load_all()
    for need in REQUIRED:
        ck(need in cases, f"fixture {need}.json exists (a missing case is a failure, never a pass)")
    for name, fx in cases.items():
        card, verdict, receipts = build(fx)
        exp = fx.get("expect") or {}
        ck(bool(exp.get("contains")), f"{name}: declares what the card must say")
        for s in exp.get("contains") or []:
            ck(s in card, f"{name}: card contains {s!r}")
        for s in exp.get("not_contains") or []:
            ck(s not in card, f"{name}: card does not contain {s!r}")
        ck(verdict == exp.get("verdict"), f"{name}: verdict is {exp.get('verdict')!r} (got {verdict!r})")
        got = {r["source"]: r["verdict"] for r in receipts}
        for src, want in (exp.get("receipts") or {}).items():
            ck(got.get(src) == want, f"{name}: {src} receipt is {want} (got {got.get(src)})")
        ck(card.startswith(f"WHERE WE STAND — {fx['topic']} (as of {fx['today']})"), f"{name}: card header names the topic and the date")
        ck("RECEIPTS: " in card, f"{name}: card lists its receipts")

        # Counterfactuals: take away a source and the card must say so. A card that still reads 'verified'
        # without its GitHub and production reads is a card that confirms something is PRESENT, not EXAMINED.
        blind = copy.deepcopy(fx["evidence"])
        blind.pop("github", None)
        blind.pop("production", None)
        _, v2, r2 = build(fx, blind)
        ck(v2 != "verified", f"{name}: with GitHub and production unread the card is never 'verified'")
        ck(all(r["verdict"] == wws_checks.NOT_CHECKED for r in r2 if r["source"] in ("github", "production")), f"{name}: an unread source is NOT CHECKED")
        dark = copy.deepcopy(fx["evidence"])
        dark["jira"] = {"ok": False, "error": "timeout"}
        c3, v3, r3 = build(fx, dark)
        ck(v3 != "verified" and "jira NOT CHECKED" in c3, f"{name}: with Jira unread the card is never 'verified' and says which source was not read")
        # The card is built by code: every comment it quotes is a substring of what the API returned.
        for t in (fx["evidence"].get("jira") or {}).get("tickets") or []:
            body = " ".join(str((t.get("comment") or {}).get("body") or "").split())
            for line in card.split("\n"):
                if line.strip().startswith(f"- {t['key']} ["):
                    quoted = line.split('by ', 1)[-1].split(': "', 1)[-1].rsplit('"', 1)[0]
                    for piece in quoted.split(" [...] "):
                        piece = piece.replace(" [...]", "").strip()
                        ck(piece in body, f"{name}: the quoted comment on {t['key']} is verbatim ({piece[:40]!r})")
    # LC-1907 negative and variant fixtures, derived from the real case-d so they cannot drift from it.
    if "case-d" in cases:
        d = cases["case-d"]
        neg = copy.deepcopy(d["evidence"])
        neg["moot_production"].update(articles=[], runs=[])
        card, v, r = build(d, neg)
        got = {x["source"]: x["verdict"] for x in r}
        ck(got["decision_moot"] == wws_checks.PASS and v != "conflict" and "may be moot" not in card, "case-d negative: an open decision with no linked published article or closed run stays OPEN")
        done = copy.deepcopy(d["evidence"])
        done["moot_production"]["articles"] = []
        done["moot_production"]["runs"][0]["status"] = "done"
        card, v, _ = build(d, done)
        ck(v == "conflict" and "run f312eb7b done" in card, "case-d variant: run f312eb7b already done, no publish date read: still moot")
        early = copy.deepcopy(d["evidence"])
        early["moot_production"]["articles"][0]["webflow_last_published"] = "2026-10-05T00:00Z"
        ck(build(d, early)[1] != "conflict", "case-d negative: an article published BEFORE the decision was raised does not make it moot")
        unread = copy.deepcopy(d["evidence"])
        unread["moot_production"] = {"ok": False, "error": "timeout"}
        card, v, r = build(d, unread)
        ck({x["source"]: x["verdict"] for x in r}["decision_moot"] == wws_checks.NOT_CHECKED and v != "verified" and "decision_moot NOT CHECKED" in card, "case-d: with the moot read failed the card says NOT CHECKED, never OPEN")
        nohist = copy.deepcopy(d["evidence"])
        nohist["jira"]["tickets"][0]["comments"] = []
        card, v, r = build(d, nohist)
        ck({x["source"]: x["verdict"] for x in r}["decision_moot"] == wws_checks.NOT_CHECKED and "may be moot" not in card and v != "verified", "case-d: with the comment history missing the card says NOT CHECKED, never OPEN and never a guess from the newest comment")
        cut = copy.deepcopy(d["evidence"])
        cut["jira"]["tickets"][0]["comments_complete"] = False
        ck({x["source"]: x["verdict"] for x in build(d, cut)[2]}["decision_moot"] == wws_checks.NOT_CHECKED, "case-d: a history cut at the page limit is NOT CHECKED")
        resolved = copy.deepcopy(d["evidence"])
        resolved["jira"]["tickets"][0]["comment"] = {"id": "152003", "created": "2026-10-22T19:10:50.962-0500", "author": "BBM", "body": 'STATE (2026-10-23): the "Most Durable" ruling is MOOT, so it is removed from this ticket\'s open items.'}
        res = build(d, resolved)
        ck({x["source"]: x["verdict"] for x in res[2]}["decision_moot"] == wws_checks.PASS and res[1] != "conflict", "case-d: the live newest comment (152003) already resolved it: nothing to flag")
    for f in fails:
        print("FAIL:", f)
    print(f"wws_regression selftest: {total[0] - len(fails)}/{total[0]} checks passed")
    return 1 if fails else 0


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        sys.exit(_selftest())
    print(__doc__)
