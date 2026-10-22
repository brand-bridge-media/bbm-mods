#!/usr/bin/env python3
"""wws_trigger — decides WHEN the where-we-stand card is worth injecting (LC-1893).

ONE JOB: given one tool call, say whether it is a "diagnosing a recurring problem" or
"about to state a ticket's / article's status" moment, and name the topic. Nothing else:
no network, no SQL run, no state. The session-level limits (once per topic, three per
session) live in register.ts, which owns the store.

Why it is narrow. A card on every tool call would be read as noise within a day and then
ignored, which is the failure CLAUDE.md section 1 already describes (knowledge existed,
nothing delivered it). So a call triggers only on a RECOGNISED shape:

  ticket-status    a Jira issue read (getJiraIssue / fetchJiraIssue) of one key -- the moment a
                   session is about to say what state a ticket is in (the LC-1345 shape).
  diagnosis        a SELECT on an alert / cron / http-response surface that names a job or error
                   class in a string literal (the catalog-ingest 546 shape). No literal, no card.
  article-status   a SELECT on refresh_runs / articles that names a slug or an 8-hex run id (the
                   most-comfortable-couches shape).

A query that reads the knowledge tables is the OPPOSITE signal: the session is already
reading prior art, so its terms are returned as `seen` and never carded.

Self-test: python3 wws_trigger.py --selftest
"""
from __future__ import annotations

import re
import sys

TICKET = re.compile(r"^[A-Z][A-Z0-9]{1,9}-\d{1,6}$")
TICKET_ANY = re.compile(r"\b[A-Z][A-Z0-9]{1,9}-\d{1,6}\b")
JIRA_READ_TOOL = re.compile(r"(?:^|__)(?:getJiraIssue|fetchJiraIssue)$")
SQL_TOOL = re.compile(r"(?:^|__)execute_sql$")

DIAGNOSIS_SURFACE = re.compile(
    r"\b(?:pipeline_health_log|cron\.job_run_details|cron\.job|net\._http_response|"
    r"check_knowledge_health|alert_state)\b", re.IGNORECASE)
STATUS_SURFACE = re.compile(r"\b(?:from|join)\s+(?:public\.)?(?:refresh_runs|articles)\b", re.IGNORECASE)
KNOWLEDGE_SURFACE = re.compile(r"\b(?:from|join)\s+(?:public\.)?knowledge_(?:memories|articles)\b", re.IGNORECASE)
WRITE_WORD = re.compile(r"\b(?:insert|update|delete|alter|drop|create|truncate|grant|revoke)\b", re.IGNORECASE)
LITERAL = re.compile(r"'([^'\\]{3,80})'")
TERM = re.compile(r"^[a-z0-9][a-z0-9_.-]{2,59}$")
RUN_ID = re.compile(r"^[0-9a-f]{8}$")
MAX_TERMS = 3


def _literals(query: str) -> list[str]:
    """String literals of the query with LIKE wildcards stripped, in order, duplicates dropped."""
    out: list[str] = []
    for raw in LITERAL.findall(query):
        s = raw.strip("%").strip().lower()
        if s and s not in out:
            out.append(s)
    return out


def _terms(query: str, want_run_ids: bool) -> list[str]:
    """Names worth looking up: slug-shaped literals with a `-`, `_` or `.` (a job, a class,
    a slug), or an 8-hex run id when asked. Plain filter words (`critical`, `done`) have none of
    those and never qualify."""
    found: list[str] = []
    for s in _literals(query):
        if not TERM.match(s):
            continue
        named = any(c in s for c in "-_.")
        if (named and not re.match(r"^\d", s)) or (want_run_ids and RUN_ID.match(s)):
            found.append(s)
    return found[:MAX_TERMS]


def classify(tool_name: str, tool_input: dict) -> dict:
    """{} when this call is not a trigger, else {kind, topic, tickets, terms} (+ `seen` for a
    knowledge read, which is never a trigger)."""
    tool_name = str(tool_name or "")
    tool_input = tool_input if isinstance(tool_input, dict) else {}
    if JIRA_READ_TOOL.search(tool_name):
        key = str(tool_input.get("issueIdOrKey") or tool_input.get("issueKey") or "").strip().upper()
        if TICKET.match(key):
            return {"kind": "ticket-status", "topic": key, "tickets": [key], "terms": []}
        return {}
    if not SQL_TOOL.search(tool_name):
        return {}
    query = str(tool_input.get("query") or "")
    if KNOWLEDGE_SURFACE.search(query):
        return {"seen": _terms(query, False) + sorted(set(TICKET_ANY.findall(query)))}
    if WRITE_WORD.search(query):
        return {}
    if DIAGNOSIS_SURFACE.search(query):
        terms = _terms(query, False)
        if terms:
            return {"kind": "diagnosis", "topic": " ".join(terms), "tickets": [], "terms": terms}
        return {}
    if STATUS_SURFACE.search(query):
        terms = _terms(query, True)
        if terms:
            return {"kind": "article-status", "topic": " ".join(terms), "tickets": [], "terms": terms}
    return {}


