#!/usr/bin/env python3
"""wws_checks — one check per source, each with its own PASS / BLOCK / NOT CHECKED receipt (LC-1893).

ONE JOB PER FUNCTION. Each check reads ONLY its own slice of the evidence and answers one
question. None of them fetches anything (the mod does that) and none of them knows about the
others, so each re-runs alone in milliseconds after a data fix, and a failed source cannot
fail another.

  check_knowledge   what do active memories / articles say, walked to the END of every
                    supersession chain (knowledge-system skill, rule 9)?
  check_jira        what state is each ticket in, per its NEWEST comment (CLAUDE.md section 1,
                    the LC-1345 story)? Title and status alone never PASS.
  check_github      is every cited PR merged into main?
  check_production  does production (published date, run status, schema_migrations) agree?
  check_decision_moot  is a decision the newest comment still calls open about something production
                    says has already happened (article published, run closed)? Logic: wws_moot.py (LC-1907)

Verdict vocabulary -- the same one every guard in this repo uses:
  PASS         the source was read and had nothing wrong with it
  BLOCK        the source was read and shows a defect (a PR not merged, a migration not applied,
               a broken supersession chain)
  NOT CHECKED  the source was not read, or could not answer. NEVER counts as verified.

Receipt: {source, verdict, applicable, reason, facts}. `applicable` is False only when nothing
in the topic points at this source (no PR cited, no slug named); the card does not demand a
PASS from an inapplicable source, but still prints it as NOT CHECKED.

Self-test: python3 wws_checks.py --selftest
"""
from __future__ import annotations

import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import wws_moot  # noqa: E402

PASS, BLOCK, NOT_CHECKED = "PASS", "BLOCK", "NOT CHECKED"
DONE_WORDS = frozenset({"done", "closed", "resolved", "complete", "completed", "cancelled", "canceled",
                        "won't do", "won't fix", "wont do", "wont fix"})
RUN_DONE = frozenset({"done", "completed"})
KEY = re.compile(r"\b[A-Z][A-Z0-9]{1,9}-\d{1,6}\b")


def receipt(source: str, verdict: str, reason: str, facts=None, applicable: bool = True) -> dict:
    return {"source": source, "verdict": verdict, "applicable": applicable, "reason": reason, "facts": facts or {}}


def _count(v) -> int:
    """A comment total as an int; anything unreadable, missing or null is -1 (unknown), which is not zero."""
    try:
        return int(v)  # int(None) raises TypeError: a null total is -1, not 0
    except (TypeError, ValueError):
        return -1


def is_done_status(status: str) -> bool:
    return str(status or "").strip().lower() in DONE_WORDS


def check_knowledge(ev: dict) -> dict:
    """Active memories and non-outdated articles, with every superseded memory walked to its
    terminal node. A chain that ends nowhere, or in a deactivated memory, is a BLOCK: the topic
    has no canonical record and a session must not quote the predecessor."""
    if not isinstance(ev, dict) or not ev.get("ok"):
        why = (ev or {}).get("error") if isinstance(ev, dict) else None
        return receipt("knowledge", NOT_CHECKED, f"knowledge tables not read: {why or 'no evidence'}")
    rows = {str(m.get("id")): m for m in ev.get("memories") or [] if m.get("id")}
    canonical = [m for m in rows.values() if m.get("is_active") and not m.get("superseded_by")]
    # Most relevant first (how many of the topic's terms the memory matches), newest first within a score.
    canonical.sort(key=lambda m: (_count(m.get("score")), str(m.get("created") or "")), reverse=True)
    chains, broken = [], []
    for m in sorted(rows.values(), key=lambda r: str(r.get("created") or "")):
        if not m.get("superseded_by"):
            continue
        seen, cur = {str(m["id"])}, m
        while cur.get("superseded_by") and str(cur["superseded_by"]) not in seen:
            nxt = rows.get(str(cur["superseded_by"]))
            if nxt is None:
                broken.append(f"{str(m['id'])[:8]} -> {str(cur['superseded_by'])[:8]} (successor not readable)")
                cur = None
                break
            seen.add(str(nxt["id"]))
            cur = nxt
        if cur is None:
            continue
        if cur.get("superseded_by"):
            broken.append(f"{str(m['id'])[:8]}: supersession loop")
        elif not cur.get("is_active"):
            broken.append(f"{str(m['id'])[:8]} -> {str(cur['id'])[:8]} (terminal is deactivated, no replacement)")
        else:
            chains.append({"from": str(m["id"]), "terminal": str(cur["id"])})
    arts = [a for a in ev.get("articles") or [] if a.get("slug")]
    facts = {"memories": canonical, "superseded": chains, "articles": arts}
    if broken:
        return receipt("knowledge", BLOCK, "broken supersession chain: " + "; ".join(broken), facts)
    n = f"{len(canonical)} active memories, {len(arts)} articles, {len(chains)} superseded"
    if not canonical and not arts:
        return receipt("knowledge", PASS, "read OK, nothing recorded on this topic", facts)
    return receipt("knowledge", PASS, n, facts)


