#!/usr/bin/env python3
"""where-we-stand — the lookup behind the card (LC-1893). Read-only everywhere.

This file is the thin joint between the mod (register.ts, which owns the network calls and the
session limits) and the four single-job modules next to it:

  wws_trigger   WHEN is a card worth injecting?
  wws_checks    four sources, four receipts (PASS / BLOCK / NOT CHECKED)
  wws_card      conflicts, verdict, rendering

It does two more small things, both pure: it BUILDS the read-only SQL (so the queries live in
one reviewed place, not in TypeScript), and it PARSES what came back into the evidence the
checks read. It never opens a socket. register.ts runs the SQL through the session's own
Supabase MCP and calls GitHub through the session's own GitHub MCP, so the card needs no new
credential, no Edge Function and no cron.

Protocol: `python3 -I where-we-stand.py` reads ONE JSON object from stdin,
{"cmd": "...", ...}, and prints one JSON object. Commands:

  trigger          {tool_name, tool_input}                   -> wws_trigger.classify
  sql_knowledge    {terms, tickets}                          -> {sql}
  sql_production   {terms, tickets, kind}                    -> {sql, asked}
  sql_jira_fire    {tickets}                                 -> {sql}      (pg_net GETs, Jira)
  sql_jira_collect {req_ids}                                 -> {sql}
  parse_knowledge  {rows, terms?, tickets?} | {error}        -> {evidence}
  parse_production {rows, asked, functions_raw?, terms} | {error} -> {evidence}
  discover         {tickets, knowledge, production, jira?}   -> {tickets, prs}
  parse_jira       {tickets, fired, collected} | {error}     -> {evidence}
  parse_prs        {asked, items:[{number, text|error}]} | {error} -> {evidence}
  render           {topic, today, evidence, terms?, tickets?} -> {card, verdict, receipts}
  normalize        {tickets?, terms?, kind?}                 -> {kind, topic, tickets, terms}  (on-demand tool)
  branch_ticket    {branch}                                  -> {tickets}  (the session's own ticket)
  gate             {transcript_path, stop_hook_active, cards} -> {block?}   (wws_gate)

Every identifier that reaches SQL is shape-checked first (ticket key, lowercase slug-like term,
14-digit version, integer id); anything else is dropped, never quoted.

Self-test: python3 where-we-stand.py --selftest
"""
from __future__ import annotations

import html
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import wws_card  # noqa: E402
import wws_checks  # noqa: E402
import wws_gate  # noqa: E402
import wws_trigger  # noqa: E402

TICKET = wws_trigger.TICKET
TERM = wws_trigger.TERM
VERSION = re.compile(r"^\d{14}$")
RUN_ID = wws_trigger.RUN_ID
BRANCH_TICKET = re.compile(r"^(lch|lcc|lc|bbm)(\d{1,6})(?:[-_]|$)", re.IGNORECASE)
KINDS = ("ticket-status", "diagnosis", "article-status")
JIRA_BASE = "https://b-b-m.atlassian.net/rest/api/2/"
JIRA_USER = "info@brandbridge.media"


def _tickets(vals) -> list:
    return [v for v in dict.fromkeys(str(x).upper() for x in vals or []) if TICKET.match(v)]


def _terms(vals) -> list:
    return [v for v in dict.fromkeys(str(x).lower() for x in vals or []) if TERM.match(v)]


def _arr(vals: list, cast: str = "text") -> str:
    return "array[" + ",".join("'" + v + "'" for v in vals) + f"]::{cast}[]" if vals else f"array[]::{cast}[]"


