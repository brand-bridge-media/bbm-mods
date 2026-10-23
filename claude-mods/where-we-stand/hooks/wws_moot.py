#!/usr/bin/env python3
"""wws_moot — is an open decision about something that has already happened? (LC-1907)

ONE JOB: given a ticket's comments and the production rows (refresh runs, articles) that the ticket
names, say whether the decision the newest comment still calls open is MOOT. It reads nothing and
fetches nothing; the where-we-stand card, the LC-1074 status generator and the NEEDS YOU guard all
import THIS function, so the three can never disagree about what "moot" means.

Why it exists. LC-1755 carried "stan's ruling on the Most Durable heading" from 2026-10-10. The pet & kid
article went live on 2026-10-21 without that award; on 2026-10-22 a STATE comment copied the item
forward unchecked, and on 2026-10-23 it was put to the operator as an open decision. The card read the
newest comment correctly; nothing compared the decision with the production state it was about.

The test, per ticket:
  1. OPEN ITEM. A sentence in the NEWEST comment that asks for a ruling / decision / the operator and
     does not also say it is settled (moot, ruled, decided, resolved...).
  2. RAISED. The date the decision was first put: the oldest comment that carries the same quoted
     subject ("Most Durable"). A STATE comment that copies the item forward must not reset the clock.
     No quoted subject, or no older comment with it: the newest comment's own date.
  3. REFERENCES. Run ids (8 hex) and article slugs named in the newest comment or the comment that
     raised it, plus every refresh run whose `jira_keys` holds the ticket, plus the article each run is for.
  4. MOOT when a referenced run is done / abandoned (closed after RAISED) or a referenced article's
     `webflow_last_published` is later than RAISED. Otherwise OPEN.

Verdicts use the repo's vocabulary: PASS (nothing moot; OPEN items are listed), BLOCK (at least one item
is moot), NOT CHECKED (a reference could not be looked up, or the source was not read). NOT CHECKED never
counts as a pass.

Self-test: python3 wws_moot.py --selftest
"""
from __future__ import annotations

import datetime
import re
import sys

PASS, BLOCK, NOT_CHECKED = "PASS", "BLOCK", "NOT CHECKED"
SOURCE = "decision_moot"
CLOSED_RUN = frozenset({"done", "abandoned", "completed"})
COMMENT_PAGE = 100  # comments the mod reads per ticket (newest first); a longer thread may hide the comment that raised a decision
MAX_REFS = 6  # slugs / runs looked up per ticket: one production query, bounded

# A sentence is an open decision when it asks for a ruling or the operator ...
OPEN = re.compile(
    r"\boperator(?:.s)?\s+(?:open\s+)?(?:ruling|decision)"
    r"|\bstan.?s\s+(?:open\s+)?(?:ruling|decision)"
    r"|\bopen\b[^.\n]{0,40}\b(?:ruling|decision)\b"
    r"|\b(?:ruling|decision)\s+(?:on|needed|required|pending)\b"
    r"|\bawaiting\s+(?:the\s+)?(?:operator|stan|ruling|decision|approval|go-ahead)"
    r"|\bneeds?\s+(?:the\s+)?(?:operator|stan|you)\b"
    r"|\bwaiting\s+(?:on|for)\s+(?:the\s+)?(?:operator|stan)\b"
    r"|\bpending\s+(?:the\s+)?(?:operator|stan)\b",
    re.IGNORECASE,
)
# ... and does not also say it is over. Judged PER CLAUSE: a sentence that settles one thing and leaves another waiting ("we no
# longer need the old path; this still needs the operator's click") is still waiting. Three review rounds on the same shape
# (a bare "already", a dated "awaiting operator decision (2026-10-22)", a negation that swallowed the rest of the sentence) are why.
SETTLED_WORD = re.compile(
    r"\b(?:moot|ruled|decided|settled|resolved|answered|withdrawn|superseded)\b"
    r"|\balready\s+(?:happened|done|decided|shipped|merged|published|live|closed|resolved|ruled)\b",
    re.IGNORECASE,
)
# A decision RECORDED with its date ("operator decision (2026-10-22): ..."), "by ruling", "rulings below" ...
RECORDED = re.compile(r"\b(?:ruling|decision)s?\W{0,3}\(?\d{4}-\d{2}-\d{2}|\bby (?:a )?ruling\b|\brulings?\s+below\b", re.IGNORECASE)
# ... unless the clause is framed as waiting for it ("awaiting operator decision (2026-10-22) on the colour").
AWAITING = re.compile(r"\b(?:awaiting|pending|waiting\s+(?:on|for)|needs?|needed|open)\b[^.;]{0,40}\b(?:ruling|decision)s?\b", re.IGNORECASE)
# A negation bound to the need ("does not need", "I do not think this needs"); anchored to the verb, so "NOT merged, needs ..." is not caught.
NEGATED = re.compile(
    r"\b(?:do(?:es)?\s+not|don'?t|doesn'?t|no\s+longer)\s+(?:\w+\s+){0,4}?(?:need|needs|require|requires)\b"
    r"|\bnever\s+(?:need|needs|require|requires)\b"
    r"|\bnot\s+(?:needed|required)\b",
    re.IGNORECASE,
)
NEED_CUE = re.compile(r"\b(?:needs?|awaiting|waiting|pending)\b", re.IGNORECASE)
# A decision named AFTER a settled word is still open when the clause says it is outstanding ("the old path is resolved and a
# decision on the colour remains"); "the decision on X was made / is closed" says nothing of the kind.
OUTSTANDING = re.compile(r"\b(?:remains?|remaining|still|outstanding|unresolved|undecided|unanswered|open|pending)\b", re.IGNORECASE)
CLAUSES = re.compile(r";|\s[\u2014\u2013]\s|\sbut\s", re.IGNORECASE)


def clauses(sentence) -> list:
    return [c for c in CLAUSES.split(str(sentence or "")) if c.strip()]


def clause_settled(c: str) -> bool:
    """The clause carries a settled marker (a settled word, a negated need, a recorded decision not framed as awaited)."""
    return bool(SETTLED_WORD.search(c) or NEGATED.search(c) or (RECORDED.search(c) and not AWAITING.search(c)))