def check_jira(ev: dict) -> dict:
    """Per ticket: status, last update and the NEWEST comment with its date. A ticket whose
    comments exist but whose newest one was not read is NOT CHECKED -- a title and a status are
    the description of the finding, not of the state."""
    if not isinstance(ev, dict) or not ev.get("ok"):
        why = (ev or {}).get("error") if isinstance(ev, dict) else None
        return receipt("jira", NOT_CHECKED, f"Jira not read: {why or 'no evidence'}")
    tickets = ev.get("tickets") or []
    if not tickets:
        return receipt("jira", NOT_CHECKED, "no ticket named by the topic or the sources", applicable=False)
    good, missing = [], []
    for t in tickets:
        key = str(t.get("key") or "?")
        if t.get("error"):
            missing.append(f"{key}: {t['error']}")
        elif not t.get("status"):
            missing.append(f"{key}: status not read")
        elif _count(t.get("total")) != 0 and not (t.get("comment") or {}).get("created"):
            missing.append(f"{key}: has comments but the newest was not read")
        else:
            good.append(t)
    facts = {"tickets": good}
    if missing:
        return receipt("jira", NOT_CHECKED, "; ".join(missing), facts)
    return receipt("jira", PASS, f"{len(good)} ticket(s), newest comment read for each", facts)


def check_github(ev: dict) -> dict:
    """Is each cited PR merged into main? Merged into another base is not 'on main'."""
    asked = (ev or {}).get("asked") if isinstance(ev, dict) else None
    if not asked:
        return receipt("github", NOT_CHECKED, "no PR cited by the sources", applicable=False)
    if not ev.get("ok"):
        return receipt("github", NOT_CHECKED, f"GitHub not read: {ev.get('error') or 'no answer'}")
    got = {int(p["number"]): p for p in ev.get("prs") or [] if p.get("number") is not None}
    blocks, missing, ok = [], [], []
    for n in asked:
        p = got.get(int(n))
        if p is None or p.get("error"):
            missing.append(f"#{n}: {(p or {}).get('error') or 'not read'}")
        elif not p.get("merged"):
            blocks.append(f"#{n} is {p.get('state') or 'not merged'}, not merged")
        elif not p.get("base"):
            missing.append(f"#{n}: merged, but the base branch was not in the response")
        elif str(p.get("base") or "") != "main":
            blocks.append(f"#{n} merged into {p.get('base')}, not main")
        else:
            ok.append(p)
    facts = {"prs": [got[k] for k in sorted(got)]}
    if blocks:
        return receipt("github", BLOCK, "; ".join(blocks + missing), facts)
    if missing:
        return receipt("github", NOT_CHECKED, "; ".join(missing), facts)
    return receipt("github", PASS, f"{len(ok)} cited PR(s) merged into main", facts)