def _selftest() -> int:
    fails: list[str] = []
    total = [0]

    def ck(cond: bool, msg: str) -> None:
        total[0] += 1
        if not cond:
            fails.append(msg)

    t = classify("mcp__Atlassian__getJiraIssue", {"issueIdOrKey": "lc-1345"})
    ck(t.get("kind") == "ticket-status" and t["tickets"] == ["LC-1345"] and t["topic"] == "LC-1345",
       "a Jira issue read triggers ticket-status with the upper-cased key")
    ck(classify("mcp__x__fetchJiraIssue", {"issueKey": "LCH-9"}).get("tickets") == ["LCH-9"], "issueKey spelling")
    ck(classify("mcp__x__getJiraIssue", {"issueIdOrKey": "1234"}) == {}, "a numeric id is not a key: no trigger")
    ck(classify("mcp__x__getJiraIssue", {"issueIdOrKey": "LC-1; drop"}) == {}, "a key with trailing junk never triggers")
    ck(classify("mcp__x__searchJiraIssuesUsingJql", {"jql": "project = LC"}) == {}, "a JQL census is not a status read")
    ck(classify("Bash", {"command": "ls"}) == {}, "a non-SQL, non-Jira tool never triggers")

    q = "select * from pipeline_health_log where alert_type = 'cron_http_failure' and details ilike '%catalog-ingest%'"
    d = classify("mcp__Supabase__execute_sql", {"query": q})
    ck(d.get("kind") == "diagnosis" and d["terms"] == ["cron_http_failure", "catalog-ingest"], "diagnosis names the job and the class")
    ck(d.get("topic") == "cron_http_failure catalog-ingest", "topic joins the terms")
    ck(classify("mcp__Supabase__execute_sql", {"query": "select * from pipeline_health_log where severity = 'critical'"}) == {},
       "a filter word alone is noise: no card")
    ck(classify("mcp__Supabase__execute_sql", {"query": "select count(*) from cron.job"}) == {}, "no literal, no card")
    ck(classify("mcp__Supabase__execute_sql", {"query": "update pipeline_health_log set x = 'a-b-c'"}) == {},
       "a write never triggers")
    ck(classify("mcp__Supabase__execute_sql", {"query": "select 'a-b-c' as x"}) == {}, "a surface is required")
    ck(classify("mcp__Supabase__execute_sql", {"query": "select * from cron.job_run_details where start_time > '2026-10-01'"}) == {},
       "a date literal is not a term")

    a = classify("mcp__Supabase__execute_sql", {"query": "select status from refresh_runs where article_slug = 'most-comfortable-couches'"})
    ck(a.get("kind") == "article-status" and a["terms"] == ["most-comfortable-couches"], "article-status names the slug")
    r = classify("mcp__Supabase__execute_sql", {"query": "select * from refresh_runs where id::text like '896655cd%'"})
    ck(r.get("terms") == ["896655cd"], "an 8-hex run id counts on a status surface")
    ck(classify("mcp__Supabase__execute_sql", {"query": "select * from pipeline_health_log where x = '896655cd'"}) == {},
       "a run id on a diagnosis surface is not a term")
    ck(classify("mcp__Supabase__execute_sql", {"query": "select * from refresh_runs where status = 'done'"}) == {},
       "status words are noise")

    k = classify("mcp__Supabase__execute_sql", {"query": "select * from knowledge_memories where 'catalog-ingest' = any(topics) -- LC-1345"})
    ck(k == {"seen": ["catalog-ingest", "LC-1345"]}, "a knowledge read is `seen`, never a trigger")
    ck("kind" not in k, "seen carries no kind")
    ck(len(classify("mcp__Supabase__execute_sql", {"query": "select 1 from pipeline_health_log where a='aa-1' or b='bb-2' or c='cc-3' or d='dd-4'"})["terms"]) == MAX_TERMS,
       "terms are capped")
    ck(classify("mcp__Supabase__execute_sql", {"query": ""}) == {}, "empty query")
    ck(classify("mcp__Supabase__execute_sql", {}) == {}, "no input")
    ck(classify("mcp__Supabase__execute_sql", "x") == {}, "non-dict input")
    ck(classify("", {}) == {}, "empty tool name")
    ck(classify("Bash", {"query": "select * from pipeline_health_log where a = 'aa-1'"}) == {}, "only an execute_sql tool is read as SQL")
    ck(_literals("x '%%%' y 'abc' z 'abc' w '%abc%'") == ["abc"], "literals: wildcards-only and duplicate literals are dropped")
    ck(classify("mcp__x__execute_sql", {"query": "select * from pipeline_health_log where a = 'two words-here'"}) == {}, "a literal that is not slug-shaped is not a term")
    ck(classify("mcp__x__execute_sql", {"query": "select * from knowledge_memories where x = '896655cd' and y = 'job-name'"}) == {"seen": ["job-name"]}, "seen never takes a bare run id")
    ck(_terms("a 'job-1' b '1234-5678'", False) == ["job-1"], "a literal starting with a digit is not a named term")
    ck(_terms("a '896655cd'", True) == ["896655cd"] and _terms("a '896655cd'", False) == [], "run ids only when asked")
    for f in fails:
        print("FAIL:", f)
    print(f"wws_trigger selftest: {total[0] - len(fails)}/{total[0]} checks passed")
    return 1 if fails else 0


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        sys.exit(_selftest())
    print(__doc__)