def clause_open(c: str) -> bool:
    """The clause still asks for something. A settled word ("moot", "decided") ends it. Otherwise it is open when some open cue is
    NOT covered by a recorded or negated phrase: the cue is explained away only if it overlaps that phrase's own text, so
    "Operator decision (2026-10-22) was premature and this still needs <name>'s click" keeps its second cue and stays open."""
    words = list(SETTLED_WORD.finditer(c))
    covers = [m.span() for m in NEGATED.finditer(c)]
    if not AWAITING.search(c):
        covers += [m.span() for m in RECORDED.finditer(c)]
    end = words[-1].end() if words else -1
    for m in OPEN.finditer(c):
        if any(m.start() < e and s < m.end() for s, e in covers):
            continue
        # A settled word ends the clause, but never hides a need cue (needs, awaiting, waiting, pending) wherever it sits
        # ("this needs <name> and the old path is resolved"); a decision named AFTER the word is open only when marked outstanding.
        if not words or NEED_CUE.search(m.group(0)) or (m.start() >= end and OUTSTANDING.search(c[m.end():])):
            return True
    return False


def names_pending(sentence) -> bool:
    """A sentence that puts something to the operator, read as a whole (the NEEDS YOU banner): some clause is open and not settled,
    or the sentence says nothing settled at all ("LC-9 - approve the DDL"). It is NOT pending when its only settled-ness is
    all there is ("LC-1755 - the ruling is moot, dropped"). A settled clause never hides an open one beside it."""
    cs = clauses(sentence)
    return any(clause_open(c) for c in cs) or not any(clause_settled(c) for c in cs)


QUOTED = re.compile(r"[\"“]([^\"“”\n]{4,60})[\"”]")
RUN_ID = re.compile(r"(?<![0-9a-zA-Z])(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{8}(?![0-9a-zA-Z])")
SLUG = re.compile(r"(?<![A-Za-z0-9-])[a-z0-9]+(?:-[a-z0-9]+){2,}(?![A-Za-z0-9-])")
DATE = re.compile(r"\d{4}-\d{2}-\d{2}")
NOT_SLUGS = frozenset({"bbm-refresh-agent", "bbm-infrastructure", "bbm-guardrails", "claude-skills", "bbm-content", "bbm-mods"})


def parse_ts(s):
    """A datetime (UTC-aware) from Jira's `2026-10-22T17:53:27.834-0500`, Postgres' `2026-10-21 17:01:57.459+00`,
    or `...Z`; None when unreadable. A bare date is midnight UTC."""
    t = str(s or "").strip().replace(" ", "T", 1)
    t = re.sub(r"Z$", "+00:00", t)
    t = re.sub(r"([+-]\d{2})(\d{2})$", r"\1:\2", t)
    t = re.sub(r"([+-]\d{2})$", r"\1:00", t) if re.search(r"T.*[+-]\d{2}$", t) else t
    t = re.sub(r"\.(\d{6})\d+", r".\1", t)
    try:
        d = datetime.datetime.fromisoformat(t)
    except ValueError:
        return None
    return d.astimezone(datetime.timezone.utc) if d.tzinfo else d.replace(tzinfo=datetime.timezone.utc)


def _day(ts) -> str:
    """The UTC calendar day of a timestamp (Jira stamps carry the author's offset; the card compares in UTC)."""
    t = parse_ts(ts)
    return t.strftime("%Y-%m-%d") if t else str(ts or "")[:10]


def sentences(body) -> list:
    text = re.sub(r"[*`]+", "", str(body or ""))
    return [s.strip() for s in re.split(r"(?<=[.!?])\s+|\n+", text) if s.strip()]


def open_items(body) -> list:
    """Sentences of one comment that put a decision to someone and do not say it is settled."""
    return [s for s in sentences(body) if any(clause_open(c) for c in clauses(s))]


def phrases(text) -> list:
    return [p.strip().lower() for p in QUOTED.findall(str(text or ""))]


def refs_in(text) -> dict:
    s = str(text or "")
    runs = list(dict.fromkeys(RUN_ID.findall(s)))
    slugs = [x for x in dict.fromkeys(SLUG.findall(s)) if x not in NOT_SLUGS and not DATE.search(x)]
    return {"runs": runs, "slugs": slugs}


def profile(c: dict) -> dict:
    """A comment as the three small lists the matcher needs. A comment read in full (generator) is profiled
    from its body; one read by the mod's SQL already carries `q` (quoted phrases), `r` (run ids), `s` (slug-like tokens)."""
    if c.get("body") is not None:
        r = refs_in(c["body"])
        return {"id": c.get("id"), "created": c.get("created"), "q": phrases(c["body"]), "r": r["runs"], "s": r["slugs"]}
    return {"id": c.get("id"), "created": c.get("created"), "q": [str(x).lower() for x in c.get("q") or []],
            "r": [x for x in c.get("r") or [] if RUN_ID.fullmatch(str(x))],
            "s": [x for x in c.get("s") or [] if x not in NOT_SLUGS and not DATE.search(str(x))]}


def opener(item: str, comments: list):
    """The oldest comment carrying one of the item's quoted subjects, or None. `comments` is any order."""
    want = set(phrases(item))
    hits = [profile(c) for c in comments or []]
    hits = [h for h in hits if want & set(h["q"]) and parse_ts(h["created"])]
    return min(hits, key=lambda h: parse_ts(h["created"])) if hits else None


def raised_at(item: str, newest: dict, comments: list) -> tuple:
    """(timestamp string, comment profile or None). The oldest of: the opening comment, the newest comment."""
    op = opener(item, comments)
    if op and parse_ts(op["created"]) <= (parse_ts(newest.get("created")) or parse_ts(op["created"])):
        return op["created"], op
    return newest.get("created"), None


def refs_for(newest: dict, comments: list):
    """(items, opening profile, {"runs": [...], "slugs": [...]}) -- what the production read must look up."""
    items = open_items(newest.get("body"))
    if not items:
        return [], None, {"runs": [], "slugs": []}
    _, op = raised_at(items[0], newest, comments)
    own = refs_in(newest.get("body"))
    runs = list(dict.fromkeys(own["runs"] + (op["r"] if op else [])))[:MAX_REFS]
    slugs = list(dict.fromkeys(own["slugs"] + (op["s"] if op else [])))[:MAX_REFS]
    return items, op, {"runs": runs, "slugs": slugs}