def check_production(ev: dict) -> dict:
    """Production facts for what the topic names: article publish date, newest run status,
    migration in schema_migrations, deployed function version. Jira statuses and old task lists
    are claims about the past; this is the only source that reads the present."""
    asked = (ev or {}).get("asked") if isinstance(ev, dict) else None
    asked = asked or {}
    if not any(asked.get(k) for k in ("slugs", "runs", "migrations", "functions")):
        return receipt("production", NOT_CHECKED, "nothing production-checkable named", applicable=False)
    if not ev.get("ok"):
        return receipt("production", NOT_CHECKED, f"production not read: {ev.get('error') or 'no answer'}")
    articles, runs = ev.get("articles") or [], ev.get("runs") or []
    migs, fns = ev.get("migrations") or [], ev.get("functions") or []
    have_mig = {str(m.get("version")) for m in migs}
    blocks = [f"migration {v} not in schema_migrations" for v in asked.get("migrations") or [] if str(v) not in have_mig]
    missing = []
    for s in asked.get("slugs") or []:
        if not any(str(a.get("slug") or "") == s or s in str(a.get("slug") or "") for a in articles):
            missing.append(f"article '{s}' not found")
    for r in asked.get("runs") or []:
        if not any(str(x.get("id") or "").startswith(r) for x in runs):
            missing.append(f"run {r} not found")
    for f in asked.get("functions") or []:
        if not any(str(x.get("slug") or "") == f for x in fns):
            missing.append(f"function {f} not found")
    crons, alerts = ev.get("crons") or [], ev.get("alerts") or []
    facts = {"articles": articles, "runs": runs, "migrations": migs, "functions": fns, "crons": crons, "alerts": alerts}
    if blocks:
        return receipt("production", BLOCK, "; ".join(blocks + missing), facts)
    if missing:
        return receipt("production", NOT_CHECKED, "; ".join(missing), facts)
    return receipt("production", PASS, f"{len(articles)} article(s), {len(runs)} run(s), {len(migs)} migration(s), {len(fns)} function(s), {len(crons)} cron(s), {len(alerts)} alert(s) read", facts)


def check_decision_moot(evidence: dict) -> dict:
    """The moot-decision receipt (LC-1907). It reads two slices (Jira's newest comments, production's runs and
    articles), so unlike the four above it is handed the whole evidence object; the test itself is wws_moot.check."""
    ev = evidence if isinstance(evidence, dict) else {}
    try:
        return wws_moot.check(ev.get("jira") or {}, ev.get("moot_production"), ev.get("production"))
    except Exception as exc:  # noqa: BLE001 -- same containment as run_all: a crash is NOT CHECKED, never a pass
        return receipt(wws_moot.SOURCE, NOT_CHECKED, f"check crashed: {type(exc).__name__}")


CHECKS = (("knowledge", check_knowledge), ("jira", check_jira), ("github", check_github), ("production", check_production))


def run_all(evidence: dict) -> list:
    """Every check over its own slice; a check that raises is NOT CHECKED, never a crash."""
    out = []
    for name, fn in CHECKS:
        try:
            out.append(fn((evidence or {}).get(name) or {}))
        except Exception as exc:  # noqa: BLE001 -- one source failing must not take the card down
            out.append(receipt(name, NOT_CHECKED, f"check crashed: {type(exc).__name__}"))
    out.append(check_decision_moot(evidence))
    return out