def sql_knowledge(terms: list, tickets: list) -> str:
    """Memories matching any term or ticket (score = how many match), plus the whole supersession
    chain of every hit so the card can walk to the terminal node; non-outdated articles. SELECT only."""
    needles = _terms(terms) + [t.lower() for t in _tickets(tickets)]
    n = _arr(needles)
    hit = ("lower(t) = any(select lower(x) from unnest(m.topics) x) or m.content ilike '%'||t||'%' "
           "or m.source_id ilike t or m.id::text like t||'%'")
    return (
        f"with recursive t(t) as (select unnest({n})), "
        f"scored as (select m.id, m.created_at, (select count(*) from t where {hit}) s from public.knowledge_memories m), "
        "base as (select id from scored where s > 0 order by s desc, created_at desc limit 12), "
        "chain(id) as (select id from base union select m.superseded_by from public.knowledge_memories m "
        "join chain c on m.id = c.id where m.superseded_by is not null) "
        "select json_build_object("
        "'memories', coalesce((select json_agg(json_build_object('id', m.id, 'is_active', m.is_active, "
        "'superseded_by', m.superseded_by, 'memory_type', m.memory_type, 'source_id', m.source_id, "
        "'created', to_char(m.created_at at time zone 'utc', 'YYYY-MM-DD'), 'content', left(m.content, 1600), """
        "'score', coalesce((select s from scored where scored.id = m.id), 0)) "
        "order by m.created_at desc) from public.knowledge_memories m where m.id in (select id from chain)), '[]'::json), "
        "'articles', coalesce((select json_agg(a) from (select ka.slug, ka.summary, ka.confidence, "
        "to_char(ka.last_verified_at at time zone 'utc', 'YYYY-MM-DD') as last_verified, ka.sc, "
        # `ctx` = the sentences AROUND a topic term. PR numbers and ticket keys are read from these windows
        # in Python (which also drops refs that name another repo), so a long article that cites fifty PRs
        # contributes only the few that are about this topic.
        # `wins` = a window of text around EVERY occurrence of a topic term, with its start position, so Python can
        # merge the overlapping ones (a regexp 'g' match would swallow the next occurrence's right-hand context).
        # Built from regexp_split_to_array, not substr(content, i, n) in a loop: that detoasts the whole article for
        # every character position and timed out at 60 s (measured).
        "(select coalesce(json_agg(json_build_object('p', o.p, 'w', o.w) order by o.p), '[]'::json) from ("
        "select cum.s - length(right(pp.a[k], 170)) as p, right(pp.a[k], 170) || substr(pp.c, cum.s, length(t.t)) || left(pp.a[k + 1], 170) as w "
        "from t, lateral (select left(ka.content, 60000) as c, regexp_split_to_array(left(ka.content, 60000), regexp_replace(t.t, '\\.', '\\\\.', 'g'), 'i') as a) pp, "
        "lateral generate_series(1, coalesce(array_length(pp.a, 1), 1) - 1) k, "
        "lateral (select (coalesce(sum(length(x)), 0) + (k - 1) * length(t.t) + 1)::int as s from unnest(pp.a[1:k]) x) cum "
        "order by (right(pp.a[k], 170) || left(pp.a[k + 1], 170) ~ '#[0-9]{3,5}') desc, cum.s limit 24) o) as wins "
        "from (select a2.slug, a2.title, a2.summary, a2.confidence, a2.last_verified_at, a2.content, "
        "(select count(*) from t where lower(t.t) = any(select lower(x) from unnest(a2.topics) x) or a2.slug ilike '%'||t.t||'%' "
        "or a2.title ilike '%'||t.t||'%' or a2.content ilike '%'||t.t||'%') as sc "
        "from public.knowledge_articles a2 where a2.confidence <> 'outdated') ka "
        "where ka.sc > 0 order by ka.sc desc, ka.last_verified_at desc nulls last limit 3) a), '[]'::json)) as j"
    )


def sql_production(terms: list, tickets: list, kind: str) -> tuple:
    """Publish dates, newest runs and applied migrations for what the topic names. Returns (sql, asked);
    `asked` is what the production check must find -- slugs only for an article-status topic, so a
    job name like catalog-ingest is never reported as an article that was not found."""
    ts = _terms(terms)
    tk = _tickets(tickets)
    versions = [v for v in dict.fromkeys(str(x) for x in terms or []) if VERSION.match(v)]
    run_ids = [v for v in ts if RUN_ID.match(v)]
    slugs = [v for v in ts if not RUN_ID.match(v) and not VERSION.match(v)]
    asked = {"slugs": slugs if kind == "article-status" else [], "runs": run_ids if kind == "article-status" else [],
             "migrations": versions, "functions": []}
    s = _arr(slugs)
    rid = _arr(run_ids)
    diag = kind == "diagnosis"
    names = _arr(ts)
    # For a diagnosis, the present tense is the cron schedule and the alert's own recurrence record, not a
    # ticket: "the 40s budget shipped" is only true if the job runs on the schedule it shipped with.
    extra = (
        ", 'crons', coalesce((select json_agg(c) from (select jobname, schedule, active from cron.job "
        f"where exists (select 1 from unnest({names}) u where jobname ilike '%'||u||'%') limit 3) c), '[]'::json)"
        ", 'alerts', coalesce((select json_agg(a) from (select check_type, severity, recurrence_count, "
        "to_char(last_seen_at at time zone 'utc', 'YYYY-MM-DD\"T\"HH24:MI\"Z\"') as last_seen, resolved_at is null as open "
        f"from public.pipeline_health_log where checked_at > now() - interval '30 days' and exists (select 1 from unnest({names}) u "
        "where details::text ilike '%'||u||'%' or check_type ilike '%'||u||'%') order by last_seen_at desc nulls last limit 3) a), '[]'::json)"
    ) if diag else ""
    sql = (
        "select json_build_object("
        "'articles', coalesce((select json_agg(a) from (select slug, status, "
        "to_char(webflow_last_published at time zone 'utc', 'YYYY-MM-DD\"T\"HH24:MI\"Z\"') as webflow_last_published "
        f"from public.articles where slug = any({s}) or exists (select 1 from unnest({s}) u where slug ilike '%'||u||'%') "
        "order by webflow_last_published desc nulls last limit 3) a), '[]'::json), "
        "'runs', coalesce((select json_agg(r) from (select id, article_slug, status, current_stage, jira_keys, "
        "to_char(updated_at at time zone 'utc', 'YYYY-MM-DD\"T\"HH24:MI\"Z\"') as updated_at "
        f"from public.refresh_runs where article_slug = any({s}) or jira_keys && {_arr(tk)} "
        f"or exists (select 1 from unnest({rid}) u where id::text like u||'%') "
        "order by updated_at desc limit 3) r), '[]'::json), "
        "'migrations', coalesce((select json_agg(g) from (select version, name from supabase_migrations.schema_migrations "
        f"where version = any({_arr(versions)})) g), '[]'::json)" + extra + ") as j"
    )
    return sql, asked