def history_complete(total, profiles) -> bool:
    """The comment page covers the ticket's whole thread: `total` is a real count (an int, not a bool, not missing, not a
    string), at least one comment exists, it fits the page, and the page holds at least `total` comments. A missing or null
    total is an unknown, never zero, so it can never read as complete."""
    return (isinstance(total, int) and not isinstance(total, bool) and 0 < total <= COMMENT_PAGE
            and isinstance(profiles, list) and len(profiles) >= total)


def history_ok(newest: dict, comments: list, complete: bool = True) -> bool:
    """The comment history behind a decision was read in full: not cut at the page limit, and it contains the newest comment
    itself (a history that does not is a failed or partial read, whatever else it holds)."""
    return bool(complete) and any(str(c.get("id")) == str(newest.get("id")) for c in comments or [])


def assess(key: str, newest: dict, comments: list, runs: list, articles: list, complete: bool = True) -> dict:
    """The one test. `runs`: [{id, article_slug, status, updated_at, jira_keys}]; `articles`: [{slug, webflow_last_published}].
    `complete`: the comment history was not cut short. Without the history that raised a decision, the newest comment (which may
    restate it long after) must never stand in for it: the answer is UNKNOWN, i.e. NOT CHECKED."""
    items, op, refs = refs_for(newest or {}, comments)
    if not items:
        return {"ticket": key, "state": "none", "item": None, "raised": None, "evidence": [], "message": ""}
    if not history_ok(newest or {}, comments, complete):
        return {"ticket": key, "state": "UNKNOWN", "item": items[0], "raised": None, "opened_by": None, "evidence": [], "message": "", "refs": refs,
                "unknown": ["comment history missing or incomplete: the comment that raised the decision cannot be found"]}
    raised, _ = raised_at(items[0], newest, comments)
    # A date the sentence itself gives ("on 2026-10-10") can only move the clock earlier.
    r_ts = parse_ts(raised)
    for d in DATE.findall(items[0]):
        t = parse_ts(d)
        if t and r_ts and t < r_ts:
            raised, r_ts = d, t
    mine = [r for r in runs or [] if key in (r.get("jira_keys") or []) or any(str(r.get("id") or "").startswith(i) for i in refs["runs"])]
    slugs = set(refs["slugs"]) | {str(r.get("article_slug")) for r in mine if r.get("article_slug")}
    evidence, unknown = [], []
    # Two timestamps are compared or nothing is: a date that cannot be read is NOT CHECKED, never evidence either way.
    for a in articles or []:
        if str(a.get("slug")) not in slugs or not a.get("webflow_last_published"):
            continue  # not referenced, or never published: nothing happened to it
        pub = parse_ts(a["webflow_last_published"])
        if pub is None or r_ts is None:
            unknown.append(f"{a['slug']}: publish date or raise date unreadable")
        elif pub > r_ts:
            evidence.append(f"{a['slug']} published {_day(a['webflow_last_published'])}")
    for r in mine:
        if str(r.get("status")) not in CLOSED_RUN:
            continue
        up = parse_ts(r.get("updated_at"))
        if up is None or r_ts is None:
            unknown.append(f"run {str(r.get('id'))[:8]} {r['status']}: closing time or raise date unreadable")
        elif up > r_ts:
            evidence.append(f"run {str(r.get('id'))[:8]} {r['status']}")
    when = f" ({'comment ' + str(op['id']) + ', ' if op else ''}{_day(raised)})"
    msg = f"open decision on {key} may be moot: {' / '.join(evidence)} after it was raised{when}" if evidence else ""
    return {"ticket": key, "state": "MOOT" if evidence else ("UNKNOWN" if unknown else "OPEN"), "item": items[0], "raised": raised,
            "opened_by": op["id"] if op else None, "evidence": evidence, "unknown": unknown, "message": msg, "refs": refs}


def tag(a: dict) -> str:
    """The generator's tag for one assessed item."""
    if a["state"] == "UNKNOWN":
        return f"NOT CHECKED ({'; '.join(a['unknown'])})"
    return f"LIKELY MOOT ({'; '.join(a['evidence'])})" if a["state"] == "MOOT" else "OPEN"


def receipt(verdict: str, reason: str, facts=None, applicable: bool = True) -> dict:
    return {"source": SOURCE, "verdict": verdict, "applicable": applicable, "reason": reason, "facts": facts or {}}


def moot_read_ok(ev) -> bool:
    """The moot read is usable only when it says so AND carries both row lists. A missing slice, ok:false, {} and a wrong
    shape are all the same thing: no answer."""
    return isinstance(ev, dict) and ev.get("ok") is True and isinstance(ev.get("articles"), list) and isinstance(ev.get("runs"), list)


def _merge(moot_ev, topic_ev) -> tuple:
    """Articles and runs by key, from the moot read and (when it was read fine) the topic's own production slice."""
    arts, runs = {}, {}
    for p in (topic_ev, moot_ev):
        if not moot_read_ok(p):
            continue  # only a well-formed read contributes rows
        for a in p.get("articles") or []:
            arts[str(a.get("slug"))] = a
        for r in p.get("runs") or []:
            runs[str(r.get("id"))] = r
    return list(arts.values()), list(runs.values())