def _selftest() -> int:
    fails: list[str] = []
    total = [0]

    def ck(cond: bool, msg: str) -> None:
        total[0] += 1
        if not cond:
            fails.append(msg)

    m = lambda i, **k: {"id": i, "is_active": True, "superseded_by": None, "created": "2026-07-04", **k}  # noqa: E731

    ck(check_knowledge({})["verdict"] == NOT_CHECKED, "no evidence is NOT CHECKED")
    ck(check_knowledge({"ok": False, "error": "timeout"})["verdict"] == NOT_CHECKED, "unread knowledge is NOT CHECKED")
    ck("timeout" in check_knowledge({"ok": False, "error": "timeout"})["reason"], "the reason names the error")
    r = check_knowledge({"ok": True, "memories": [], "articles": []})
    ck(r["verdict"] == PASS and "nothing recorded" in r["reason"], "a read that finds nothing PASSes and says so")
    r = check_knowledge({"ok": True, "memories": [m("a"), m("b", created="2026-09-01")], "articles": [{"slug": "alert-calibration"}]})
    ck(r["verdict"] == PASS and [x["id"] for x in r["facts"]["memories"]] == ["b", "a"], "canonical memories newest first")
    ck(r["facts"]["articles"][0]["slug"] == "alert-calibration", "articles are carried")
    r2 = check_knowledge({"ok": True, "memories": [m("new", created="2026-10-20", score=1), m("rel", created="2026-07-04", score=2)]})
    ck([x["id"] for x in r2["facts"]["memories"]] == ["rel", "new"], "a more relevant memory outranks a newer one")
    ck("2 active memories, 1 articles" in r["reason"], "counts in the reason")
    old = m("old", is_active=False, superseded_by="mid")
    mid = m("mid", is_active=False, superseded_by="new")
    new = m("new")
    r = check_knowledge({"ok": True, "memories": [old, mid, new]})
    ck(r["verdict"] == PASS and {"from": "old", "terminal": "new"} in r["facts"]["superseded"], "a chain walks to the terminal node")
    ck([x["id"] for x in r["facts"]["memories"]] == ["new"], "a superseded memory is never canonical")
    r = check_knowledge({"ok": True, "memories": [m("x", is_active=False, superseded_by="gone")]})
    ck(r["verdict"] == BLOCK and "not readable" in r["reason"], "a successor we cannot read is a BLOCK")
    r = check_knowledge({"ok": True, "memories": [m("x", is_active=False, superseded_by="y"), m("y", is_active=False)]})
    ck(r["verdict"] == BLOCK and "deactivated" in r["reason"], "a deactivated terminal is a BLOCK")
    r = check_knowledge({"ok": True, "memories": [m("x", is_active=False, superseded_by="y"), m("y", is_active=False, superseded_by="x")]})
    ck(r["verdict"] == BLOCK and "loop" in r["reason"], "a supersession loop is a BLOCK, not a hang")
    ck(check_knowledge({"ok": True, "memories": [{"is_active": True}]})["facts"]["memories"] == [], "a row without an id is ignored")

    ck(check_jira({})["verdict"] == NOT_CHECKED, "no Jira evidence")
    ck(check_jira({"ok": False, "error": "401"})["verdict"] == NOT_CHECKED, "unread Jira")
    r = check_jira({"ok": True, "tickets": []})
    ck(r["verdict"] == NOT_CHECKED and r["applicable"] is False, "no ticket: NOT CHECKED and inapplicable")
    full = {"key": "LC-1", "status": "Done", "total": 2, "comment": {"created": "2026-09-03T10:00", "body": "x"}}
    ck(check_jira({"ok": True, "tickets": [full]})["verdict"] == PASS, "status plus newest comment PASSes")
    ck(check_jira({"ok": True, "tickets": [{**full, "comment": None}]})["verdict"] == NOT_CHECKED,
       "comments exist but newest unread: NOT CHECKED, never a title-and-status PASS")
    ck(check_jira({"ok": True, "tickets": [{**full, "total": 0, "comment": None}]})["verdict"] == PASS, "zero comments is a real answer")
    ck(check_jira({"ok": True, "tickets": [{**full, "status": ""}]})["verdict"] == NOT_CHECKED, "no status")
    r = check_jira({"ok": True, "tickets": [full, {"key": "LC-2", "error": "404"}]})
    ck(r["verdict"] == NOT_CHECKED and "LC-2: 404" in r["reason"] and len(r["facts"]["tickets"]) == 1, "one unreadable ticket does not hide the other")
    ck(check_jira({"ok": True, "tickets": [{**full, "total": None, "comment": None}]})["verdict"] == NOT_CHECKED and _count(None) == -1 and _count(0) == 0 and _count("3") == 3, "a null or missing comment total is unknown (-1), never zero")
    ck(check_jira({"ok": True, "tickets": [{**full, "total": "x", "comment": None}]})["verdict"] == NOT_CHECKED,
       "an unreadable comment total is unknown, not zero")

    ck(check_github({})["applicable"] is False, "no PR cited is inapplicable")
    ck(check_github({"asked": [1], "ok": False, "error": "403"})["verdict"] == NOT_CHECKED, "unread GitHub")
    pr = {"number": 694, "state": "closed", "merged": True, "base": "main", "merged_at": "2026-07-05"}
    ck(check_github({"asked": [694], "ok": True, "prs": [pr]})["verdict"] == PASS, "merged into main PASSes")
    ck(check_github({"asked": [694], "ok": True, "prs": [{**pr, "merged": False, "state": "open"}]})["verdict"] == BLOCK, "an open PR BLOCKs")
    r = check_github({"asked": [694], "ok": True, "prs": [{**pr, "base": "dev"}]})
    ck(r["verdict"] == BLOCK and "not main" in r["reason"], "merged elsewhere is not on main")
    r = check_github({"asked": [694, 770], "ok": True, "prs": [pr]})
    ck(r["verdict"] == NOT_CHECKED and "#770" in r["reason"], "a PR we could not read is NOT CHECKED")
    r = check_github({"asked": [694, 770], "ok": True, "prs": [{**pr, "merged": False}, ]})
    ck(r["verdict"] == BLOCK and "#770" in r["reason"], "a BLOCK still lists what was unread")
    ck(check_github({"asked": [5], "ok": True, "prs": [{"number": 5, "error": "404"}]})["verdict"] == NOT_CHECKED, "per-PR error")
    r = check_github({"asked": [694], "ok": True, "prs": [{**pr, "base": None}]})
    ck(r["verdict"] == NOT_CHECKED and "base branch was not in the response" in r["reason"], "a merged PR with no base is NOT CHECKED, not a BLOCK")

    ck(check_production({})["applicable"] is False, "nothing named is inapplicable")
    ck(check_production({"asked": {"slugs": ["a"]}, "ok": False, "error": "x"})["verdict"] == NOT_CHECKED, "unread production")
    art = {"slug": "most-comfortable-couches", "webflow_last_published": "2026-10-08T00:00:00Z"}
    run = {"id": "896655cd-0000", "status": "done"}
    r = check_production({"asked": {"slugs": ["most-comfortable-couches"], "runs": ["896655cd"]}, "ok": True, "articles": [art], "runs": [run]})
    ck(r["verdict"] == PASS, "article and run found PASS")
    r = check_production({"asked": {"slugs": ["nope"]}, "ok": True, "articles": [art]})
    ck(r["verdict"] == NOT_CHECKED and "'nope' not found" in r["reason"], "an unfound slug is NOT CHECKED")
    r = check_production({"asked": {"runs": ["deadbeef"]}, "ok": True, "runs": [run]})
    ck(r["verdict"] == NOT_CHECKED and "run deadbeef" in r["reason"], "an unfound run")
    r = check_production({"asked": {"migrations": ["20260101000000"]}, "ok": True, "migrations": []})
    ck(r["verdict"] == BLOCK and "not in schema_migrations" in r["reason"], "an unapplied migration BLOCKs")
    ck(check_production({"asked": {"migrations": ["20260101000000"]}, "ok": True, "migrations": [{"version": "20260101000000"}]})["verdict"] == PASS, "applied migration")
    ck(check_production({"asked": {"functions": ["catalog-ingest"]}, "ok": True, "functions": [{"slug": "catalog-ingest", "version": 12}]})["verdict"] == PASS, "function found")
    ck(check_production({"asked": {"functions": ["catalog-ingest"]}, "ok": True, "functions": []})["verdict"] == NOT_CHECKED, "function missing")
    ck(check_production({"asked": {"slugs": ["couches"]}, "ok": True, "articles": [art]})["verdict"] == PASS, "a partial slug matches")
    r = check_production({"asked": {"functions": ["catalog-ingest"]}, "ok": True, "functions": [{"slug": "catalog-ingest"}], "crons": [{"jobname": "daily-catalog-ingest"}], "alerts": [{"check_type": "cron_http_failure"}]})
    ck(r["facts"]["crons"][0]["jobname"] == "daily-catalog-ingest" and r["facts"]["alerts"][0]["check_type"] == "cron_http_failure" and "1 cron(s), 1 alert(s)" in r["reason"], "crons and alerts are carried")

    rs = run_all({"knowledge": {"ok": True, "memories": []}})
    ck([x["source"] for x in rs] == ["knowledge", "jira", "github", "production", "decision_moot"], "run_all covers every source in order")
    ck(rs[1]["verdict"] == NOT_CHECKED and rs[2]["verdict"] == NOT_CHECKED, "missing slices are NOT CHECKED")
    ck(run_all({"jira": "garbage"})[1]["verdict"] == NOT_CHECKED, "garbage evidence is NOT CHECKED, not a crash")
    ck(run_all(None)[0]["verdict"] == NOT_CHECKED, "no evidence at all")
    boom = run_all({"github": {"asked": [1], "ok": True, "prs": [{"number": "x"}]}})
    ck(boom[2]["verdict"] == NOT_CHECKED, "a crashing check is contained")
    ck(is_done_status("Done") and is_done_status(" CLOSED ") and not is_done_status("To Do") and not is_done_status(None), "done words")
    # Surviving mutants of the first sweep, each turned into a case:
    ck(receipt("s", PASS, "r")["applicable"] is True and receipt("s", PASS, "r", applicable=False)["applicable"] is False, "a receipt is applicable unless said otherwise")
    r = check_knowledge({"ok": True, "memories": [m("a", superseded_by="b"), m("b")]})
    ck([x["id"] for x in r["facts"]["memories"]] == ["b"], "an active memory that has a successor is not canonical")
    r = check_knowledge({"ok": True, "memories": [m("c", is_active=False)]})
    ck(r["facts"]["memories"] == [] and "nothing recorded" in r["reason"], "a deactivated memory with no successor is not canonical")
    r = check_knowledge({"ok": True, "memories": [m("late", is_active=False, superseded_by="g1", created="2026-02-01"), m("none", is_active=False, superseded_by="g2", created=None), m("early", is_active=False, superseded_by="g3", created="2026-01-01")]})
    ck(r["reason"].index("none") < r["reason"].index("early") < r["reason"].index("late"), "broken chains are listed oldest first, an undated one first of all")
    ck("1 active memories, 0 articles" in check_knowledge({"ok": True, "memories": [m("a")]})["reason"] and "0 active memories, 1 articles" in check_knowledge({"ok": True, "articles": [{"slug": "s"}]})["reason"], "memories alone or articles alone are a real answer, not 'nothing recorded'")
    ck(check_jira({"tickets": [full]})["verdict"] == NOT_CHECKED and check_jira("garbage")["verdict"] == NOT_CHECKED and "401" in check_jira({"ok": False, "error": "401"})["reason"], "jira: no ok flag, a non-dict or an error is NOT CHECKED and names the error")
    ck(check_github({"asked": [1], "prs": [pr]})["verdict"] == NOT_CHECKED and "403" in check_github({"asked": [1], "ok": False, "error": "403"})["reason"], "github: no ok flag is NOT CHECKED; the error is named")
    ck("#5: not read" in check_github({"asked": [5], "ok": True, "prs": []})["reason"], "github: a PR that was never returned is 'not read'")
    ck("#5 is not merged, not merged" in check_github({"asked": [5], "ok": True, "prs": [{"number": 5, "merged": False}]})["reason"], "github: an unmerged PR with no state still says so")
    ck(check_production({"asked": {"slugs": ["a"]}, "articles": [art]})["verdict"] == NOT_CHECKED and "boom" in check_production({"asked": {"slugs": ["a"]}, "ok": False, "error": "boom"})["reason"], "production: no ok flag is NOT CHECKED; the error is named")
    ck(run_all({"knowledge": {"ok": True, "memories": []}})[0]["verdict"] == PASS, "run_all hands each check its own evidence")
    dm = {"ok": True, "tickets": [{"key": "LC-1", "status": "To Do", "total": 1, "comment": {"id": "9", "created": "2026-10-22T00:00Z", "body": "Awaiting operator ruling."}, "comments": [{"id": "9", "created": "2026-10-22T00:00Z", "q": [], "r": [], "s": []}], "comments_complete": True}]}
    linked = {"ok": True, "articles": [], "runs": [{"id": "abcd1234", "article_slug": "x-y-z", "status": "done", "updated_at": "2026-10-23T00:00Z", "jira_keys": ["LC-1"]}]}
    ck(check_decision_moot({"jira": dm, "moot_production": linked})["verdict"] == BLOCK, "check_decision_moot: a closed run linked to the ticket BLOCKs")
    ck(check_decision_moot({"jira": dm, "production": linked})["verdict"] == NOT_CHECKED, "check_decision_moot: the topic's own production slice does not stand in for the moot read")
    ck(check_decision_moot({"jira": dm, "production": {"ok": True}, "moot_production": {"ok": False, "error": "x"}})["verdict"] == NOT_CHECKED, "check_decision_moot: a failed moot read is NOT CHECKED even when the topic read was fine")
    ck(check_decision_moot({"jira": dm})["verdict"] == NOT_CHECKED and check_decision_moot(None)["applicable"] is False, "check_decision_moot: no production slice, or no evidence at all, is NOT CHECKED")
    for f in fails:
        print("FAIL:", f)
    print(f"wws_checks selftest: {total[0] - len(fails)}/{total[0]} checks passed")
    return 1 if fails else 0


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        sys.exit(_selftest())
    print(__doc__)