def sql_jira_fire(tickets: list) -> str:
    """Queue one pg_net GET per (ticket, newest comment | issue header). The Basic credential is built
    inside the database from the vault secret and is never selected, so it cannot reach the session."""
    rows = []
    for k in _tickets(tickets):
        rows.append(f"('{k}','c','issue/{k}/comment?orderBy=-created&maxResults=1')")
        rows.append(f"('{k}','i','issue/{k}?fields=summary,status,updated')")
    if not rows:
        return "select null::text as k, null::text as kind, null::bigint as req where false"
    return (
        "with s as (select 'Basic ' || replace(encode(convert_to('" + JIRA_USER + ":' || decrypted_secret, 'utf8'), 'base64'), E'\\n', '') a "
        "from vault.decrypted_secrets where name = 'jira_api_token') "
        f"select v.k, v.kind, net.http_get(url := '{JIRA_BASE}' || v.p, "
        "headers := jsonb_build_object('Authorization', s.a, 'Accept', 'application/json'), timeout_milliseconds := 15000) as req "
        "from s, (values " + ",".join(rows) + ") v(k, kind, p)"
    )


def sql_jira_collect(req_ids: list) -> str:
    ids = [str(int(i)) for i in req_ids or [] if str(i).lstrip("-").isdigit()]
    return (
        "select id, status_code, error_msg, case when status_code = 200 and content like '{%' then jsonb_build_object("
        "'total', (content::jsonb)->'total', 'created', (content::jsonb)->'comments'->0->>'created', "
        "'author', (content::jsonb)->'comments'->0->'author'->>'displayName', "
        "'body', left((content::jsonb)->'comments'->0->>'body', 1500), "
        "'status', (content::jsonb)->'fields'->'status'->>'name', 'summary', (content::jsonb)->'fields'->>'summary', "
        "'updated', (content::jsonb)->'fields'->>'updated') end as j "
        f"from net._http_response where id = any(array[{','.join(ids)}]::bigint[])"
    )


def _obj(v):
    if isinstance(v, str):
        try:
            return json.loads(v)
        except ValueError:
            return None
    return v


def parse_knowledge(p: dict) -> dict:
    if p.get("error"):
        return {"ok": False, "error": str(p["error"])[:200]}
    j = _obj((p.get("rows") or [{}])[0].get("j")) if p.get("rows") else None
    if not isinstance(j, dict):
        return {"ok": False, "error": "knowledge query returned no row"}
    arts = []
    for a in j.get("articles") or []:
        a = dict(a)
        a["ctx"] = wws_card.merge_windows(a.pop("wins", []))  # raw windows never leave this function
        arts.append(a)
    return {"ok": True, "memories": j.get("memories") or [], "articles": arts}


def parse_production(p: dict) -> dict:
    asked = dict(p.get("asked") or {})
    if p.get("error"):
        return {"ok": False, "error": str(p["error"])[:200], "asked": asked}
    j = _obj((p.get("rows") or [{}])[0].get("j")) if p.get("rows") else None
    if not isinstance(j, dict):
        return {"ok": False, "error": "production query returned no row", "asked": asked}
    terms = set(_terms(p.get("terms")))
    fns = [f for f in p.get("functions_raw") or [] if str(f.get("slug") or "") in terms]
    if fns:
        asked["functions"] = [f["slug"] for f in fns]
    return {"ok": True, "asked": asked, "articles": j.get("articles") or [], "runs": j.get("runs") or [],
            "migrations": j.get("migrations") or [], "crons": j.get("crons") or [], "alerts": j.get("alerts") or [],
            "functions": [{"slug": f.get("slug"), "version": f.get("version"),
                           "updated_at": _fn_day(f.get("updated_at"))} for f in fns]}


def _fn_day(v) -> str:
    """Edge-function updated_at arrives as epoch milliseconds or an ISO string."""
    if isinstance(v, (int, float)):
        import datetime
        return datetime.datetime.fromtimestamp(v / 1000, datetime.timezone.utc).strftime("%Y-%m-%d")
    return str(v or "")[:10]


def parse_jira(p: dict) -> dict:
    if p.get("error"):
        return {"ok": False, "error": str(p["error"])[:200]}
    fired = p.get("fired") or []
    got = {int(r["id"]): r for r in p.get("collected") or [] if r.get("id") is not None}
    out = []
    for k in _tickets(p.get("tickets")):
        t: dict = {"key": k, "total": 0, "comment": None}
        for f in (f for f in fired if f.get("k") == k):
            r = got.get(int(f["req"]))
            if r is None:
                t["error"] = "no Jira response in time"
                break
            if r.get("status_code") != 200 or not isinstance(_obj(r.get("j")), dict):
                t["error"] = f"Jira answered {r.get('status_code')} {str(r.get('error_msg') or '')[:80]}".strip()
                break
            j = _obj(r["j"])
            if f.get("kind") == "c":
                t["total"] = j.get("total") or 0
                if j.get("created"):
                    t["comment"] = {"created": j["created"], "author": j.get("author"), "body": j.get("body")}
            else:
                t.update(status=j.get("status"), summary=html.unescape(str(j.get("summary") or "")), updated=j.get("updated"))
        out.append(t)
    return {"ok": True, "tickets": out}