def check(jira_ev, moot_ev, topic_ev=None) -> dict:
    """The card's receipt. `jira_ev`: the jira slice (each ticket carries `comments`: profiles from the SQL, and
    `comments_complete`). `moot_ev`: the moot read of production (runs and articles the decision names). `topic_ev`: the
    topic's own production slice, optional extra rows.

    ONE rule for missing data, because three review rounds found the same fail-open in three places: if a ticket has an
    open decision and ANYTHING needed to judge it is absent (the ticket, its newest comment or body, its history, the moot
    read), the receipt is NOT CHECKED. PASS is reachable only by reading everything and finding nothing moot."""
    if not isinstance(jira_ev, dict) or not jira_ev.get("ok"):
        err = jira_ev.get("error") if isinstance(jira_ev, dict) else None
        return receipt(NOT_CHECKED, f"Jira not read: {err or 'no evidence'}", applicable=False)
    tickets = jira_ev.get("tickets") or []
    if not tickets:
        return receipt(NOT_CHECKED, "no ticket named by the topic or the sources", applicable=False)
    unread, pending, clean, why_by = [], [], [], {}

    def unread_(key, why):
        unread.append(f"{key}: {why}")
        why_by[key] = why

    for t in tickets:
        key = str(t.get("key") or "?")
        c = t.get("comment") or {}
        if t.get("error"):
            unread_(key, str(t["error"]))
        elif not c.get("created"):
            if t.get("total") != 0:  # an unknown total is not zero
                unread_(key, "newest comment not read")
            else:
                clean.append(key)  # no comments at all: no decision to be stale
        elif c.get("body") is None:
            unread_(key, "newest comment body not read")
        else:
            pending.append(t)
    arts, runs = _merge(moot_ev, topic_ev)
    read_ok = moot_read_ok(moot_ev)
    moot, open_ = [], []
    for t in pending:
        key = str(t["key"])
        newest = dict(t["comment"])
        items, _, refs = refs_for(newest, t.get("comments") or [])
        if not items:
            clean.append(key)
            continue
        if not read_ok:
            # Even a decision that names nothing may belong to a run through refresh_runs.jira_keys, which only production knows.
            why = (moot_ev or {}).get("error") if isinstance(moot_ev, dict) else None
            unread_(key, f"has an open decision but the production read for it is missing or failed ({why or 'no answer'}; refs: {', '.join(refs['runs'] + refs['slugs']) or 'none named'})")
            continue
        a = assess(key, newest, t.get("comments") or [], runs, arts, t.get("comments_complete") is True)
        if a["state"] == "UNKNOWN":
            unread_(key, "; ".join(a["unknown"]))
            continue
        (moot if a["state"] == "MOOT" else open_).append(a)
    # Per ticket, never per card: the NEEDS YOU guard reads these to decide each ticket on its own state.
    facts = {"moot": moot, "open": open_, "clean": clean, "unchecked": why_by}
    if moot:
        return receipt(BLOCK, "; ".join(m["message"] for m in moot) + ("; " + "; ".join(unread) if unread else ""), facts)
    if unread:
        return receipt(NOT_CHECKED, "; ".join(unread), facts)
    if open_:
        return receipt(PASS, f"{len(open_)} open decision(s), none tied to a published article or closed run: " + "; ".join(a["ticket"] for a in open_), facts)
    if not pending:
        return receipt(NOT_CHECKED, "no ticket with a comment to assess", applicable=False)
    return receipt(PASS, f"no open-decision language in the newest comment of {len(pending)} ticket(s)", facts)


