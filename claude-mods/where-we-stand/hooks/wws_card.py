#!/usr/bin/env python3
"""wws_card — turns four receipts into one answer card (LC-1893).

ONE JOB: given the topic, the evidence and the receipts, (1) name what else to look up
(`discover`), (2) name every disagreement between sources (`conflicts`) and every softer
signal (`notes`), (3) decide the verdict and (4) print the card. It reads nothing and runs nothing.

Card = know / state as of <date> / verified | not verified | conflict, each with its sources:

  verified      knowledge PASS, every applicable source PASS, at least one EXTERNAL source
                (GitHub or production) PASS, and no conflict. NOT CHECKED never counts.
  conflict      two sources HARD-disagree ("ticket says Done, PR #n not merged", "a memory says
                published 09-30, production says 10-08"). Named, never averaged.
  not verified  everything else, including any BLOCK or any applicable NOT CHECKED.

Softer signals (a ticket open while a cited PR merged, a comment newer than the memories, a memory
that a later one corrects) are printed as NOTES. They never change the verdict: a PR that closes
part of an epic is not a contradiction, and calling it one trains readers to skip conflicts.

Found on the first real-data runs (2026-10-22), each now pinned by a selftest line:
  * a PR cited as "bbm-refresh-agent #155" was verified against THIS repo and printed a green PASS,
    so refs that name another repo are dropped;
  * the sentence that mattered sat past the clip, so excerpts show the head AND a window around
    the topic term;
  * a ticket mentioned once in one memory is noise, so a discovered ticket needs two sources.

Self-test: python3 wws_card.py --selftest
"""
from __future__ import annotations

import datetime
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import wws_checks as C  # noqa: E402

KEY = C.KEY
PROJECTS = frozenset({"LC", "LCH", "LCC", "BBM"})
OTHER_REPOS = ("bbm-refresh-agent", "bbm-guardrails", "claude-skills", "bbm-content", "bbm-mods")
PR_REF = re.compile(r"#(\d{2,5})\b")
CORRECTS = re.compile(r"correct\w*\s+(?:to|of)\s+memory\s+([0-9a-f]{8})", re.IGNORECASE)
CLAIM_DATE = re.compile(r"published\s+(?:on\s+)?(\d{4}-\d{2}-\d{2})|(\d{4}-\d{2}-\d{2})[^.\n]{0,30}\bpublished\b|went\s+(?:live|v2)\b[^.\n]{0,40}?\bon\s+(\d{4}-\d{2}-\d{2})", re.IGNORECASE)
CUES = re.compile(r"\b(?:removed|fixed|fix|shipped|merged|moot|dormant|superseded|root cause|no longer|instead|because|reduced|stagger\w*|budget|retracted|replaced|dropped)\b", re.IGNORECASE)
MAX_TICKETS, MAX_PRS, MAX_MEMORIES = 4, 5, 5
MAX_FOUND_TICKETS = 3  # discovered tickets (beyond the ones asked for) per card
STALE_DAYS = 14
CLAIM_NEAR = 80  # a publish date counts only within this many characters of the article's slug or run id


def _day(ts) -> str:
    return str(ts or "")[:10]


def _ts(ts) -> str:
    """A timestamp to the minute, as the source gave it (a date stays a date)."""
    return str(ts or "")[:16]


def stale(ts, today) -> str:
    """` STALE (Nd old)` when the newest evidence is older than STALE_DAYS; empty when fresh or undated."""
    try:
        age = (datetime.date.fromisoformat(str(today)[:10]) - datetime.date.fromisoformat(str(ts)[:10])).days
    except ValueError:
        return ""
    return f" STALE ({age}d old)" if age > STALE_DAYS else ""


def _clip(text, n: int) -> str:
    s = " ".join(str(text or "").split())
    return s if len(s) <= n else s[: n - 1].rstrip() + "…"