def parse_prs(p: dict) -> dict:
    asked = [int(n) for n in p.get("asked") or [] if str(n).isdigit()]
    if p.get("error"):
        return {"ok": False, "error": str(p["error"])[:200], "asked": asked}
    prs = []
    for it in p.get("items") or []:
        n = it.get("number")
        d = _obj(it.get("text")) if it.get("text") else None
        if it.get("error") or not isinstance(d, dict):
            prs.append({"number": n, "error": str(it.get("error") or "unreadable PR response")[:120]})
            continue
        prs.append({"number": n, "state": d.get("state"), "merged": bool(d.get("merged")) or bool(d.get("merged_at")),
                    "merged_at": d.get("merged_at"), "updated_at": d.get("updated_at"), "base": (d.get("base") or {}).get("ref"),
                    "sha": d.get("merge_commit_sha") or (d.get("merge_commit") or {}).get("sha"),
                    "head_sha": (d.get("head") or {}).get("sha"),
                    "title": d.get("title"), "keys": sorted(set(wws_checks.KEY.findall(f"{d.get('title') or ''} {d.get('body') or ''}")))})
    return {"ok": True, "asked": asked, "prs": prs}


def normalize(p: dict) -> dict:
    """A hand-made lookup request (the on-demand tool): only validated tickets and terms survive, and
    `kind` defaults so that a job name is never demanded as an article."""
    tickets, terms = _tickets(p.get("tickets")), _terms(p.get("terms"))
    kind = p.get("kind") if p.get("kind") in KINDS else ("ticket-status" if tickets and not terms else "diagnosis")
    return {"kind": kind, "topic": " ".join(tickets + terms)[:80], "tickets": tickets, "terms": terms}


def branch_ticket(branch) -> dict:
    """The ticket a session's own branch names (`lc1893-where-we-stand` -> LC-1893), for the session-start card."""
    m = BRANCH_TICKET.match(str(branch or "").strip().split("/")[-1])
    return {"tickets": [f"{m.group(1).upper()}-{int(m.group(2))}"]} if m else {"tickets": []}


def render(p: dict) -> dict:
    receipts = wws_checks.run_all(p.get("evidence") or {})
    found = wws_card.conflicts({}, receipts)
    terms = _terms(p.get("terms")) + _tickets(p.get("tickets"))
    return {"card": wws_card.render(str(p.get("topic") or "?")[:80], str(p.get("today") or "")[:10], receipts, terms),
            "verdict": wws_card.verdict(receipts, found), "receipts": [{k: r[k] for k in ("source", "verdict", "reason")} for r in receipts]}


def handle(p: dict) -> dict:
    cmd = p.get("cmd")
    if cmd == "trigger":
        return wws_trigger.classify(p.get("tool_name"), p.get("tool_input"))
    if cmd == "sql_knowledge":
        return {"sql": sql_knowledge(p.get("terms"), p.get("tickets"))}
    if cmd == "sql_production":
        sql, asked = sql_production(p.get("terms"), p.get("tickets"), str(p.get("kind") or ""))
        return {"sql": sql, "asked": asked}
    if cmd == "sql_jira_fire":
        return {"sql": sql_jira_fire(p.get("tickets"))}
    if cmd == "sql_jira_collect":
        return {"sql": sql_jira_collect(p.get("req_ids"))}
    if cmd == "parse_knowledge":
        return {"evidence": parse_knowledge(p)}
    if cmd == "parse_production":
        return {"evidence": parse_production(p)}
    if cmd == "discover":
        return wws_card.discover(_tickets(p.get("tickets")), p.get("knowledge"), p.get("production"), p.get("jira"))
    if cmd == "parse_jira":
        return {"evidence": parse_jira(p)}
    if cmd == "parse_prs":
        return {"evidence": parse_prs(p)}
    if cmd == "render":
        return render(p)
    if cmd == "normalize":
        return normalize(p)
    if cmd == "branch_ticket":
        return branch_ticket(p.get("branch"))
    if cmd == "gate":
        why = wws_gate.evaluate(p)
        return {"block": why} if why else {}
    return {"error": f"unknown cmd {cmd!r}"}