def _selftest() -> int:
    fails: list[str] = []
    total = [0]

    def ck(cond: bool, msg: str) -> None:
        total[0] += 1
        if not cond:
            fails.append(msg)

    # --- timestamps in the three shapes the sources use
    ck(parse_ts("2026-10-22T17:53:27.834-0500") == datetime.datetime(2026, 10, 22, 22, 53, 27, 834000, tzinfo=datetime.timezone.utc), "Jira -0500 offset")
    ck(parse_ts("2026-10-21 17:01:57.459+00") == datetime.datetime(2026, 10, 21, 17, 1, 57, 459000, tzinfo=datetime.timezone.utc), "Postgres +00")
    ck(parse_ts("2026-10-21T17:01Z") == datetime.datetime(2026, 10, 21, 17, 1, tzinfo=datetime.timezone.utc), "Z suffix")
    ck(parse_ts("2026-10-10") == datetime.datetime(2026, 10, 10, tzinfo=datetime.timezone.utc), "a bare date is midnight UTC")
    ck(parse_ts("") is None and parse_ts(None) is None and parse_ts("soon") is None, "unreadable is None")

    # --- open-decision language
    real = 'Remaining: a live v2_s2b research session end to end on a real run, and the operator\'s open "Most Durable" ruling.'
    ck(open_items(real) == [real], "the real LC-1755 sentence is an open item")
    ck(open_items("**Remaining:** stan's ruling on the \"Most Durable\" heading (3 options), stan's picks.") != [], "stan's ruling on X")
    ck(open_items("NEEDS YOU: pick one.") != [] and open_items("Awaiting operator approval for the DDL.") != [], "needs you / awaiting operator")
    ck(open_items("Waiting on the operator.") != [] and open_items("decision needed on the heading") != [], "waiting on the operator / decision needed")
    ck(open_items('the "Most Durable" ruling is MOOT, so it is removed.') == [], "a sentence that says moot is not open")
    ck(open_items("stan's ruling on the heading was decided on 2026-10-12.") == [], "a decided ruling is not open")
    ck(open_items("**Decision (the operator, 2026-10-09):** option A, build all four.") == [], "a recorded decision is not an open one")
    ck(open_items("Awaiting CI on the PR.") == [], "awaiting CI is not a decision for the operator")
    ck(open_items("") == [] and open_items(None) == [], "empty body")

    # --- references
    r = refs_in("run f312eb7b of best-kid-pet-friendly-sofas, see bbm-refresh-agent and 2026-10-10-ish and 20261010")
    ck(r == {"runs": ["f312eb7b"], "slugs": ["best-kid-pet-friendly-sofas"]}, "run id and slug found; repo names, dates and all-digit tokens are not")
    ck(refs_in("deadbeef")["runs"] == [] and refs_in("abcdef12")["runs"] == ["abcdef12"], "an 8-hex word with no digit is not a run id")
    ck(refs_in(None) == {"runs": [], "slugs": []}, "no text, no refs")

    # --- the LC-1755 regression: real comment ids, dates and production values (read 2026-10-23)
    c122959 = {"id": "122959", "created": "2026-10-09T20:11:20.746-0500", "q": ["most durable"], "r": ["f312eb7b"], "s": ["run-heading-research"]}
    c122964 = {"id": "122964", "created": "2026-10-09T20:13:26.614-0500", "q": ["most durable"], "r": [], "s": []}
    c121832 = {"id": "121832", "created": "2026-10-09T12:09:51.165-0500", "q": [], "r": [], "s": []}
    newest = {"id": "151900", "created": "2026-10-22T17:53:27.834-0500",
              "body": 'STATE (2026-10-22): OPEN. The brand-by-pillar research is shipped (#1647, #1655), and 95 findings are seeded. Remaining: a live v2_s2b research session end to end on a real run, drafting-context on a real run, and the operator\'s open "Most Durable" ruling.'}
    c151900 = {"id": "151900", "created": "2026-10-22T17:53:27.834-0500", "q": ["most durable"], "r": [], "s": []}
    comments = [c121832, c122959, c122964, c151900]
    art = {"slug": "best-kid-pet-friendly-sofas", "status": "published", "webflow_last_published": "2026-10-21T17:01:57Z"}
    run_blocked = {"id": "f312eb7b-9b8a-49c0-8c2e-00446c76f199", "article_slug": "best-kid-pet-friendly-sofas", "status": "blocked", "updated_at": "2026-10-22T22:52:08Z", "jira_keys": []}
    a = assess("LC-1755", newest, comments, [run_blocked], [art])
    ck(a["state"] == "MOOT" and a["opened_by"] == "122959", "LC-1755: moot, raised by comment 122959 (not the copy-forward)")
    ck(a["message"] == "open decision on LC-1755 may be moot: best-kid-pet-friendly-sofas published 2026-10-21 after it was raised (comment 122959, 2026-10-10)", "LC-1755: the message names article, date, comment and raise date")
    ck("run f312eb7b" not in a["message"], "a blocked run is not closed")
    a2 = assess("LC-1755", newest, comments, [{**run_blocked, "status": "done"}], [art])
    ck(a2["state"] == "MOOT" and "run f312eb7b done" in a2["message"] and "published 2026-10-21" in a2["message"], "LC-1755 with the run already done: both pieces of evidence")
    a3 = assess("LC-1755", newest, comments, [{**run_blocked, "status": "done"}], None)
    ck(a3["state"] == "MOOT" and a3["evidence"] == ["run f312eb7b done"], "a closed run alone is enough")
    a4 = assess("LC-1755", newest, comments, [{**run_blocked, "status": "abandoned"}], None)
    ck(a4["state"] == "MOOT", "an abandoned run is closed")
    ck(a["refs"]["runs"] == ["f312eb7b"] and tag(a).startswith("LIKELY MOOT (best-kid-pet-friendly-sofas published 2026-10-21)"), "the run id comes from the comment that raised it; the generator tag carries the evidence")

    # --- negative fixtures: stays OPEN
    ck(assess("LC-1755", newest, comments, [], None)["state"] == "OPEN", "negative: nothing linked, nothing published: OPEN")
    # review finding (LC-1755 for real): raised 10-10, restated by the newest comment 10-22, article published 10-21.
    ck(assess("LC-1755", newest, comments, [run_blocked], [art])["state"] == "MOOT", "LC-1755: raised 10-10, restated 10-22, published 10-21: MOOT")
    for label, cs, full in (("no comment history", [], True), ("history without the newest comment", [c122959, c122964], True), ("history cut at the page limit", comments, False)):
        u = assess("LC-1755", newest, cs, [run_blocked], [art], full)
        ck(u["state"] == "UNKNOWN" and u["evidence"] == [] and u["message"] == "" and "history" in u["unknown"][0], f"LC-1755 with {label}: UNKNOWN (NOT CHECKED), never judged from the newest comment alone")
        ck(check({"ok": True, "tickets": [{"key": "LC-1755", "status": "To Do", "total": 12, "comment": newest, "comments": cs, "comments_complete": full}]}, {"ok": True, "articles": [art], "runs": [run_blocked]})["verdict"] == NOT_CHECKED, f"check with {label}: NOT CHECKED")
    ck(assess("LC-1755", newest, comments, [run_blocked], [{**art, "webflow_last_published": "2026-10-05T00:00Z"}])["state"] == "OPEN", "negative: published BEFORE the decision was raised: OPEN")
    ck(assess("LC-1755", newest, comments, [run_blocked], [{**art, "slug": "another-sofa-article"}])["state"] == "OPEN", "negative: a different article's publish does not count")
    ck(assess("LC-1755", newest, comments, [{**run_blocked, "id": "99999999-x", "article_slug": "other-article-slug", "status": "done"}], None)["state"] == "OPEN", "negative: a closed run nobody named for this ticket does not count")
    ck(assess("LC-1755", newest, comments, [{**run_blocked, "status": "done", "updated_at": "2026-10-01T00:00Z"}], None)["state"] == "OPEN", "negative: a run closed BEFORE the decision was raised: OPEN")
    ck(assess("LC-1755", newest, comments, [run_blocked], [{**art, "webflow_last_published": None}])["state"] == "OPEN", "negative: an article never published: OPEN")
    linked = {"id": "11111111-aaaa", "article_slug": "best-kid-pet-friendly-sofas", "status": "done", "updated_at": "2026-10-23T00:00Z", "jira_keys": ["LC-1755"]}
    ck(assess("LC-1755", {**newest, "body": "Awaiting operator ruling on \"Most Durable\"."}, comments, [linked], None)["state"] == "MOOT", "a run whose jira_keys holds the ticket counts without being named")
    gone = {**newest, "id": "152003", "body": 'STATE (2026-10-23): the "Most Durable" ruling is MOOT, so it is removed from this ticket\'s open items.'}
    ck(assess("LC-1755", gone, comments, [run_blocked], [art])["state"] == "none", "the comment that resolves it leaves nothing to assess")
    nophrase = {**newest, "body": "Awaiting operator ruling on the heading."}
    ck(assess("LC-1755", nophrase, comments, [run_blocked], [art])["raised"] == newest["created"], "no quoted subject: the clock starts at the newest comment")
    ck(assess("LC-1755", nophrase, comments, [run_blocked], [art])["state"] == "OPEN", "no quoted subject, no reference: OPEN")
    dated = {**newest, "body": 'Awaiting operator ruling on "Most Durable" raised 2026-10-01.'}
    ck(assess("LC-1755", dated, [{"id": "151900", "created": newest["created"], "q": [], "r": [], "s": []}], [run_blocked], [{**art, "webflow_last_published": "2026-10-05T00:00Z"}])["raised"] == "2026-10-01", "a date inside the sentence can move the clock earlier")
    ck(opener("the \"Most Durable\" ruling", [c122964, c122959])["id"] == "122959", "the opener is the oldest comment with the subject, whatever the order")
    ck(opener("a ruling with no quote", comments) is None and opener('"zzz top"', comments) is None, "no quote or no match: no opener")
    body_c = {"id": "9", "created": "2026-10-09T20:00:00.000-0500", "body": 'stan\'s ruling on the "Most Durable" heading: best-kid-pet-friendly-sofas run f312eb7b'}
    rf = refs_for(newest, [body_c])[2]
    ck(rf["runs"] == ["f312eb7b"] and "best-kid-pet-friendly-sofas" in rf["slugs"], "a full-body comment (generator) is profiled the same way as an SQL profile")

    # --- the card receipt
    jira = {"ok": True, "tickets": [{"key": "LC-1755", "status": "To Do", "total": 12, "comment": newest, "comments": comments, "comments_complete": True}]}
    prod = {"ok": True, "articles": [art], "runs": [run_blocked]}
    rc = check(jira, prod)
    ck(rc["source"] == SOURCE and rc["verdict"] == BLOCK and "best-kid-pet-friendly-sofas published 2026-10-21" in rc["reason"], "check: LC-1755 BLOCKs with the evidence")
    ck(rc["facts"]["moot"][0]["ticket"] == "LC-1755", "check: the moot item is carried for the card and the guard")
    ck(check(jira, {"ok": True, "articles": [], "runs": []})["verdict"] == PASS and "LC-1755" in check(jira, {"ok": True})["reason"], "check negative: an open decision with nothing linked PASSes and is listed")
    ck(check(jira, None)["verdict"] == NOT_CHECKED and "missing or failed" in check(jira, None)["reason"], "check: production unread is NOT CHECKED, never PASS")
    ck(check(jira, {"ok": False, "error": "x"})["verdict"] == NOT_CHECKED, "check: a failed production read is NOT CHECKED")
    ck(check(jira, {"ok": False}, prod)["verdict"] == NOT_CHECKED, "check: a failed moot read is NOT CHECKED even when the topic's own slice is fine")
    quiet = {"ok": True, "tickets": [{"key": "LC-9", "status": "To Do", "total": 1, "comment": {"created": "2026-10-01T00:00Z", "body": "Shipped. Nothing left."}}]}
    ck(check(quiet, prod)["verdict"] == PASS and "no open-decision language" in check(quiet, prod)["reason"], "check: no decision language PASSes and says so")
    ck(check({"ok": False, "error": "401"}, prod)["verdict"] == NOT_CHECKED and check({}, None)["applicable"] is False, "check: Jira unread is NOT CHECKED")
    ck(check({"ok": True, "tickets": [{"key": "LC-9", "error": "404"}]}, prod)["verdict"] == NOT_CHECKED, "check: a ticket that could not be read is NOT CHECKED, not skipped")
    mixed = {"ok": True, "tickets": [jira["tickets"][0], quiet["tickets"][0]]}
    ck(check(mixed, prod)["verdict"] == BLOCK and len(check(mixed, prod)["facts"]["moot"]) == 1, "check: one moot ticket among several BLOCKs, only it is named")
    ck(check(jira, prod)["facts"]["open"] == [], "check: nothing OPEN when the only item is moot")
    bare = {"ok": True, "tickets": [{"key": "LC-5", "status": "To Do", "total": 1, "comment": {"created": "2026-10-01T00:00Z", "id": "5", "body": "Awaiting operator ruling on the colour."}, "comments": [{"id": "5", "created": "2026-10-01T00:00Z", "q": [], "r": [], "s": []}], "comments_complete": True}]}
    ck(check(bare, None)["verdict"] == NOT_CHECKED and check(bare, {"ok": True, "runs": [], "articles": []})["verdict"] == PASS, "check: even a decision that names nothing needs the production read (jira_keys links a run to a ticket)")
    ck(history_ok({"id": "1"}, [{"id": 1}]) is True and history_ok({"id": "1"}, [{"id": "1"}], False) is False and history_ok({"id": "1"}, None) is False and history_ok({"id": "1"}, None) is False, "history_ok: whole, and containing the newest comment")
    # --- first live run of the generator (2026-10-23): sentences copied from the real comments (the owner's first name lower-cased)
    not_open = [
        "This is now an evidence-backed recommendation rather than a judgment call, and I do not think it needs stan's time.",
        "On the sub-question of whether disposition keeps CEDE/CONTESTED, recommend retiring both, and this one does not need stan.",
        "On the WAF the evidence is now strong enough that I do not think this needs stan's judgment at all.",
        "The graduation already happened by ruling on 2026-08-19 and by deletion on 2026-08-20.",
        "Operator decision (2026-10-22): the template is still chosen at run start, but only V1 and V2 need to work, and work well.",
        "Declaring standard blocks is deferred: operator decision 2026-10-22, only V1 and V2 for now (LC-1867).",
        "stan's ruling, 2026-08-25: deterministic = FETCHING the data; the LLM = JUDGING it.",
        "stan's rulings below.",
        "This feature is not needed any more.",
        "stan never needs to look at this.",
        "The ruling is moot, so it is removed from the open items.",
        "The sign-off is not required, the operator already ruled.",
        "The old path is resolved and the decision on the colour was made.",
        "The ruling is moot, and the decision on the colour is closed.",
    ]
    for sent in not_open:
        ck(open_items(sent) == [], f"recorded or negated, not waiting: {sent[:60]}")
    still_open = [
        "Needs stan's pick before the swap.",
        "Waiting on stan.",
        "Draft, NOT merged, needs stan's yes.",
        "The remaining live proof still needs run d23b1954 to progress, which needs stan's lock click.",
        "Remaining: (2) a decision on removals versus the add-only ruling.",
        "Needs the operator to pick one.",
        "This already needs stan's lock click.",
        "Operator decision (2026-10-22) was premature and this still needs stan's lock click.",
        "stan's ruling, 2026-08-25, was reversed; still needs the operator to pick.",
        "I never said this needs stan.",
        "The old path is resolved and this is still pending the operator.",
        "The old approach is resolved and we still need stan to confirm.",
        "The old approach is decided and the rest is waiting on the operator.",
        "The run is already blocked and needs the operator.",
        "The old path is resolved and a decision on the colour remains.",
        "The old path is resolved and the decision on the colour is still open.",
        "This needs stan and the old path is resolved.",
        "Awaiting the operator on the colour; the older option was decided.",
    ]
    still_open += [
        "Awaiting operator decision (2026-10-22) on the colour.",
        "We no longer need the old path; this still needs stan's lock click.",
        "This is not needed any more, but the run needs the operator to pick one.",
    ]
    for sent in still_open:
        ck(open_items(sent) != [], f"still waiting: {sent[:60]}")
    ck(open_items("Awaiting operator decision (2026-10-22) on the colour. Operator decision (2026-10-22): the template is V1.") == ["Awaiting operator decision (2026-10-22) on the colour."], "only the sentence that is waiting survives; the recorded one beside it does not")
    ck(not names_pending("LC-1755 - the ruling is moot, dropped.") and names_pending("LC-9 - approve the DDL.") and names_pending("We no longer need the old path; LC-5 still needs the operator.")
       and names_pending("LC-5: Awaiting operator decision (2026-10-22) on the colour.") and not names_pending("LC-5: operator decision (2026-10-22): the template is V1.") and not names_pending("LC-1 does not need the operator."),
       "names_pending: a settled clause never hides an open one beside it; a settled sentence with nothing open is not pending")
    # --- review: "complete" needs a real count, never int(x or 0)
    full = [{"id": str(i)} for i in range(5)]
    for label, tot, pr, want in (("exact", 5, full, True), ("page holds more than total", 3, full, True), ("total 1, one comment", 1, full[:1], True),
                                   ("missing", None, full, False), ("zero", 0, full, False), ("negative", -1, full, False), ("bool", True, full, False),
                                   ("string", "5", full, False), ("float", 5.0, full, False), ("larger than the page", 250, full, False),
                                   ("the page limit exactly, page full", COMMENT_PAGE, [{}] * COMMENT_PAGE, True), ("one past the page limit", COMMENT_PAGE + 1, [{}] * (COMMENT_PAGE + 1), False),
                                   ("fewer comments than total", 5, full[:4], False), ("profiles not a list", 5, None, False), ("profiles a string", 5, "abcde", False)):
        ck(history_complete(tot, pr) is want, f"history_complete: total {label} -> {want}")
    # --- review warning: per-ticket state, so the NEEDS YOU guard never reads a card-level verdict for a ticket
    two = {"ok": True, "tickets": [jira["tickets"][0], {"key": "LC-9", "status": "To Do", "total": 1, "comment": {"id": "9", "created": "2026-10-21T00:00Z", "body": "Awaiting operator ruling on the colour."},
                                                          "comments": [{"id": "9", "created": "2026-10-21T00:00Z", "q": [], "r": [], "s": []}], "comments_complete": True},
                                   {"key": "LC-3", "status": "Done", "total": 1, "comment": {"id": "3", "created": "2026-10-21T00:00Z", "body": "Shipped."}, "comments": [], "comments_complete": True},
                                   {"key": "LC-4", "status": "To Do", "total": 0, "comment": None},
                                   {"key": "LC-5", "status": "To Do", "total": 7, "comment": None},
                                   {"key": "LC-6", "error": "404"}]}
    rt = check(two, {"ok": True, "articles": [art], "runs": [run_blocked]})
    ck(rt["verdict"] == BLOCK and [m["ticket"] for m in rt["facts"]["moot"]] == ["LC-1755"] and [a["ticket"] for a in rt["facts"]["open"]] == ["LC-9"], "per ticket: LC-1755 moot, LC-9 open")
    ck(sorted(rt["facts"]["clean"]) == ["LC-3", "LC-4"], "per ticket: no open decision and no comments are clean")
    ck(rt["facts"]["unchecked"] == {"LC-5": "newest comment not read", "LC-6": "404"}, "per ticket: each unreadable ticket carries its own reason")
    ck(check(two, None)["facts"]["unchecked"].get("LC-9", "").startswith("has an open decision but the production read") and "LC-9" not in rt["facts"]["unchecked"], "per ticket: with the moot read missing the open ticket is unchecked, with it read it is not")
    # --- review round 3: ONE rule for missing data. With an open decision, anything absent is NOT CHECKED, never PASS.
    for label, bad in (("None", None), ("{}", {}), ("ok without row lists", {"ok": True}), ("ok without runs", {"ok": True, "articles": []}), ("ok None", {"ok": None, "articles": [], "runs": []}),
                       ("ok 'yes'", {"ok": "yes", "articles": [], "runs": []}), ("ok False", {"ok": False, "error": "timeout", "articles": [], "runs": []}), ("a string", "garbage"), ("a list", []),
                       ("rows not lists", {"ok": True, "articles": "x", "runs": None})):
        r = check(jira, bad, {"ok": True, "articles": [art], "runs": [run_blocked]})
        ck(r["verdict"] == NOT_CHECKED and r["facts"]["moot"] == [], f"check: moot read {label} is NOT CHECKED even when the topic's own slice is fine")
    ck(check(jira, {"ok": True, "articles": [], "runs": []}, {"ok": False})["verdict"] == PASS, "check: a failed TOPIC slice does not matter; the moot read is the one that is required")
    base = {"key": "LC-1755", "status": "To Do", "comment": newest, "comments": comments, "comments_complete": True}
    good_moot = {"ok": True, "articles": [art], "runs": [run_blocked]}
    for label, t, want in (("no comment, total 3", {"key": "LC-2", "total": 3}, NOT_CHECKED), ("no comment, total absent", {"key": "LC-2"}, NOT_CHECKED),
                           ("no comment, total 'x'", {"key": "LC-2", "total": "x"}, NOT_CHECKED), ("newest body None", {**base, "comment": {**newest, "body": None}}, NOT_CHECKED),
                           ("errored", {**base, "error": "500"}, NOT_CHECKED)):
        r = check({"ok": True, "tickets": [t]}, good_moot)
        ck(r["verdict"] == want and r["applicable"] is True, f"check: ticket with {label} is NOT CHECKED")
        ck(check({"ok": True, "tickets": [t, base]}, good_moot)["verdict"] in (NOT_CHECKED, BLOCK), f"check: {label} next to a readable ticket never lets the whole receipt PASS")
    ck("no ticket named" in check({"ok": True, "tickets": []}, good_moot)["reason"], "check: no tickets says so")
    ck(check({"ok": True, "tickets": [{"error": "404"}]}, good_moot)["reason"] == "?: 404", "check: a ticket without a key is still named in the reason")
    ft = check(jira, {"ok": False, "error": "timeout", "articles": [], "runs": []})["reason"]
    ck("timeout" in ft and "LC-1755: has an open decision" in ft and "f312eb7b" in ft, "check: a failed read's reason names the ticket, the error and what the decision names")
    ck("no answer" in check(jira, None)["reason"] and "none named" in check(bare, None)["reason"], "check: a missing read says 'no answer'; a decision that names nothing says 'none named'")
    ck(check(jira, {"ok": True, "articles": [], "runs": []})["reason"].startswith("1 open decision(s), none tied to a published article or closed run: LC-1755"), "check: an OPEN decision is listed in the PASS reason")
    r0 = check({"ok": True, "tickets": [{"key": "LC-2", "total": 0}]}, None)
    ck(r0["verdict"] == NOT_CHECKED and r0["applicable"] is False, "check: a ticket with no comments at all has no decision to assess (inapplicable, not a PASS)")
    ck(check({"ok": True, "tickets": []}, good_moot)["applicable"] is False and check({"ok": True}, good_moot)["applicable"] is False, "check: no tickets is inapplicable")
    ck(check({"ok": True, "tickets": [{**base, "comment": {**newest, "body": "Shipped. Nothing left."}}]}, None)["verdict"] == PASS, "check: a readable ticket with NO open decision needs no moot read")
    ck(moot_read_ok({"ok": True, "articles": [], "runs": []}) is True and moot_read_ok({"ok": True, "articles": []}) is False and moot_read_ok(None) is False, "moot_read_ok: ok is True and both lists present")
    # --- review finding: "complete" must be affirmed (is True); a flag that is absent, None or "yes" is not a read in full
    for label, flag in (("absent", "ABSENT"), ("None", None), ("a truthy string", "yes"), ("False", False)):
        t = {"key": "LC-1755", "status": "To Do", "total": 12, "comment": newest, "comments": comments}
        if flag != "ABSENT":
            t["comments_complete"] = flag
        ck(check({"ok": True, "tickets": [t]}, {"ok": True, "articles": [art], "runs": [run_blocked]})["verdict"] == NOT_CHECKED, f"check: comments_complete {label} is NOT CHECKED, never a verdict")
    ck(check({"ok": True, "tickets": [{**jira["tickets"][0], "comments_complete": True}]}, prod)["verdict"] == BLOCK, "check: comments_complete True is the only flag that lets the verdict through")
    # --- review finding: a timestamp that cannot be read is NOT CHECKED, never MOOT and never OPEN
    nots = assess("LC-1755", newest, comments, [{**run_blocked, "status": "done", "updated_at": None}], None)
    ck(nots["state"] == "UNKNOWN" and nots["evidence"] == [] and "closing time" in nots["unknown"][0], "a closed run with no readable closing time is UNKNOWN, not MOOT")
    ck(tag(nots).startswith("NOT CHECKED (run f312eb7b done") and nots["message"] == "", "the generator tag says NOT CHECKED, with the reason")
    ck(assess("LC-1755", newest, comments, [run_blocked], [{**art, "webflow_last_published": "garbage"}])["state"] == "UNKNOWN", "an unreadable publish date is UNKNOWN")
    ck(assess("LC-1755", {**newest, "created": None}, comments, [run_blocked], [art])["state"] in ("MOOT", "UNKNOWN"), "an unreadable newest date falls back to the opening comment's")
    ck(assess("LC-1755", {**newest, "created": None}, [c151900], [run_blocked], [{**art, "slug": "x-y-z"}])["state"] == "OPEN", "an unreferenced article is not compared at all")
    ck(assess("LC-1755", newest, comments, [{**run_blocked, "article_slug": "x-y-z", "id": "99999999"}], [{**art, "slug": "x-y-z", "webflow_last_published": None}])["state"] == "OPEN", "a referenced article that was never published is OPEN")
    mixed = assess("LC-1755", newest, comments, [{**run_blocked, "status": "done", "updated_at": None}], [art])
    ck(mixed["state"] == "MOOT" and len(mixed["unknown"]) == 1, "one readable piece of evidence is enough; the unreadable one is still reported")
    uj = check(jira, {"ok": True, "articles": [], "runs": [{**run_blocked, "status": "done", "updated_at": None}]})
    ck(uj["verdict"] == NOT_CHECKED and "closing time" in uj["reason"] and uj["facts"]["moot"] == [], "check: an unreadable timestamp is NOT CHECKED (the guard blocks it), never PASS")
    # --- surviving mutants of the first sweep, each turned into a case
    ck(parse_ts("") is None and _day(None) == "" and _day("soon") == "soon" and _day("2026-10-09T20:11:20.746-0500") == "2026-10-10", "_day: UTC day of a stamp; an unreadable one is shown as given")
    pf = profile({"id": 1, "created": "x", "q": ["A B"], "r": ["20261010", "f312eb7b"], "s": ["bbm-infrastructure", "2026-10-10-ish", "real-slug-here"]})
    ck(pf["r"] == ["f312eb7b"] and pf["s"] == ["real-slug-here"] and pf["q"] == ["a b"], "profile: a date is not a run id, a repo name or a dated token is not a slug")
    odd = raised_at('"x y z" ruling', {"created": None}, [{"id": "1", "created": "2026-10-09T00:00:00Z", "q": ["x y z"], "r": [], "s": []}])
    ck(odd[1] is not None and odd[0] == "2026-10-09T00:00:00Z", "raised_at: a newest comment with no readable date still yields the opening comment")
    nodate = assess("LC-1", {"id": "9", "created": None, "body": "Awaiting operator ruling since 2026-10-01."}, [{"id": "9", "created": None, "q": [], "r": [], "s": []}], [], None)
    ck(nodate["state"] == "OPEN" and nodate["raised"] is None, "assess: an unreadable raise date is not replaced by a date from the sentence, and does not crash")
    ck(check(jira, prod)["applicable"] is True and check(quiet, prod)["applicable"] is True, "check: a real answer is applicable")
    ck(check({"ok": False, "error": "401"}, None)["reason"] == "Jira not read: 401" and check({}, None)["reason"] == "Jira not read: no evidence" and check("garbage", None)["reason"] == "Jira not read: no evidence", "check: the unread-Jira reason names the error, or says there is no evidence")
    ck(check({"ok": True, "tickets": [{"key": "LC-9", "error": "404", "comment": {"created": "2026-10-01T00:00Z", "body": "Awaiting operator ruling."}}]}, prod)["verdict"] == NOT_CHECKED, "check: a ticket that errored is NOT CHECKED even if a comment came back")
    ck("none named" in check(bare, None)["reason"] and "f312eb7b" in check(jira, None)["reason"], "check: the NOT CHECKED reason lists what the decision names")
    ck(check({"ok": True, "tickets": [{**jira["tickets"][0], "comments": None}]}, prod)["verdict"] == NOT_CHECKED, "check: a ticket whose comment history was not read is NOT CHECKED, never assessed from the newest comment alone")
    for f in fails:
        print("FAIL:", f)
    print(f"wws_moot selftest: {total[0] - len(fails)}/{total[0]} checks passed")
    return 1 if fails else 0


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        sys.exit(_selftest())
    print(__doc__)