def excerpt(text, terms, head: int = 110, win: int = 150) -> str:
    """Verbatim text (whitespace collapsed), at most head + win characters: the start, plus a window around
    the first topic term that lies BEYOND the start, with every gap marked `[...]`. A clip from the front
    alone is how the one sentence that answers the question gets cut; an unmarked join would pass two
    pieces off as one sentence."""
    s = " ".join(str(text or "").split())
    if len(s) <= head + win:
        return s
    low = s.lower()
    hits: list = []
    for t in terms or []:
        t = str(t).lower()
        i = low.find(t, head) if t else -1
        while i >= 0 and len(hits) < 24:
            hits.append(i)
            i = low.find(t, i + 1)
    if not hits:
        return s[: head + win].rstrip() + " [...]"
    # The first mention is often the old claim being quoted; the sentence that answers the question is
    # the one with a verb of change (removed, fixed, moot, superseded...) near the term.
    at = max(hits, key=lambda h: (3 * len(CUES.findall(s[max(0, h - 30):h])) + len(CUES.findall(s[max(head, h - win // 3):h + win * 2 // 3])), -h))
    start = max(head, at - win // 3)
    tail = s[start:start + win].rstrip()
    return s[:head].rstrip() + " [...] " + tail + (" [...]" if start + win < len(s) else "")


def merge_windows(wins, cap: int = 8, longest: int = 600) -> list:
    """Overlapping text windows (`{p: start, w: text}`, cut in SQL around every occurrence of a topic term) merged
    into continuous passages. The merge is done here because a regexp 'g' match consumes the right-hand context of
    the next occurrence, and a PR cited 110 characters after one was never seen (measured on alert-calibration,
    PR #770). Passages that cite a PR come first, then those with a verb of change."""
    spans = sorted(((int(w["p"]), str(w["w"])) for w in wins or [] if isinstance(w, dict) and str(w.get("p", "")).lstrip("-").isdigit() and w.get("w")), key=lambda x: x[0])
    merged: list = []
    for p, txt in spans:
        if merged and p <= merged[-1][0] + len(merged[-1][1]):
            bp, bt = merged[-1]
            merged[-1] = (bp, bt + txt[(bp + len(bt)) - p:])
        else:
            merged.append((p, txt))
    out = [" ".join(t[:longest].split()) for _, t in merged]
    out.sort(key=lambda w: (-len(PR_REF.findall(w)), -len(CUES.findall(w))))
    return out[:cap]


def _around(w: str, n: int) -> str:
    """At most n characters of the window, centred on its first PR citation (else its first verb of change)."""
    w = " ".join(str(w or "").split())
    if len(w) <= n:
        return w
    m = PR_REF.search(w) or CUES.search(w)
    at = m.start() if m else 0
    start = max(0, min(at - n // 3, len(w) - n))
    return ("[...] " if start else "") + w[start:start + n].strip() + (" [...]" if start + n < len(w) else "")


def _term_hits(m: dict, terms: list) -> int:
    c = str(m.get("content") or "").lower()
    return sum(c.count(str(t).lower()) for t in terms or [] if str(t))


def _window(a: dict) -> str:
    """The first window around a topic term in the article body (windows() puts PR-citing ones first), quoted,
    at most 300 characters centred on the PR citation."""
    ws = [x for x in a.get("ctx") or [] if str(x).strip()]
    w = ws[0] if ws else ""
    return f' | body: "{_around(w, 300)}"' if w else ""


def pr_refs(text) -> list:
    """PR numbers in the text that could be THIS repo's: a `#n` whose preceding words name another
    repo (`bbm-refresh-agent #155`) is that repo's number, and checking it here would verify the wrong PR."""
    s = str(text or "")
    out = []
    for m in PR_REF.finditer(s):
        if any(r in s[max(0, m.start() - 45):m.start()].lower() for r in OTHER_REPOS):
            continue
        n = int(m.group(1))
        if n not in out:
            out.append(n)
    return out


def keys_in(text) -> list:
    """Jira keys of the projects we run; `SHA-256` and `UTF-8` are not tickets."""
    return [k for k in dict.fromkeys(KEY.findall(str(text or ""))) if k.split("-")[0] in PROJECTS]


def discover(topic_tickets: list, knowledge: dict, production: dict, jira: dict | None = None) -> dict:
    """Tickets and PR numbers worth a second look. Explicit tickets lead. A discovered ticket must be a run's
    ticket or the own source_id of one of the MOST relevant memories (score at least half the best); any number
    of passing mentions is noise (measured on three real topics: two, then three mentions still pulled in
    unrelated tickets). At most three are added. PRs rank by the summed relevance of the sources that cite them
    (a memory's match score, an article's), then newest first. Capped: every ticket costs one Jira call and every PR one GitHub call."""
    docs: dict = {}
    sourced: set = set()
    pdocs: dict = {}
    mems = [m for m in (knowledge or {}).get("memories") or [] if m.get("is_active") and not m.get("superseded_by")]

    def sc(m: dict) -> int:
        return max(1, C._count(m.get("score")))  # a memory with no recorded score counts as one match

    cutoff = max(1, (max((sc(m) for m in mems), default=0) + 1) // 2)

    def add(table: dict, item, who, w: int = 1) -> None:
        table.setdefault(item, {})[who] = max(w, table.get(item, {}).get(who, 0))

    for m in (knowledge or {}).get("memories") or []:
        if not (m.get("is_active") and not m.get("superseded_by")):
            continue
        who = f"m:{m.get('id')}"
        text = f"{m.get('source_id') or ''} {m.get('content') or ''}"
        for k in keys_in(text):
            add(docs, k, who)
        if sc(m) >= cutoff:
            for k in keys_in(m.get("source_id")):
                sourced.add(k)
        for n in pr_refs(m.get("content")):
            add(pdocs, n, who, sc(m))
    for a in (knowledge or {}).get("articles") or []:
        who = f"a:{a.get('slug')}"
        for w in a.get("ctx") or []:
            for k in keys_in(w):
                add(docs, k, who)
            for n in pr_refs(w):
                add(pdocs, n, who, max(1, C._count(a.get("sc"))))
    for r in (production or {}).get("runs") or []:
        for k in keys_in(" ".join(str(x) for x in r.get("jira_keys") or [])):
            add(docs, k, f"r:{r.get('id')}")
            sourced.add(k)
    for t in (jira or {}).get("tickets") or []:
        for n in pr_refs((t.get("comment") or {}).get("body")):
            add(pdocs, n, f"j:{t.get('key')}")
    explicit = list(topic_tickets or [])
    rest = sorted((k for k in docs if k not in explicit and k in sourced), key=lambda k: (-len(docs[k]), k))
    prs = sorted(pdocs, key=lambda n: (-sum(pdocs[n].values()), -n))[:MAX_PRS]
    return {"tickets": (explicit + rest[:MAX_FOUND_TICKETS])[:MAX_TICKETS], "prs": prs}


def conflicts(evidence: dict, receipts: list) -> list:
    """HARD disagreements between two sources, as sentences that name both sides."""
    out: list = []
    by = {r["source"]: r for r in receipts}
    jira = ((by.get("jira") or {}).get("facts") or {}).get("tickets") or []
    prs = ((by.get("github") or {}).get("facts") or {}).get("prs") or []
    prod = (by.get("production") or {}).get("facts") or {}
    mems = ((by.get("knowledge") or {}).get("facts") or {}).get("memories") or []
    for t in jira:
        key, status = t["key"], str(t.get("status") or "")
        done = C.is_done_status(status)
        for p in (p for p in prs if key in (p.get("keys") or [])):
            if done and not p.get("merged"):
                out.append(f"{key}: ticket says {status} (ticket updated {_ts(t.get('updated'))}); PR #{p['number']} is {p.get('state') or 'not merged'} and not merged (PR updated {_ts(p.get('updated_at'))})")
        for r in prod.get("runs") or []:
            if key in (r.get("jira_keys") or []) and str(r.get("status")) in C.RUN_DONE and not done:
                out.append(f"{key}: ticket says {status} (ticket updated {_ts(t.get('updated'))}); refresh run {str(r.get('id'))[:8]} is {r['status']} (run updated {_ts(r.get('updated_at'))})")
    for a in prod.get("articles") or []:
        pub = _day(a.get("webflow_last_published"))
        run_days = {_day(r.get("updated_at")) for r in prod.get("runs") or []}
        run_ids = [str(r.get("id") or "")[:8] for r in prod.get("runs") or []]
        for m in mems:
            text = str(m.get("content") or "")
            if not pub or not (str(a.get("slug")) in text or any(i and i in text for i in run_ids)):
                continue
            names = [str(a.get("slug"))] + [i for i in run_ids if i]
            for g in CLAIM_DATE.finditer(text):
                d = g.group(1) or g.group(2) or g.group(3)
                near = text[max(0, g.start() - CLAIM_NEAR):g.end() + CLAIM_NEAR]
                if d != pub and d not in run_days and any(n in near for n in names):
                    out.append(f"memory {str(m['id'])[:8]} ({_day(m.get('created'))}) says published {d}; production says {a.get('slug')} webflow_last_published {_ts(a.get('webflow_last_published'))}")
                    break
    # LC-1907: an open decision about something production says is over. The sentence comes from wws_moot, so
    # the card, the generator and the NEEDS YOU guard word it identically.
    for m in ((by.get("decision_moot") or {}).get("facts") or {}).get("moot") or []:
        out.append(m["message"])
    return out


def notes(receipts: list) -> list:
    """Softer signals. They are printed so nothing is hidden, and they never change the verdict."""
    out: list = []
    by = {r["source"]: r for r in receipts}
    jira = ((by.get("jira") or {}).get("facts") or {}).get("tickets") or []
    prs = ((by.get("github") or {}).get("facts") or {}).get("prs") or []
    mems = ((by.get("knowledge") or {}).get("facts") or {}).get("memories") or []
    for t in jira:
        key, status = t["key"], str(t.get("status") or "")
        mine = [p for p in prs if key in (p.get("keys") or [])]
        if mine and not C.is_done_status(status) and all(p.get("merged") for p in mine):
            nums = ", ".join(f"#{p['number']}" for p in mine)
            out.append(f"{key} is {status} but {nums} merged {_day(max(str(p.get('merged_at') or '') for p in mine))}: a merged PR can be part of the work, so read the ticket's newest comment")
        c = (t.get("comment") or {}).get("created")
        newest = max((str(m.get("created") or "") for m in mems if key in f"{m.get('source_id') or ''} {m.get('content') or ''}"), default="")
        if c and newest and _day(c) > _day(newest):
            out.append(f"{key}: its newest comment ({_day(c)}) is newer than the newest memory that mentions it ({_day(newest)}): the comment is the current state")
    ids = {str(m["id"])[:8] for m in mems}
    for m in mems:
        for target in CORRECTS.findall(str(m.get("content") or "")):
            if target.lower() in ids:
                out.append(f"memory {target.lower()} is partly overtaken: memory {str(m['id'])[:8]} corrects it")
            else:
                out.append(f"memory {str(m['id'])[:8]} is a correction of memory {target.lower()} (not among those read): do not rely on the claims of {target.lower()} that it names")
    opened = [a for a in ((by.get("production") or {}).get("facts") or {}).get("alerts") or [] if a.get("open")]
    if opened:
        kinds = ", ".join(sorted({str(a.get("check_type")) for a in opened}))
        out.append(f"{len(opened)} alert(s) still open on this topic ({kinds}): a fix recorded in a memory is not proof the condition stopped")
    return out


def verdict(receipts: list, found: list) -> str:
    if found:
        return "conflict"
    by = {r["source"]: r for r in receipts}
    if any(r["verdict"] == C.BLOCK for r in receipts):
        return "not verified"
    if any(r["applicable"] and r["verdict"] != C.PASS for r in receipts):
        return "not verified"
    if (by.get("knowledge") or {}).get("verdict") != C.PASS:
        return "not verified"
    if not any((by.get(s) or {}).get("verdict") == C.PASS for s in ("github", "production")):
        return "not verified"
    return "verified"


def render(topic: str, today: str, receipts: list, terms: list | None = None) -> str:
    terms = [t for t in (terms or [])]
    by = {r["source"]: r for r in receipts}
    found = conflicts({}, receipts)
    soft = notes(receipts)
    v = verdict(receipts, found)
    kf = (by["knowledge"].get("facts") or {}) if "knowledge" in by else {}
    jf = (by["jira"].get("facts") or {}) if "jira" in by else {}
    gf = (by["github"].get("facts") or {}) if "github" in by else {}
    pf = (by["production"].get("facts") or {}) if "production" in by else {}
    lines = [f"WHERE WE STAND — {topic} (as of {today})", f"VERDICT: {v.upper()}", ""]
    lines.append("KNOW (active memories / articles, most relevant first, superseded chains walked to the end):")
    mems = sorted(kf.get("memories") or [], key=lambda m: (C._count(m.get("score")), _term_hits(m, terms), str(m.get("created") or "")), reverse=True)
    corrected = {t.lower(): str(m["id"])[:8] for m in mems for t in CORRECTS.findall(str(m.get("content") or ""))}
    for m in mems[:MAX_MEMORIES]:
        tag = f" (CORRECTED by {corrected[str(m['id'])[:8]]})" if str(m["id"])[:8] in corrected else ""
        lines.append(f"  - [memory {str(m['id'])[:8]} · {_day(m.get('created'))}{stale(m.get('created'), today)} · {m.get('memory_type') or '?'}]{tag} \"{excerpt(m.get('content'), terms)}\"")
    if len(mems) > MAX_MEMORIES:
        lines.append(f"  - (+{len(mems) - MAX_MEMORIES} more active memories not shown)")
    for a in (kf.get("articles") or [])[:3]:
        lines.append(f"  - [article {a['slug']} · {a.get('confidence') or '?'} · verified {_day(a.get('last_verified'))}{stale(a.get('last_verified'), today)}] \"{excerpt(a.get('summary'), terms, 120, 100)}\"{_window(a)}")
    for s in (kf.get("superseded") or [])[:3]:
        lines.append(f"  - superseded: {s['from'][:8]} -> {s['terminal'][:8]} (use the terminal)")
    if not mems and not kf.get("articles"):
        lines.append(f"  - {by.get('knowledge', {}).get('reason') or 'knowledge not read'}")
    lines.append("")
    lines.append("STATE (Jira, newest comment):")
    for t in (jf.get("tickets") or [])[:MAX_TICKETS]:
        c = t.get("comment") or {}
        if c.get("created"):
            tail = f"newest comment {_ts(c['created'])}{stale(c['created'], today)} by {c.get('author') or '?'}: \"{excerpt(c.get('body'), terms, 120, 170)}\""
        else:
            tail = "no comments"
        title = f' "{_clip(t.get("summary"), 70)}"' if t.get("summary") else ""
        lines.append(f"  - {t['key']} [{t.get('status')}]{title} updated {_ts(t.get('updated'))}{stale(t.get('updated'), today)} — {tail}")
    if not jf.get("tickets"):
        lines.append(f"  - {by.get('jira', {}).get('reason') or 'Jira not read'}")
    lines.append("")
    lines.append("VERIFIED (GitHub / production):")
    for p in (gf.get("prs") or [])[:MAX_PRS]:
        sha = f"sha={str(p['sha'])[:9]}" if p.get("sha") else (f"head_sha={str(p['head_sha'])[:9]}" if p.get("head_sha") else "sha=unknown")
        what = (f"merged=true {sha} at {_ts(p.get('merged_at'))}{stale(p.get('merged_at'), today)} into {p.get('base')}"
                if p.get('merged') else f"merged=false (state {p.get('state')}, updated {_ts(p.get('updated_at'))}{stale(p.get('updated_at'), today)})")
        lines.append(f"  - PR #{p['number']}: {what} — {_clip(p.get('title'), 90)}")
    for a in (pf.get("articles") or [])[:2]:
        lines.append(f"  - article {a.get('slug')}: webflow_last_published {_ts(a.get('webflow_last_published')) or 'never'}{stale(a.get('webflow_last_published'), today)}, status {a.get('status')}")
    for r in (pf.get("runs") or [])[:3]:
        lines.append(f"  - run {str(r.get('id'))[:8]} ({r.get('article_slug')}): {r.get('status')}, updated {_ts(r.get('updated_at'))}{stale(r.get('updated_at'), today)}")
    for f in (pf.get("functions") or [])[:2]:
        lines.append(f"  - function {f.get('slug')}: deployed v{f.get('version')}, updated {_day(f.get('updated_at')) or 'date unknown'}{stale(f.get('updated_at'), today)} (a redeploy bumps the version without new code), read {_day(today)}")
    for c in (pf.get("crons") or [])[:3]:
        lines.append(f"  - cron {c.get('jobname')}: {c.get('schedule')} ({'active' if c.get('active') else 'INACTIVE'}), read {_day(today)}")
    for al in (pf.get("alerts") or [])[:3]:
        lines.append(f"  - alert {al.get('check_type')} [{al.get('severity')}]: last seen {_ts(al.get('last_seen'))}{stale(al.get('last_seen'), today)}, seen {al.get('recurrence_count')}x, {'still open' if al.get('open') else 'resolved'}")
    for mg in (pf.get("migrations") or [])[:2]:
        lines.append(f"  - migration {mg.get('version')} {mg.get('name') or ''} is in schema_migrations, read {_day(today)}")
    if not (gf.get("prs") or any(pf.get(k) for k in ("articles", "runs", "functions", "crons", "alerts", "migrations"))):
        lines.append("  - nothing verified against GitHub or production")
    lines.append("")
    lines.append("CONFLICTS:")
    lines.extend(f"  - {c}" for c in found) if found else lines.append("  - none found")
    if found:
        lines.append("  Rule (CLAUDE.md section 6): production wins ties. Both sides are listed with their dates; neither is chosen here.")
    if soft:
        lines.append("NOTES (do not change the verdict):")
        lines.extend(f"  - {n}" for n in soft)
    lines.append("")
    lines.append("RECEIPTS: " + " | ".join(f"{r['source']} {r['verdict']}" for r in receipts))
    for r in receipts:
        if r["verdict"] != C.PASS:
            lines.append(f"  {r['source']} {r['verdict']}: {_clip(r['reason'], 200)}")
    return "\n".join(lines)


def _selftest() -> int:
    fails: list[str] = []
    total = [0]

    def ck(cond: bool, msg: str) -> None:
        total[0] += 1
        if not cond:
            fails.append(msg)

    ck(excerpt("short text", ["x"]) == "short text", "a short text is whole")
    long_ = "HEAD " * 30 + "the answer: mutation-check was removed from required checks. " + "tail " * 40
    ex = excerpt(long_, ["mutation-check"], 110, 150)
    ck("mutation-check was removed" in ex and ex.startswith("HEAD HEAD") and " [...] " in ex and ex.endswith(" [...]"), "excerpt keeps the head and a window around the term, gaps marked")
    cue = "HEAD " * 30 + "old claim: mutation-check IS required. " + "mid " * 40 + "Update: mutation-check was REMOVED from the required list. " + "tail " * 30
    ck("was REMOVED" in excerpt(cue, ["mutation-check"], 110, 150), "the window goes to the occurrence with a verb of change, not the first mention")
    ck(stale("2026-10-01", "2026-10-22") == " STALE (21d old)" and stale("2026-10-10", "2026-10-22") == "" and stale("2026-10-08", "2026-10-22") == "" and stale("x", "y") == "" and stale(None, "2026-10-22") == "",
       "stale: older than 14 days is flagged, 14 or fewer is not, undated is not")
    ck(_ts("2026-10-08T15:01:15.671Z") == "2026-10-08T15:01" and _ts(None) == "", "timestamps are shown to the minute")
    ck(excerpt(long_, ["absent-term"], 110, 150) == " ".join(long_.split())[:260].rstrip() + " [...]", "no term hit: the start, marked as cut")
    ck(excerpt("MUTATION-check " + "z" * 400, ["mutation-check"], 110, 150) == ("MUTATION-check " + "z" * 400)[:260].rstrip() + " [...]", "a term inside the head needs no window")
    ck(excerpt(None, None) == "", "excerpt of nothing")

    ck(pr_refs("Fix PR #694 and #770, also bbm-refresh-agent #155 and bbm-guardrails PR #93") == [694, 770], "refs naming another repo are dropped")
    ck(pr_refs("bbm-refresh-agent #148/#149 then bbm-infrastructure #1869") == [1869], "a list after another repo's name is that repo's")
    ck(pr_refs("#7 and #12345 and #123456") == [12345], "numbers of two to five digits only")
    ck(pr_refs("see #694, again #694") == [694], "deduped")
    ck(keys_in("LC-1 SHA-256 UTF-8 LCH-22 lc-3 BBM-9") == ["LC-1", "LCH-22", "BBM-9"], "only our projects are tickets")

    mem = {"id": "30d884a3-aaaa", "is_active": True, "superseded_by": None, "created": "2026-07-04", "memory_type": "lesson",
           "source_id": "LCH-224", "content": "catalog-ingest hits 546 hourly. Partial fix in PR #694 and #770. See LCH-224 and LC-9. bbm-refresh-agent #155."}
    mem2 = {**mem, "id": "m2", "source_id": "other", "content": "Again LC-9 and PR #694; LC-4 once."}
    d = discover(["LC-1"], {"memories": [mem, mem2, {**mem, "id": "x", "is_active": False, "content": "LC-77 #5000"}]}, {"runs": [{"id": "r1", "jira_keys": ["LC-1860", "bad"]}]})
    ck(d["tickets"] == ["LC-1", "LC-1860", "LCH-224"], "explicit first; a source_id or a run key qualifies; two mentions (LC-9) or one (LC-4) do not")
    ck(d["prs"] == [694, 770], "PRs rank by citing sources; another repo's #155 is dropped; inactive memories do not count")
    da = discover([], {"articles": [{"slug": "alert-calibration", "ctx": ["retracted (see PR #770) LC-9", "PR #922 budget 40s"]}], "memories": [mem]}, {})
    ck(da["prs"] == [770, 922, 694] and da["tickets"] == ["LCH-224"], "article windows contribute PRs; newer PR first on a tie; two sources are still not enough for a ticket")
    d3 = discover([], {"memories": [{**mem, "id": "a1", "source_id": "z", "content": "LC-9 once"}, {**mem, "id": "a2", "source_id": "z", "content": "LC-9 twice"}, {**mem, "id": "a3", "source_id": "z", "content": "LC-9 thrice"}],
                       "articles": [{"slug": "s", "ctx": ["LC-9 in an article"]}]}, {})
    ck("LC-9" not in d3["tickets"], "a ticket mentioned by any number of sources, but nobody's own, never qualifies")
    lo = discover([], {"memories": [{**mem, "id": "hi", "score": 4, "source_id": "LC-1", "content": "x"}, {**mem, "id": "lo", "score": 1, "source_id": "LC-2", "content": "x"}]}, {})
    ck(lo["tickets"] == ["LC-1"], "a ticket that is only the source_id of a weakly matching memory does not qualify (score under half the best)")
    wp = discover([], {"memories": [{**mem, "id": "w1", "score": 3, "content": "PR #5000"}, {**mem, "id": "w2", "score": 1, "content": "PR #6001"}, {**mem, "id": "w3", "score": 1, "content": "PR #6002"}]}, {})
    ck(wp["prs"] == [5000, 6002, 6001], "PRs rank by the summed relevance of the sources citing them, newest first on a tie")
    dj = discover([], {}, {}, {"tickets": [{"key": "LC-1", "comment": {"body": "PR #1867 changes the runner; bbm-guardrails #12"}}]})
    ck(dj["prs"] == [1867], "PR numbers in a ticket comment are found")
    ck(discover([], {}, {}) == {"tickets": [], "prs": []}, "empty evidence")
    many = {"memories": [{"id": str(i), "is_active": True, "source_id": f"LC-{i}", "content": f"LC-{i} #{100 + i}"} for i in range(1, 12)]}
    big = discover([], many, {})
    ck(len(big["tickets"]) == MAX_FOUND_TICKETS and len(big["prs"]) == MAX_PRS, "discovered tickets and PRs are capped")
    ck(len(discover(["A-1", "B-2", "C-3", "D-4", "E-5"], many, {})["tickets"]) == MAX_TICKETS, "explicit tickets plus discovered ones never exceed the cap")
    ck(big["prs"] == [111, 110, 109, 108, 107], "ties go to the newest PR")

    def rc(src, verdict_, facts=None, applicable=True, reason="r"):
        return {"source": src, "verdict": verdict_, "applicable": applicable, "reason": reason, "facts": facts or {}}

    know = rc("knowledge", C.PASS, {"memories": [mem], "articles": [], "superseded": []})
    jira_done = rc("jira", C.PASS, {"tickets": [{"key": "LC-5", "status": "Done", "summary": "Fix the thing", "updated": "2026-09-16T11:03", "total": 1,
                                                   "comment": {"created": "2026-09-03T10:00", "author": "S", "body": "removed from list"}}]})
    gh_ok = rc("github", C.PASS, {"prs": [{"number": 694, "merged": True, "base": "main", "merged_at": "2026-07-05T00:00", "keys": ["LC-5"], "title": "t"}]})
    prod_na = rc("production", C.NOT_CHECKED, applicable=False)
    ck(conflicts({}, [know, jira_done, gh_ok, prod_na]) == [] and notes([know, jira_done, gh_ok, prod_na]) == [], "agreeing sources raise nothing")
    ck(verdict([know, jira_done, gh_ok, prod_na], []) == "verified", "all applicable PASS plus one external PASS is verified")
    ck(verdict([know, jira_done, rc("github", C.NOT_CHECKED, applicable=False), prod_na], []) == "not verified", "no external PASS: not verified")
    ck(verdict([know, jira_done, rc("github", C.NOT_CHECKED, reason="403"), prod_na], []) == "not verified", "an applicable NOT CHECKED is not verified")
    ck(verdict([know, jira_done, rc("github", C.BLOCK), prod_na], []) == "not verified", "a BLOCK is not verified")
    ck(verdict([rc("knowledge", C.NOT_CHECKED), jira_done, gh_ok, prod_na], []) == "not verified", "knowledge unread: not verified")
    ck(verdict([know, jira_done, gh_ok, prod_na], ["x"]) == "conflict", "a conflict wins")

    pr_open = rc("github", C.BLOCK, {"prs": [{"number": 7, "merged": False, "state": "open", "keys": ["LC-5"]}]})
    ck(any("ticket says Done (ticket updated 2026-09-16T11:03); PR #7 is open and not merged" in c for c in conflicts({}, [know, jira_done, pr_open, prod_na])), "ticket done, PR not merged is a conflict, with the ticket's date")
    jira_open = rc("jira", C.PASS, {"tickets": [{"key": "LC-5", "status": "To Do", "total": 0, "comment": None}]})
    ck(conflicts({}, [know, jira_open, gh_ok, prod_na]) == [], "ticket open + PR merged is NOT a hard conflict")
    ck(any("LC-5 is To Do but #694 merged 2026-07-05" in n for n in notes([know, jira_open, gh_ok, prod_na])), "it is a note")
    ck(verdict([know, jira_open, gh_ok, prod_na], conflicts({}, [know, jira_open, gh_ok, prod_na])) == "verified", "a note does not change the verdict")
    prod_run = rc("production", C.PASS, {"runs": [{"id": "896655cd-1111", "status": "done", "updated_at": "2026-10-08T00:00", "jira_keys": ["LC-5"]}]})
    ck(any("refresh run 896655cd is done" in c for c in conflicts({}, [know, jira_open, rc("github", C.NOT_CHECKED, applicable=False), prod_run])), "ticket open, run done")
    ck(conflicts({}, [know, jira_done, rc("github", C.NOT_CHECKED, applicable=False), prod_run]) == [], "a done ticket with a done run agrees")

    newer = notes([rc("knowledge", C.PASS, {"memories": [{**mem, "created": "2026-08-01", "source_id": "LC-5"}]}),
                   {**jira_done, "facts": {"tickets": [{**jira_done["facts"]["tickets"][0], "comment": {"created": "2026-09-20T00:00", "body": "x"}}]}}])
    ck(any("newest comment (2026-09-20) is newer than the newest memory that mentions it (2026-08-01)" in n for n in newer), "comment newer than memory: a note")
    older = notes([rc("knowledge", C.PASS, {"memories": [{**mem, "created": "2026-10-01", "source_id": "LC-5"}]}), jira_done])
    ck(older == [], "a comment older than the memory raises nothing")

    corr = {"id": "9434a776-x", "created": "2026-09-03", "memory_type": "lesson", "content": "CORRECTION to memory 7e5fa9b3-c17f (LC-1333): claim (b) is wrong"}
    old = {"id": "7e5fa9b3-c17f", "created": "2026-09-03", "memory_type": "lesson", "content": "mutation-check IS required"}
    ck(notes([rc("knowledge", C.PASS, {"memories": [corr, old]})]) == ["memory 7e5fa9b3 is partly overtaken: memory 9434a776 corrects it"], "a correction names what it overtakes")
    ck(notes([rc("knowledge", C.PASS, {"memories": [corr]})]) == ["memory 9434a776 is a correction of memory 7e5fa9b3 (not among those read): do not rely on the claims of 7e5fa9b3 that it names"], "a correction of a memory we did not read is still named")
    opened = notes([rc("production", C.PASS, {"alerts": [{"check_type": "cron_http_timeout", "open": True}, {"check_type": "x", "open": False}]})])
    ck(opened == ["1 alert(s) still open on this topic (cron_http_timeout): a fix recorded in a memory is not proof the condition stopped"], "an open alert is never silently fixed")

    art = {"slug": "most-comfortable-couches", "webflow_last_published": "2026-10-08T15:01Z", "status": "published"}
    run = {"id": "896655cd-0000", "status": "done", "updated_at": "2026-10-08T18:53Z", "jira_keys": []}
    pmem = {"id": "45a44fdf-1", "created": "2026-09-30", "content": "RETRO: most-comfortable-couches, run 896655cd (published 2026-09-30)."}
    pc = conflicts({}, [rc("knowledge", C.PASS, {"memories": [pmem]}), rc("production", C.PASS, {"articles": [art], "runs": [run]})])
    ck(pc == ["memory 45a44fdf (2026-09-30) says published 2026-09-30; production says most-comfortable-couches webflow_last_published 2026-10-08T15:01"], "a memory's publish date that production contradicts is a conflict")
    far = {**pmem, "content": "velvet-sofa was published 2026-09-22 by hand. " + "filler " * 40 + "most-comfortable-couches went live 2026-10-08."}
    ck(conflicts({}, [rc("knowledge", C.PASS, {"memories": [far]}), rc("production", C.PASS, {"articles": [art], "runs": [run]})]) == [], "a publish date far from the article's slug is about something else")
    okm = {**pmem, "content": "most-comfortable-couches published 2026-10-08."}
    ck(conflicts({}, [rc("knowledge", C.PASS, {"memories": [okm]}), rc("production", C.PASS, {"articles": [art], "runs": [run]})]) == [], "an agreeing publish date raises nothing")
    other = {**pmem, "content": "some-other-article published 2026-01-01"}
    ck(conflicts({}, [rc("knowledge", C.PASS, {"memories": [other]}), rc("production", C.PASS, {"articles": [art], "runs": [run]})]) == [], "a memory about another article is not compared")
    rev = {**pmem, "content": "most-comfortable-couches: 2026-09-30 staged and published"}
    ck(len(conflicts({}, [rc("knowledge", C.PASS, {"memories": [rev]}), rc("production", C.PASS, {"articles": [art], "runs": [run]})])) == 1, "date-first phrasing is read too")

    card = render("catalog-ingest 546", "2026-10-22", [know, jira_done, gh_ok, prod_na], ["catalog-ingest"])
    ck(card.startswith("WHERE WE STAND — catalog-ingest 546 (as of 2026-10-22)\nVERDICT: VERIFIED"), "card header and verdict")
    ck("[memory 30d884a3 · 2026-07-04 STALE (110d old) · lesson] \"catalog-ingest hits 546 hourly." in card, "memory with id, date, STALE flag, type and a quoted body")
    ck('LC-5 [Done] "Fix the thing" updated 2026-09-16T11:03 STALE (36d old) — newest comment 2026-09-03T10:00 STALE (49d old) by S: "removed from list"' in card, "ticket with title, dates, STALE flags and its newest comment quoted")
    ck("PR #694: merged=true sha=unknown at 2026-07-05T00:00 STALE (109d old) into main" in card, "PR line: merged flag, sha, timestamp, STALE")
    hd = render("t", "2026-07-06", [know, jira_done, rc("github", C.PASS, {"prs": [{"number": 1, "merged": True, "head_sha": "fedcba9876", "base": "main", "merged_at": "2026-07-05T00:00Z", "title": "x"}]}), prod_na])
    ck("PR #1: merged=true head_sha=fedcba987 at" in hd, "no merge commit sha from the API: the PR head sha, labelled as such")
    sha_card = render("t", "2026-07-06", [know, jira_done, rc("github", C.PASS, {"prs": [{"number": 1, "merged": True, "sha": "0123456789abcdef", "base": "main", "merged_at": "2026-07-05T00:00Z", "title": "x"}]}), prod_na])
    ck("PR #1: merged=true sha=012345678 at 2026-07-05T00:00 into main" in sha_card, "PR line carries the merge commit sha")
    ck("RECEIPTS: knowledge PASS | jira PASS | github PASS | production NOT CHECKED" in card and "production NOT CHECKED: r" in card, "receipts and reasons")
    ck("  - none found" in card and "NOTES" not in card, "no conflicts, no notes")
    many_m = [{**mem, "id": f"id{i:06d}", "content": f"memory {i}"} for i in range(8)]
    card = render("t", "2026-10-22", [rc("knowledge", C.PASS, {"memories": many_m, "articles": [{"slug": "s", "summary": "sum", "confidence": "verified", "last_verified": "2026-01-01"}], "superseded": [{"from": "aaaaaaaa11", "terminal": "bbbbbbbb22"}]}), jira_done, gh_ok, prod_na])
    ck("(+3 more active memories not shown)" in card and "[article s · verified · verified 2026-01-01 STALE (294d old)] \"sum\"" in card and "superseded: aaaaaaaa -> bbbbbbbb" in card, "memory cap, article and chain lines")
    art_card = render("t", "d", [rc("knowledge", C.PASS, {"memories": [], "articles": [{"slug": "s", "summary": "sum", "confidence": "verified", "last_verified": "2026-01-01", "ctx": ["", "the window about the topic"]}]}), jira_done, gh_ok, prod_na])
    ck('\"sum\" | body: "the window about the topic"' in art_card, "an article shows the first window around a term, quoted")
    rank = render("t", "d", [rc("knowledge", C.PASS, {"memories": [{**mem, "id": "aaaaaaaa", "score": 1, "content": "term once"}, {**mem, "id": "bbbbbbbb", "score": 2, "content": "x"},
                                                                  {**mem, "id": "cccccccc", "score": 1, "content": "term term term"}]}), jira_done, gh_ok, prod_na], ["term"])
    ck(rank.index("memory bbbbbbbb") < rank.index("memory cccccccc") < rank.index("memory aaaaaaaa"), "memories rank by matched terms, then how often the text names them")
    card = render("t", "d", [rc("knowledge", C.PASS, {"memories": [old, corr]}), rc("jira", C.NOT_CHECKED, applicable=False), rc("github", C.NOT_CHECKED, applicable=False), prod_na])
    ck("(CORRECTED by 9434a776)" in card and "NOTES (do not change the verdict):" in card, "a corrected memory is tagged and noted")
    pf = {"functions": [{"slug": "catalog-ingest", "version": 111}], "crons": [{"jobname": "daily-catalog-ingest", "schedule": "0,22,44 * * * *", "active": True}],
          "alerts": [{"check_type": "cron_http_failure", "severity": "critical", "last_seen": "2026-10-21T00:00", "recurrence_count": 9, "open": True}],
          "migrations": [{"version": "20261008120000", "name": "x"}], "articles": [art], "runs": [run]}
    card = render("t", "d", [know, jira_done, rc("github", C.NOT_CHECKED, applicable=False), rc("production", C.PASS, pf)])
    ck("function catalog-ingest: deployed v111, updated date unknown (a redeploy bumps the version without new code), read d" in card, "function line: version, its own date or 'unknown', the redeploy caveat, the read date")
    ck("cron daily-catalog-ingest: 0,22,44 * * * * (active), read d" in card and "alert cron_http_failure [critical]: last seen 2026-10-21T00:00, seen 9x, still open" in card, "cron and alert lines")
    ck("migration 20261008120000 x is in schema_migrations, read d" in card and "article most-comfortable-couches: webflow_last_published 2026-10-08T15:01, status published" in card and "run 896655cd (None): done, updated 2026-10-08T18:53" in card, "migration, article and run lines carry full timestamps")
    card = render("t", "2026-10-22T00:00", [rc("knowledge", C.PASS, {"memories": [], "articles": []}, reason="read OK, nothing recorded"),
                                           rc("jira", C.NOT_CHECKED, reason="Jira down"), rc("github", C.NOT_CHECKED, applicable=False), prod_na])
    ck("VERDICT: NOT VERIFIED" in card and "Jira down" in card and "nothing verified against GitHub or production" in card and "read OK, nothing recorded" in card, "an empty card says what it lacks")
    card = render("t", "d", [know, jira_done, pr_open, prod_na])
    ck("VERDICT: CONFLICT" in card and "PR #7: merged=false (state open" in card and "production wins ties" in card, "an unmerged PR next to a Done ticket is a conflict on the card, with the tie rule")
    mw = merge_windows([{"p": 1, "w": "abc def"}, {"p": 5, "w": "def ghi"}, {"p": 100, "w": "far PR #770 here"}])
    ck(mw == ["far PR #770 here", "abc def ghi"], "merge_windows: overlapping windows join into one passage; a PR-citing passage sorts first")
    ck(merge_windows([{"p": 1, "w": "abcdef"}, {"p": 3, "w": "cd"}]) == ["abcdef"], "merge_windows: a window inside another adds nothing")
    ck(merge_windows([{"p": 1, "w": "abc"}, {"p": 4, "w": "def"}]) == ["abcdef"], "merge_windows: adjacent windows join")
    ck(merge_windows([{"p": "x", "w": "bad"}, {"w": "nopos"}, "str", {"p": 1, "w": ""}, None]) == [] and merge_windows(None) == [], "merge_windows: malformed windows are ignored")
    ck(len(merge_windows([{"p": i * 1000, "w": "w%d" % i} for i in range(20)], cap=3)) == 3 and len(merge_windows([{"p": 1, "w": "x" * 2000}])[0]) == 600, "merge_windows: capped in number and length")
    ck(merge_windows([{"p": 1, "w": "no pr fixed here"}, {"p": 500, "w": "PR #12345 there"}])[0] == "PR #12345 there", "merge_windows: PR-citing first, then verbs of change")
    ck(merge_windows([{"p": 1, "w": "plain words"}, {"p": 500, "w": "it was removed"}])[0] == "it was removed", "merge_windows: a verb of change beats plain text")
    long_w = "lead " * 40 + "(PR #922): sweep budget cut 90s to 40s " + "tail " * 40
    ar = _around(long_w, 120)
    ck("#922" in ar and ar.startswith("[...] ") and ar.endswith(" [...]") and len(ar) < 140, "around: centred on the PR citation, gaps marked")
    ck(_around("short", 120) == "short" and _around("", 5) == "", "around: a short text is whole")
    ck("(PR #922)" in render("t", "d", [rc("knowledge", C.PASS, {"memories": [], "articles": [{"slug": "s", "summary": "x", "ctx": [long_w]}]}), jira_done, gh_ok, prod_na]), "an article's PR-citing window reaches the card")
    # Surviving mutants of the first sweep, each turned into a case:
    ck(verdict([know, jira_done, rc("github", C.BLOCK, applicable=False), rc("production", C.PASS)], []) == "not verified", "verdict: a BLOCK anywhere is 'not verified', applicable or not")
    ck(verdict([know, jira_done, rc("github", C.NOT_CHECKED, reason="403"), rc("production", C.PASS)], []) == "not verified", "verdict: one source read and another applicable one unread is 'not verified'")
    ck(verdict([rc("knowledge", C.NOT_CHECKED, applicable=False), jira_done, gh_ok, prod_na], []) == "not verified", "verdict: knowledge must PASS whatever its applicability")
    ck(verdict([know, jira_done, gh_ok, rc("production", C.PASS)], []) == "verified", "verdict: every applicable source PASS and an external one is verified")
    nopub = rc("production", C.PASS, {"articles": [{"slug": "most-comfortable-couches", "webflow_last_published": None}], "runs": [run]})
    ck(conflicts({}, [rc("knowledge", C.PASS, {"memories": [pmem]}), nopub]) == [], "conflicts: an article with no publish date in production has nothing to contradict")
    only_run = {**pmem, "content": "RETRO: run 896655cd (published 2026-09-30)."}
    ck(len(conflicts({}, [rc("knowledge", C.PASS, {"memories": [only_run]}), rc("production", C.PASS, {"articles": [art], "runs": [run]})])) == 1, "conflicts: a memory that names only the run id is still about this article")
    neither = {**pmem, "content": "RETRO: something else (published 2026-09-30)."}
    ck(conflicts({}, [rc("knowledge", C.PASS, {"memories": [neither]}), rc("production", C.PASS, {"articles": [art], "runs": [run]})]) == [], "conflicts: a memory that names neither the slug nor a run is not compared")
    norun = {"id": "", "status": "done", "updated_at": "2026-09-30T00:00"}
    ck(conflicts({}, [rc("knowledge", C.PASS, {"memories": [neither]}), rc("production", C.PASS, {"articles": [art], "runs": [norun]})]) == [], "conflicts: a run with no id never matches every memory")
    onrun = {**pmem, "content": "most-comfortable-couches (published 2026-09-30)."}
    ck(conflicts({}, [rc("knowledge", C.PASS, {"memories": [onrun]}), rc("production", C.PASS, {"articles": [art], "runs": [{**run, "updated_at": "2026-09-30T08:00"}]})]) == [], "conflicts: a date that matches a run's own last update is not a contradiction")
    sup = discover([], {"memories": [{**mem, "id": "s1", "superseded_by": "z", "content": "PR #7000 LC-7000"}]}, {})
    ck(sup == {"tickets": [], "prs": []}, "discover: a memory that has a successor contributes nothing")
    ck("STATE (Jira, newest comment):\n  - Jira down" in render("t", "d", [know, rc("jira", C.NOT_CHECKED, reason="Jira down"), rc("github", C.NOT_CHECKED, applicable=False), prod_na]), "render: an unread Jira says why in the STATE block itself")
    ck("nothing verified against GitHub or production" not in render("t", "d", [know, jira_done, rc("github", C.NOT_CHECKED, applicable=False), rc("production", C.PASS, {"alerts": [{"check_type": "x", "severity": "info", "open": False}]})]), "render: any production fact, even only an alert, is something verified")
    ck("nothing verified against GitHub or production" in render("t", "d", [know, jira_done, rc("github", C.NOT_CHECKED, applicable=False), rc("production", C.PASS, {})]), "render: with no external fact at all the card says so")
    only_art = render("t", "d", [rc("knowledge", C.PASS, {"memories": [], "articles": [{"slug": "s", "summary": "x"}]}, reason="no memories here"), jira_done, gh_ok, prod_na])
    ck("no memories here" not in only_art.split("STATE")[0], "render: articles alone are knowledge; the 'nothing' line is for neither")
    ck(_clip("a  b\nc", 10) == "a b c" and _clip("x" * 50, 10) == "x" * 9 + "…" and _clip(None, 5) == "", "clip")
    ck(_day("2026-09-03T10:00") == "2026-09-03" and _day(None) == "", "day")
    for f in fails:
        print("FAIL:", f)
    print(f"wws_card selftest: {total[0] - len(fails)}/{total[0]} checks passed")
    return 1 if fails else 0


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        sys.exit(_selftest())
    print(__doc__)