def _selftest() -> int:
    fails: list[str] = []
    total = [0]

    def ck(cond: bool, msg: str) -> None:
        total[0] += 1
        if not cond:
            fails.append(msg)

    ck(_tickets(["lc-1", "LC-1", "bad key", "x'; drop", "LCH-22"]) == ["LC-1", "LCH-22"], "tickets: upper-cased, deduped, shape-checked")
    ck(_terms(["Catalog-Ingest", "catalog-ingest", "a'b", "ab", "ok_term"]) == ["catalog-ingest", "ok_term"], "terms: lower-cased, deduped, shape-checked")
    ck(_arr([]) == "array[]::text[]" and _arr(["a-b", "c"]) == "array['a-b','c']::text[]", "array literal")

    k = sql_knowledge(["catalog-ingest", "bad'term"], ["LC-1345", "nope"])
    ck("array['catalog-ingest','lc-1345']::text[]" in k and "bad'term" not in k and "nope" not in k, "knowledge: only validated needles reach SQL")
    ck("union select m.superseded_by" in k and "with recursive t(t)" in k, "knowledge: the supersession chain is fetched recursively (plain WITH cannot self-reference)")
    ck(not re.search(r"\b(insert|update|delete|drop|alter)\b", k, re.IGNORECASE), "knowledge SQL is read-only")
    ck("regexp_split_to_array(left(ka.content, 60000)" in k and "as wins" in k and "limit 24" in k and "regexp_matches(ka.content" not in k and "substr(ka.content" not in k, "knowledge: articles return a window per term occurrence with its position (bounded, no per-character detoast); Python merges the overlapping ones")
    ck("~ '#[0-9]{3,5}') desc, cum.s limit 24" in k, "knowledge: windows that cite a PR come first, so the cap does not cut them")
    ck("substr(pp.c, cum.s, length(t.t))" in k, "knowledge: the matched text in a window is the article's own, not the lowercased search term (verbatim quotes)")
    ck("a2.content ilike '%'||t.t||'%'" in k and "order by ka.sc desc" in k, "knowledge: articles rank by terms matched anywhere in them, body included")
    ck("left(m.content, 1600)" in k, "knowledge: memories keep enough text to cite a PR late in the body")
    ck("'score', coalesce((select s from scored" in k, "knowledge: each memory carries its match score so the card can rank by relevance")
    ck("confidence <> 'outdated'" in k and "limit 12" in k and "limit 3" in k, "knowledge: outdated articles excluded, result sizes capped")
    ck("array[]::text[]" in sql_knowledge([], []), "empty needles still build")

    sql, asked = sql_production(["most-comfortable-couches", "896655cd", "20261008120000"], ["LC-1860"], "article-status")
    ck(asked == {"slugs": ["most-comfortable-couches"], "runs": ["896655cd"], "migrations": ["20261008120000"], "functions": []}, "production: asked for an article-status topic")
    ck("jira_keys && array['LC-1860']::text[]" in sql and "schema_migrations" in sql, "production SQL reads runs by ticket and migrations")
    ck("webflow_last_published" in sql and not re.search(r"\b(insert|update|delete|drop|alter)\b", sql, re.IGNORECASE), "production SQL is read-only")
    _, asked2 = sql_production(["catalog-ingest"], [], "diagnosis")
    ck(asked2["slugs"] == [] and asked2["runs"] == [], "a diagnosis term is never demanded as an article")
    dsql, _ = sql_production(["catalog-ingest"], [], "diagnosis")
    ck("from cron.job" in dsql and "from public.pipeline_health_log" in dsql and "interval '30 days'" in dsql, "a diagnosis also reads the cron schedule and the alert's recurrence record")
    ck("cron.job" not in sql and "pipeline_health_log" not in sql, "an article-status lookup does not")
    ck(not re.search(r"\b(insert|update|delete|drop|alter)\b", dsql, re.IGNORECASE), "diagnosis SQL is read-only")
    ck(sql_production(["bad'x"], [], "article-status")[1]["slugs"] == [], "invalid slug dropped")

    f = sql_jira_fire(["LC-1345", "x y"])
    ck(f.count("net.http_get") == 1 and "('LC-1345','c','issue/LC-1345/comment?orderBy=-created&maxResults=1')" in f, "jira fire: one GET per ticket and kind")
    ck("('LC-1345','i','issue/LC-1345?fields=summary,status,updated')" in f and "x y" not in f, "jira fire: header GET, invalid key dropped")
    ck("decrypted_secret" in f and f.index("select v.k") < f.index("from s,") and "as a" not in f.split("select v.k")[1], "the credential is built in SQL and never selected")
    ck("where false" in sql_jira_fire([]), "no tickets: empty fire")
    c = sql_jira_collect([185661, "185662", "1; drop", None])
    ck("array[185661,185662]::bigint[]" in c and "drop" not in c, "collect: ids are integers only")

    ck(parse_knowledge({"error": "boom"}) == {"ok": False, "error": "boom"}, "knowledge error is carried")
    ck(parse_knowledge({"rows": []})["ok"] is False, "no row is not ok")
    ck(parse_knowledge({"rows": [{"j": {"memories": [{"id": "a"}], "articles": []}}]}) == {"ok": True, "memories": [{"id": "a"}], "articles": []}, "knowledge rows parsed")
    pk = parse_knowledge({"rows": [{"j": {"memories": [], "articles": [{"slug": "s", "sc": 2, "wins": [{"p": 1, "w": "catalog-ingest claimed 8% (see PR #770)"[:25]}, {"p": 20, "w": "catalog-ingest claimed 8% (see PR #770)"[19:]}]}]}}]})
    ck("wins" not in pk["articles"][0] and pk["articles"][0]["ctx"] == ["catalog-ingest claimed 8% (see PR #770)"], "raw windows become merged passages and are dropped from the evidence")
    ck(parse_knowledge({"rows": [{"j": json.dumps({"memories": [], "articles": [{"slug": "s"}]})}]})["articles"] == [{"slug": "s", "ctx": []}], "json as text")
    ck(parse_knowledge({"rows": [{"j": "not json"}]})["ok"] is False, "garbage is not ok")

    pe = parse_production({"error": "e", "asked": {"slugs": ["a"]}})
    ck(pe["ok"] is False and pe["asked"] == {"slugs": ["a"]}, "production error keeps what was asked")
    pj = {"j": {"articles": [{"slug": "a"}], "runs": [], "migrations": []}}
    pp = parse_production({"rows": [pj], "asked": {"slugs": ["a"]}, "terms": ["catalog-ingest"],
                           "functions_raw": [{"slug": "catalog-ingest", "version": 12, "updated_at": 1760000000000}, {"slug": "other", "version": 1}]})
    ck(pp["ok"] and pp["asked"]["functions"] == ["catalog-ingest"] and pp["functions"][0]["version"] == 12, "functions are filtered to the topic")
    ck(pp["functions"][0]["updated_at"] == "2025-10-09", "function updated_at epoch ms becomes a date")
    ck(_fn_day("2026-10-08T01:00:00Z") == "2026-10-08" and _fn_day(None) == "", "fn day from text")
    ck(parse_production({"rows": [], "asked": {}})["ok"] is False, "no production row")
    pc = parse_production({"rows": [{"j": {"articles": [], "runs": [], "migrations": [], "crons": [{"jobname": "daily-catalog-ingest"}], "alerts": [{"check_type": "cron_http_failure"}]}}], "asked": {}, "terms": []})
    ck(pc["crons"][0]["jobname"] == "daily-catalog-ingest" and pc["alerts"][0]["check_type"] == "cron_http_failure", "production: crons and alerts are carried")

    fired = [{"k": "LC-1", "kind": "c", "req": 1}, {"k": "LC-1", "kind": "i", "req": 2}, {"k": "LC-2", "kind": "c", "req": 3}, {"k": "LC-2", "kind": "i", "req": 4}]
    col = [{"id": 1, "status_code": 200, "j": {"total": 2, "created": "2026-09-03T10:00:00.000-0500", "author": "S", "body": "removed"}},
           {"id": 2, "status_code": 200, "j": {"status": "Done", "summary": "s", "updated": "2026-09-16T11:03"}},
           {"id": 3, "status_code": 401, "error_msg": "nope"}]
    pj = parse_jira({"tickets": ["LC-1", "LC-2", "LC-3"], "fired": fired, "collected": col})
    t1, t2, t3 = pj["tickets"]
    ck(pj["ok"] and t1["status"] == "Done" and t1["total"] == 2 and t1["comment"]["author"] == "S", "jira: status and newest comment joined by request id")
    ck(t2["error"].startswith("Jira answered 401"), "jira: an HTTP error is carried on that ticket")
    ck(t3["total"] == 0 and "status" not in t3, "jira: a ticket never fired stays empty (the check turns it into NOT CHECKED)")
    pend = parse_jira({"tickets": ["LC-1"], "fired": fired[:2], "collected": col[:1]})
    ck(pend["tickets"][0]["error"] == "no Jira response in time", "jira: a response that has not arrived is named")
    ck(parse_jira({"error": "down"}) == {"ok": False, "error": "down"}, "jira error")
    ck(parse_jira({"tickets": ["LC-1"], "fired": [fired[1]], "collected": [col[1] | {"j": {"status": "Done", "summary": "Legacy products &amp; brands", "updated": "x"}}]})["tickets"][0]["summary"] == "Legacy products & brands", "jira: HTML entities in a summary are decoded")
    ck("left((content::jsonb)->'comments'->0->>'body', 1500)" in sql_jira_collect([1]), "jira: the newest comment body keeps 1500 characters")
    ck(parse_jira({"tickets": ["LC-1"], "fired": [fired[0]], "collected": [{"id": 1, "status_code": 200, "j": {"total": 0}}]})["tickets"][0]["comment"] is None, "zero comments")

    body = json.dumps({"state": "closed", "merged": True, "merged_at": "2026-07-05T00:00:00Z", "base": {"ref": "main"}, "title": "LCH-224 fix", "body": "Refs LC-1345"})
    pr = parse_prs({"asked": [694, "x", 770], "items": [{"number": 694, "text": body}, {"number": 770, "error": "404"}]})
    ck(pr["asked"] == [694, 770] and pr["prs"][0]["merged"] and pr["prs"][0]["base"] == "main", "PR parsed")
    ck(pr["prs"][0]["keys"] == ["LC-1345", "LCH-224"] and pr["prs"][1]["error"] == "404", "PR keys from title and body; per-PR error")
    shaed = parse_prs({"asked": [1, 2], "items": [{"number": 1, "text": json.dumps({"state": "closed", "merged": True, "merge_commit_sha": "abc123", "updated_at": "2026-07-05T00:00:00Z", "base": {"ref": "main"}})},
                                                  {"number": 2, "text": json.dumps({"state": "closed", "merged": True, "merge_commit": {"sha": "def456"}, "base": {"ref": "main"}})}]})
    ck(shaed["prs"][0]["sha"] == "abc123" and shaed["prs"][0]["updated_at"] == "2026-07-05T00:00:00Z" and shaed["prs"][1]["sha"] == "def456", "PR evidence carries the merge commit sha and the last update")
    ck(parse_prs({"asked": [1], "items": [{"number": 1, "text": json.dumps({"state": "open", "merged": False, "base": {"ref": "main"}})}]})["prs"][0]["merged"] is False, "open PR")
    ck(parse_prs({"asked": [1], "items": [{"number": 1, "text": json.dumps({"state": "closed", "merged_at": "2026-01-01", "base": {}})}]})["prs"][0]["merged"] is True, "merged_at implies merged")
    ck(parse_prs({"asked": [1], "items": [{"number": 1, "text": "garbage"}]})["prs"][0]["error"] == "unreadable PR response", "garbage PR")
    ck(parse_prs({"asked": [1], "error": "403"}) == {"ok": False, "error": "403", "asked": [1]}, "github error")

    ev = {"knowledge": {"ok": True, "memories": [], "articles": []}}
    out = render({"topic": "t", "today": "2026-10-22T00:00", "evidence": ev})
    ck(out["verdict"] == "not verified" and out["card"].startswith("WHERE WE STAND — t (as of 2026-10-22)"), "render: nothing external means not verified")
    ck([r["source"] for r in out["receipts"]] == ["knowledge", "jira", "github", "production"], "render: four receipts")

    ck(handle({"cmd": "trigger", "tool_name": "mcp__a__getJiraIssue", "tool_input": {"issueIdOrKey": "LC-1"}})["kind"] == "ticket-status", "cmd trigger")
    ck("sql" in handle({"cmd": "sql_knowledge", "terms": ["abc"], "tickets": []}), "cmd sql_knowledge")
    ck("asked" in handle({"cmd": "sql_production", "terms": ["abc"], "kind": "diagnosis"}), "cmd sql_production")
    ck("sql" in handle({"cmd": "sql_jira_fire", "tickets": ["LC-1"]}) and "sql" in handle({"cmd": "sql_jira_collect", "req_ids": [1]}), "cmd jira sql")
    ck(handle({"cmd": "parse_knowledge", "error": "x"})["evidence"]["ok"] is False, "cmd parse_knowledge")
    ck(handle({"cmd": "parse_knowledge", "rows": [{"j": {"memories": [], "articles": [{"slug": "s", "wins": [{"p": 1, "w": "a-b-c here #1234"}]}]}}]})["evidence"]["articles"][0]["ctx"] == ["a-b-c here #1234"], "cmd parse_knowledge merges the windows")
    ck(handle({"cmd": "parse_production", "error": "x"})["evidence"]["ok"] is False, "cmd parse_production")
    ck(handle({"cmd": "parse_jira", "error": "x"})["evidence"]["ok"] is False, "cmd parse_jira")
    ck(handle({"cmd": "parse_prs", "error": "x"})["evidence"]["ok"] is False, "cmd parse_prs")
    ck(handle({"cmd": "discover", "tickets": ["LC-2", "bad"], "knowledge": {}, "production": {}}) == {"tickets": ["LC-2"], "prs": []}, "cmd discover")
    ck("card" in handle({"cmd": "render", "topic": "t", "today": "d", "evidence": {}}), "cmd render")
    ck(handle({"cmd": "discover", "tickets": [], "knowledge": {}, "production": {}, "jira": {"tickets": [{"key": "LC-1", "comment": {"body": "see PR #1867"}}]}})["prs"] == [1867], "cmd discover reads PR numbers from ticket comments")
    ev2 = {"knowledge": {"ok": True, "memories": [{"id": "m1", "is_active": True, "superseded_by": None, "created": "2026-09-03", "content": "x" * 300 + " mutation-check was removed from the required list"}]}}
    ck("mutation-check was removed" in handle({"cmd": "render", "topic": "t", "today": "d", "evidence": ev2, "terms": ["mutation-check"]})["card"], "cmd render passes the topic terms to the excerpt")
    ck("mutation-check was removed" not in handle({"cmd": "render", "topic": "t", "today": "d", "evidence": ev2})["card"], "without terms the clip stays at the front")
    ck(handle({"cmd": "nope"}) == {"error": "unknown cmd 'nope'"}, "unknown cmd")
    # Surviving mutants of the first sweep, each turned into a case:
    good_row = {"j": {"articles": [{"slug": "a"}], "runs": [{"id": "r"}], "migrations": [{"version": "v"}], "crons": [], "alerts": []}}
    ck(parse_production({"error": "e", "rows": [good_row], "asked": {}})["ok"] is False and parse_knowledge({"error": "e", "rows": [{"j": {"memories": [], "articles": []}}]})["ok"] is False, "an error wins over rows: a failed read is never half-trusted")
    pp2 = parse_production({"rows": [good_row], "asked": {"slugs": ["a"]}, "terms": []})
    ck(pp2["articles"] == [{"slug": "a"}] and pp2["runs"] == [{"id": "r"}] and pp2["migrations"] == [{"version": "v"}] and pp2["asked"] == {"slugs": ["a"]}, "production rows pass through unchanged")
    odd = parse_jira({"tickets": ["LC-1"], "fired": [{"k": "LC-1", "kind": "c", "req": 1}], "collected": [{"id": 1, "status_code": 200, "j": None}]})
    ck(odd["tickets"][0]["error"] == "Jira answered 200", "jira: a 200 with no readable body is an error, not an empty ticket")
    odd2 = parse_jira({"tickets": ["LC-1"], "fired": [{"k": "LC-1", "kind": "c", "req": 1}], "collected": [{"id": 1, "status_code": 404, "error_msg": "gone", "j": {"total": 3}}]})
    ck(odd2["tickets"][0]["error"] == "Jira answered 404 gone", "jira: a 404 is an error even when a body parsed, and its message is kept")
    ck(handle({"cmd": "sql_production", "terms": ["some-slug"], "kind": "article-status"})["asked"]["slugs"] == ["some-slug"], "cmd sql_production passes the kind through")
    ck(handle({"cmd": "normalize", "tickets": ["LC-1"]})["kind"] == "ticket-status" and handle({"cmd": "branch_ticket", "branch": "lc7-x"}) == {"tickets": ["LC-7"]}, "cmd normalize and branch_ticket")
    ck(parse_prs({"asked": [1], "items": [{"number": 1, "text": json.dumps({"state": "open"})}]}) == {"ok": True, "asked": [1], "prs": [{"number": 1, "state": "open", "merged": False, "merged_at": None, "updated_at": None, "base": None, "sha": None, "head_sha": None, "title": None, "keys": []}]}, "parse_prs: the full shape of a PR record")
    me = os.path.abspath(__file__)
    import subprocess
    run1 = subprocess.run([sys.executable, "-I", me], input=json.dumps({"cmd": "branch_ticket", "branch": "lc42-x"}), capture_output=True, text=True, timeout=30)
    ck(run1.returncode == 0 and json.loads(run1.stdout) == {"tickets": ["LC-42"]}, "main: one JSON object in, one JSON object out")
    run2 = subprocess.run([sys.executable, "-I", me], input="", capture_output=True, text=True, timeout=30)
    ck(json.loads(run2.stdout) == {"error": "unknown cmd None"}, "main: empty stdin is an unknown command, not a crash")
    run3 = subprocess.run([sys.executable, "-I", me], input="{not json", capture_output=True, text=True, timeout=30)
    ck(run3.returncode == 0 and "error" in json.loads(run3.stdout), "main: garbage on stdin is reported as an error and exits 0 (a lookup never stops a session)")
    run4 = subprocess.run([sys.executable, "-I", me], input="[1,2]", capture_output=True, text=True, timeout=30)
    ck(json.loads(run4.stdout) == {"error": "unknown cmd None"}, "main: a JSON array is not a request")
    ck(normalize({"tickets": ["lc-1345", "bad key"], "terms": ["Catalog-Ingest", "x'y"]}) == {"kind": "diagnosis", "topic": "LC-1345 catalog-ingest", "tickets": ["LC-1345"], "terms": ["catalog-ingest"]}, "normalize: validated, kind defaults to diagnosis when terms are present")
    ck(normalize({"tickets": ["LC-1"]})["kind"] == "ticket-status" and normalize({"terms": ["some-slug"], "kind": "article-status"})["kind"] == "article-status", "normalize: ticket-only defaults to ticket-status; an explicit kind is kept")
    ck(normalize({"terms": ["some-slug"], "kind": "drop table"})["kind"] == "diagnosis", "normalize: an unknown kind is ignored")
    ck(branch_ticket("lc1893-where-we-stand") == {"tickets": ["LC-1893"]} and branch_ticket("claude/lch528-mods") == {"tickets": ["LCH-528"]} and branch_ticket("bbm84-x") == {"tickets": ["BBM-84"]}, "branch_ticket: the ticket a branch names")
    ck(branch_ticket("main") == {"tickets": []} and branch_ticket("feature/clean-stuff") == {"tickets": []} and branch_ticket(None) == {"tickets": []} and branch_ticket("lc-1893") == {"tickets": []}, "branch_ticket: no ticket, no card")
    gate_rows = [{"type": "user", "message": {"role": "user", "content": "q"}}, {"type": "assistant", "message": {"role": "assistant", "content": [{"type": "text", "text": "LC-9 is Done."}]}}]
    ck("LC-9" in handle({"cmd": "gate", "transcript_rows": gate_rows, "cards": []})["block"] and handle({"cmd": "gate", "transcript_rows": gate_rows, "cards": [{"tickets": ["LC-9"]}]}) == {}, "cmd gate: blocks an uncovered claim, passes a covered one")
    for x in fails:
        print("FAIL:", x)
    print(f"where-we-stand selftest: {total[0] - len(fails)}/{total[0]} checks passed")
    return 1 if fails else 0


def main() -> int:
    if "--selftest" in sys.argv:
        return _selftest()
    try:
        payload = json.loads(sys.stdin.read() or "{}")
        out = handle(payload if isinstance(payload, dict) else {})
    except Exception as exc:  # noqa: BLE001 -- a lookup failing must never stop a session
        out = {"error": f"{type(exc).__name__}"}
    print(json.dumps(out))
    return 0


if __name__ == "__main__":
    sys.exit(main())
