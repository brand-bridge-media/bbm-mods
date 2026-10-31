#!/usr/bin/env python3
"""Stop hook: a session that analysed page performance must log the investigation (LC-1962).

WHAT IT DOES. At the end of a turn it counts the page-level analytics reads in the
session's main-thread tool calls. When there are 3 or more and no
`log_page_investigation` / `update_page_investigation` call happened, it blocks the
reply ONCE with a message asking for the log (or one line saying why it was not an
investigation), then never fires again in that session.

WHY. A page question ("why did X drop?") gets answered in chat and the evidence, the
ruled-out hypotheses included, is gone by the time someone asks again months later
(the 2026-10-26..31 dip lived only in chat and memory 316e1481). The skill
`analytics-reporting` (Page performance investigation protocol) is the guidance; this
mod is the enforcement, so the work is recorded without anyone remembering to ask.

COUNTED as a page-level read (one count per call):
  * execute_sql SELECT/WITH touching gsc_page_daily, gsc_page_query_daily,
    gsc_page_performance, cloudflare_web_vitals_daily (with a page filter),
    rank_watch_results, link_clicks (grouped/filtered by source_page), the
    ga4-traffic-sources events mode, or net.http_get to livingcozy.com
  * DataForSEO serp_* and keyword tools
  * Ahrefs gsc-* and rank-tracker-* tools
NOT counted: reads of the investigation-log tables/view themselves, and writes
(INSERT/UPDATE/DELETE...), so a data-only session never fires it.

WHY IT CANNOT TRAP A SESSION. (1) The mod's own per-session marker file (plus the MARK
callout in the transcript when the marker cannot be written) means it blocks at most once
per session. (2) It fails open on any error.

`stop_hook_active` is NOT trusted as "I already fired" (LC-1962 follow-up): Claude Code
sets it after a block from ANY Stop hook, so another mod's block made this one pass
without ever firing. It is only recorded in the receipt. Worst case accepted: two
different block messages in a row in one session, never two from this mod.

RECEIPT. Every invocation appends one line to ~/.investigation-log-runs.log (override:
INVESTIGATION_LOG_RECEIPT), skips and errors included, so "did it run?" is answerable:
  <UTC ISO time> session=<id> active=<stop_hook_active> reads=<n> kinds=<k:n,...>
  log_call=<true|false> marker=<true|false> decision=<block|allow|skip:<why>|error:<msg>>
A receipt-write failure is swallowed; the file is trimmed to its last 2000 lines past 5000.

Self-test: python3 investigation-log.py --selftest
"""
from __future__ import annotations

import collections
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import transcript_reader as tr  # noqa: E402

THRESHOLD = 3
MAX_SCAN = 20000  # chars of a query that are read; page-level reads are short, and this bounds regex work
OWNER_SKILL = "analytics-reporting"
MARK = "[mod:investigation-log]"

# Optional closing double quote: `public."log_page_investigation"(` is a real call too.
_LOG_CALL = re.compile(r"\b(?:log|update)_page_investigation\"?\s*\(", re.I)
_OWN_TABLES = re.compile(r"\b(?:page_investigations|page_investigation_hypotheses|v_page_timeline)\b", re.I)
_WRITE = re.compile(r"^\s*(?:insert|update|delete|merge|truncate|create|alter|drop|grant|revoke|copy|call|do)\b", re.I)
_DML = re.compile(r"\b(?:insert\s+into|delete\s+from|merge\s+into|update\s+[\w.\"]+\s+set|truncate\s+table)\b", re.I)
_PAGE_FILTER = re.compile(r"\b(?:where|group\s+by|and)\b[\s\S]{0,1500}?\b(?:page_path|page_url|page|url)\b", re.I)  # a predicate or grouping, not a selected column
# (label, pattern) in the order they are tried; the first match names the read.
_SQL_TABLE_READS = (  # judged with string literals removed: a name in a literal is not a read
    ("gsc_page_query_daily", re.compile(r"\bgsc_page_query_daily\b", re.I)),
    ("gsc_page_daily", re.compile(r"\bgsc_page_daily\b", re.I)),
    ("gsc_page_performance", re.compile(r"\bgsc_page_performance\b", re.I)),
    ("rank_watch_results", re.compile(r"\brank_watch_results\b", re.I)),
    ("link_clicks", re.compile(r"\blink_clicks\b[\s\S]{0,3000}\bsource_page\b|\bsource_page\b[\s\S]{0,3000}\blink_clicks\b", re.I)),
)
_SQL_LITERAL_READS = (  # the URL / function name is itself a string literal, so comments only are removed
    ("ga4-traffic-sources", re.compile(r"ga4-traffic-sources[\s\S]{0,3000}\bevents\b|\bevents\b[\s\S]{0,3000}ga4-traffic-sources", re.I)),
    ("live page fetch", re.compile(r"\bnet\.http_get\b[\s\S]{0,500}?livingcozy\.com", re.I)),
)
_CWV = re.compile(r"\bcloudflare_web_vitals_daily\b", re.I)
_SEO_TOOLS = {"serp_organic", "serp_ai_summary", "keyword_ideas", "keyword_overview", "related_keywords",
              "bulk_keyword_difficulty", "ranked_keywords"}


def _base(name: str) -> str:
    return name.rsplit("__", 1)[-1]


_COMMENT = re.compile(r"--[^\n]*|/\*[\s\S]*?\*/|/\*[\s\S]*$")
_LITERAL = re.compile(r"'(?:[^']|'')*'|'[\s\S]*$|\$(\w*)\$[\s\S]*?\$\1\$|\$\w*\$[\s\S]*$|--[^\n]*|/\*[\s\S]*?\*/|/\*[\s\S]*$")


def is_log_call(q: str) -> bool:
    """A real call: the function name outside string literals and comments."""
    return bool(_LOG_CALL.search(_LITERAL.sub(" ", q)))


def sql_text(inp: dict) -> str:
    q = inp.get("query") if isinstance(inp, dict) else None
    return q if isinstance(q, str) else ""


def read_label(name: str, inp: dict) -> str | None:
    """Short label if this tool call is a page-level analytics read, else None."""
    base = _base(name or "")
    if base == "execute_sql":
        q = _COMMENT.sub(" ", sql_text(inp)[:MAX_SCAN])  # a name in a comment is not a read
        bare = _LITERAL.sub(" ", q)  # ...and neither is one inside a string literal
        if not q or _OWN_TABLES.search(bare) or is_log_call(q) or _WRITE.match(q) or _DML.search(bare):
            return None
        for label, pat in _SQL_TABLE_READS:
            if pat.search(bare):
                return label
        for label, pat in _SQL_LITERAL_READS:
            if pat.search(q):
                return label
        if _CWV.search(bare) and _PAGE_FILTER.search(bare):
            return "cloudflare_web_vitals_daily"
        return None
    low = base.lower()
    if low.startswith("serp_") or low in _SEO_TOOLS:
        return base
    if low.startswith("gsc-") or low.startswith("rank-tracker-"):
        return base
    return None


def logged(rows: list[dict]) -> bool:
    return any(_base(n) == "execute_sql" and is_log_call(sql_text(i)) for n, i, _ in tr.tool_uses(rows))


def reads(rows: list[dict]) -> list[str]:
    out = []
    for name, inp, _ in tr.tool_uses(rows):
        label = read_label(name, inp)
        if label:
            out.append(label)
    return out


def _state_dir() -> str:
    return os.environ.get("INVESTIGATION_LOG_STATE_DIR") or os.path.join(os.path.expanduser("~"), ".cache", "investigation-log")


def _marker(sid: str) -> str:
    return os.path.join(_state_dir(), re.sub(r"[^A-Za-z0-9_.-]", "_", sid)[:120])


def marker_present(payload: dict) -> bool:
    sid = payload.get("session_id")
    return isinstance(sid, str) and bool(sid) and os.path.exists(_marker(sid))


def already_fired(payload: dict, rows: list[dict]) -> bool:
    if marker_present(payload):
        return True
    # Backup when the marker cannot be written: the block's feedback shows up as a
    # prompt-type row (never a tool result) carrying our callout.
    for r in rows:
        if tr._is_prompt(r) and any(MARK in (b.get("text") or "") for b in tr._blocks(r) if b.get("type") == "text"):
            return True
    return False


def remember(payload: dict) -> None:
    sid = payload.get("session_id")
    if not (isinstance(sid, str) and sid):
        return
    try:
        os.makedirs(_state_dir(), exist_ok=True)
        open(_marker(sid), "w").close()
    except OSError:
        pass  # the transcript check still bounds it


RECEIPT_TRIM_AT = 5000
RECEIPT_KEEP = 2000


def _receipt_path() -> str:
    return os.environ.get("INVESTIGATION_LOG_RECEIPT") or os.path.join(os.path.expanduser("~"), ".investigation-log-runs.log")


def write_receipt(info: dict) -> None:
    """Append one line per run. Never raises: a receipt must not change a verdict."""
    try:
        import datetime
        kinds = ",".join(f"{k}:{v}" for k, v in info.get("kinds", {}).items()) or "-"
        line = " ".join([
            datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            f"session={info.get('session') or '-'}",
            f"active={info.get('active')}",
            f"reads={info.get('reads', 0)}",
            f"kinds={kinds}",
            f"log_call={str(bool(info.get('log_call'))).lower()}",
            f"marker={str(bool(info.get('marker'))).lower()}",
            f"decision={' '.join(str(info.get('decision', 'error:unknown')).split())[:200]}",
        ])
        path = _receipt_path()
        with open(path, "a", encoding="utf-8") as fh:
            fh.write(line + "\n")
        with open(path, encoding="utf-8") as fh:
            lines = fh.readlines()
        if len(lines) > RECEIPT_TRIM_AT:
            with open(path, "w", encoding="utf-8") as fh:
                fh.writelines(lines[-RECEIPT_KEEP:])
    except Exception:  # noqa: BLE001
        pass


def decide(payload: dict) -> tuple[str | None, dict]:
    """(block reason or None, receipt info). stop_hook_active is recorded, never trusted."""
    info: dict = {"session": payload.get("session_id") if isinstance(payload.get("session_id"), str) else None,
                  "active": payload.get("stop_hook_active"), "marker": marker_present(payload), "decision": "skip:no-transcript"}
    rows = tr.rows_for(payload)
    found = reads(rows)
    info["reads"] = len(found)
    info["kinds"] = dict(collections.Counter(found))
    info["log_call"] = logged(rows)
    if len(found) < THRESHOLD:
        info["decision"] = "skip:below-threshold" if rows else "skip:no-transcript"
        return None, info
    if info["log_call"]:
        info["decision"] = "allow"
        return None, info
    if already_fired(payload, rows):
        info["decision"] = "allow"
        return None, info
    counts = collections.Counter(found)
    short = ", ".join(f"{k} x{v}" if v > 1 else k for k, v in counts.most_common(4))
    remember(payload)
    info["decision"] = "block"
    return (f"{MARK} This session analysed page performance ({len(found)} reads: {short}) but logged no "
            f"investigation. Log it with log_page_investigation (owner skill: {OWNER_SKILL}), add to an open "
            "one with update_page_investigation, or say in one line why this was not an investigation "
            "(e.g. a one-off number lookup)."), info


def evaluate(payload: dict) -> str | None:
    """Block reason, or None to let the turn end."""
    return decide(payload)[0]


def _selftest() -> int:
    import shutil
    import subprocess
    import tempfile
    checks = fails = 0

    def ck(cond: bool, label: str) -> None:
        nonlocal checks, fails
        checks += 1
        if not cond:
            fails += 1
            sys.stderr.write(f"  FAIL: {label}\n")

    state = tempfile.mkdtemp()
    os.environ["INVESTIGATION_LOG_STATE_DIR"] = state
    receipt = os.path.join(state, "runs.log")
    os.environ["INVESTIGATION_LOG_RECEIPT"] = receipt
    SQL = "mcp__Supabase__execute_sql"

    def call(name: str, **inp) -> tuple[str, dict]:
        return name, inp

    R1 = call(SQL, query="select page, sum(clicks) from gsc_page_daily where page = '/x' group by 1")
    R2 = call(SQL, query="select * from public.rank_watch_results order by captured_on")
    R3 = call("mcp__dfs__serp_organic", keyword="best couches")
    R4 = call("mcp__ahrefs__gsc-page-history", page="/x")
    R5 = call(SQL, query="select net.http_get(url := 'https://www.livingcozy.com/blog/x')")
    LOG = call(SQL, query="select public.log_page_investigation('{\"trigger\":\"t\"}'::jsonb)")
    UPD = call(SQL, query="select public.update_page_investigation('00000000-0000-0000-0000-000000000000', '{}'::jsonb)")

    def transcript(calls, extra=()) -> str:
        rows = [{"type": "user", "message": {"content": "why did the couch page drop?"}}]
        for i, (n, inp) in enumerate(calls):
            rows.append({"type": "assistant", "message": {"content": [{"type": "tool_use", "id": f"t{i}", "name": n, "input": inp}]}})
            rows.append({"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": f"t{i}", "content": "ok"}]}})
        rows += list(extra)
        rows.append({"type": "assistant", "message": {"content": [{"type": "text", "text": "answer"}]}})
        fh = tempfile.NamedTemporaryFile("w", suffix=".jsonl", delete=False)
        fh.write("\n".join(json.dumps(r) for r in rows))
        fh.close()
        return fh.name

    def run(calls, sid, extra=(), **more):
        p = transcript(calls, extra)
        try:
            return evaluate({"transcript_path": p, "session_id": sid, **more})
        finally:
            os.unlink(p)

    # 1. fires at the threshold, names the count, list, owner skill and the escape hatch
    r = run([R1, R2, R3], "fires")
    ck(r is not None and r.startswith(MARK) and "3 reads" in r and "gsc_page_daily" in r and "rank_watch_results" in r
       and "serp_organic" in r and OWNER_SKILL in r and "one-off number lookup" in r, "fires with 3 page reads")
    # 2. does not fire below the threshold
    ck(run([R1, R2], "below") is None, "2 reads do not fire")
    ck(run([], "none") is None, "no reads do not fire")
    # 3. does not fire after a log / update call (either order)
    ck(run([R1, R2, R3, LOG], "logged") is None, "log_page_investigation call suppresses")
    ck(run([UPD, R1, R2, R3], "updated") is None, "update_page_investigation call suppresses")
    FAKE = call(SQL, query="select 'log_page_investigation(' as note -- update_page_investigation(")
    ck(run([R1, R2, R3, FAKE], "fake") is not None, "a quoted/commented name is not a log call")
    # 4. fires only once: same session again, with and without the marker file
    ck(run([R1, R2, R3, R4], "once") is not None, "first stop of a session fires")
    ck(run([R1, R2, R3, R4], "once") is None, "second stop of the same session passes (marker)")
    ck(run([R1, R2, R3], "other-session") is not None, "a different session still fires")
    ck(run([R1, R2, R3], "x", stop_hook_active=True) is not None, "stop_hook_active=true with no marker and 3 reads still blocks")
    ck(run([R1, R2, R3], "x", stop_hook_active=True) is None, "stop_hook_active=true with the marker present allows")
    fb = {"type": "user", "message": {"content": MARK + " earlier block feedback"}}
    ck(run([R1, R2, R3], "no-marker", extra=[fb]) is None, "feedback row in transcript also means already fired")
    quoted = {"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": "t0", "content": MARK}]}}
    ck(run([R1, R2, R3], "quoted", extra=[quoted]) is not None, "a tool result quoting the callout is not feedback")
    # must-not-count cases
    OWN = call(SQL, query="select * from v_page_timeline where page_path='/x'")
    OWN2 = call(SQL, query="select * from page_investigations p join gsc_page_daily g on true")
    WR = call(SQL, query="insert into gsc_page_daily select * from staging_gsc_page_daily")
    ck(run([OWN, OWN2, OWN2, OWN2], "own") is None, "investigation tables/view reads are not counted")
    ck(run([WR, WR, WR], "writes") is None, "data-only writes are not counted")
    CWV_NO = call(SQL, query="select sum(loads) from cloudflare_web_vitals_daily")
    CWV_OK = call(SQL, query="select page_path, loads from cloudflare_web_vitals_daily where page_path='/x'")
    ck(run([CWV_NO, CWV_NO, CWV_NO], "cwv-no") is None, "web vitals without a page filter not counted")
    ck(run([CWV_OK, CWV_OK, CWV_OK], "cwv-ok") is not None, "web vitals with a page filter counted")
    LC = call(SQL, query="select source_page, count(*) from link_clicks group by 1")
    LCNO = call(SQL, query="select count(*) from link_clicks")
    ck(run([LC, LC, LC], "lc") is not None and run([LCNO, LCNO, LCNO], "lcno") is None, "link_clicks counted only with source_page")
    ck(run([R5, R5, R5], "live") is not None, "live-page fetch to livingcozy.com counted")
    CMT = call(SQL, query="select net.http_get(url := 'https://example.com/') -- livingcozy.com")
    ck(run([CMT, CMT, CMT], "cmt") is None, "a host named only in a comment is not a live fetch")
    OPENC = call(SQL, query="select /* log_page_investigation(")
    ck(run([R1, R2, R3, OPENC], "open-comment") is not None, "an unterminated block comment is not a log call")
    ck(run([R1, R2, R3], "str-false", stop_hook_active="false") is not None, 'stop_hook_active "false" (string) is not active')
    ck(run([R1, R2, R3], "str-true", stop_hook_active="true") is not None, 'stop_hook_active "true" (string) does not suppress')
    OWNLIT = call(SQL, query="select page, clicks from gsc_page_daily where note = 'page_investigations'")
    ck(run([OWNLIT, OWNLIT, OWNLIT], "ownlit") is not None, "a log-table name only inside a literal does not hide a real read")
    OWNREAL = call(SQL, query="select * from gsc_page_daily g join page_investigations p on true")
    ck(run([OWNREAL] * 3, "ownreal") is None, "a log table actually read still suppresses")
    CWVSEL = call(SQL, query="select page_path, loads from cloudflare_web_vitals_daily")
    ck(run([CWVSEL] * 3, "cwvsel") is None, "a page column that is only selected is not a page filter")
    CWVGRP = call(SQL, query="select page_path, sum(loads) from cloudflare_web_vitals_daily group by page_path")
    ck(run([CWVGRP] * 3, "cwvgrp") is not None, "grouping by page counts as a page-level read")
    LIT = call(SQL, query="select 'gsc_page_daily' as note")
    ck(run([LIT, LIT, LIT], "lit") is None, "a table named only inside a string literal is not a read")
    DOLLAR = call(SQL, query="select $$ gsc_page_daily $$ as note")
    TAGGED = call(SQL, query="select $q$ rank_watch_results $q$ as note")
    ck(run([DOLLAR, DOLLAR, TAGGED], "dollar") is None, "a table named only inside a dollar-quoted string is not a read")
    ck(run([call(SQL, query="select page from gsc_page_daily where page = 'x'")] * 3, "litok") is not None,
       "a real table read with a literal elsewhere is still counted")
    NEST = call(SQL, query="select net.http_get(headers := jsonb_build_object('User-Agent','x'), url := 'https://www.livingcozy.com/x')")
    ck(run([NEST, NEST, NEST], "nest") is not None, "a live fetch with a nested call before the URL is counted")
    GA4 = call(SQL, query="select net.http_post(url := 'https://x/functions/v1/ga4-traffic-sources', body := '{\"mode\":\"events\"}'::jsonb)")
    ck(run([GA4, GA4, GA4], "ga4") is not None, "the ga4-traffic-sources events mode is still counted")
    UNC = call(SQL, query="select 1 /* from gsc_page_daily")
    ck(run([UNC, UNC, UNC], "unc") is None, "a table named only inside an unterminated comment is not a read")
    OPEN = call(SQL, query="select 'log_page_investigation(")
    ck(run([R1, R2, R3, OPEN], "open-quote") is not None, "an unclosed quote is not a log call")
    CTE = call(SQL, query="with s as (select 1) insert into gsc_page_daily select * from staging_gsc_page_daily")
    ck(run([CTE, CTE, CTE], "cte-write") is None, "a write behind a WITH clause is not a read")
    CTEU = call(SQL, query="with s as (select 1) update rank_watch_results set status='x'")
    ck(run([CTEU, CTEU, CTEU], "cte-upd") is None, "a CTE update is not a read")
    CTER = call(SQL, query="with s as (select page from gsc_page_daily) select * from s")
    ck(run([CTER, CTER, CTER], "cte-read") is not None, "a CTE read is still counted")
    # The scan is capped, so work is bounded by construction (no wall-clock assertion: CI runners vary).
    BIG = call(SQL, query="select " + "link_clicks, " * 20000)
    ck(run([BIG, BIG, BIG], "big") is None, "a huge query without source_page is not counted")
    FAR = call(SQL, query="select 1 " + " " * MAX_SCAN + " from rank_watch_results")
    NEAR = call(SQL, query="select 1 " + " " * 100 + " from rank_watch_results")
    ck(run([FAR, FAR, FAR], "far") is None and run([NEAR, NEAR, NEAR], "near") is not None,
       "text beyond MAX_SCAN is not read; the same query within it is counted")
    OTHER = call(SQL, query="select net.http_get(url := 'https://example.com/')")
    ck(run([OTHER, OTHER, OTHER], "other") is None, "fetch to another host not counted")
    ck(run([call("mcp__ahrefs__rank-tracker-overview"), call("mcp__ahrefs__gsc-keywords"), call("mcp__dfs__keyword_ideas")], "tools") is not None,
       "ahrefs gsc-*/rank-tracker-* and dataforseo keyword tools counted")
    ck(run([call("mcp__x__site-explorer-metrics")] * 4, "ahr-other") is None, "other ahrefs tools not counted")
    ck(run([R1, R2, R3], "side", extra=[]) is not None, "baseline for sidechain case")
    side = [{"type": "user", "message": {"content": "go"}}] + [
        {"type": "assistant", "isSidechain": True, "message": {"content": [{"type": "tool_use", "id": f"s{i}", "name": SQL, "input": R1[1]}]}} for i in range(4)]
    ck(evaluate({"transcript_rows": side, "session_id": "side2"}) is None, "subagent (sidechain) reads are not counted")
    ck(evaluate({}) is None, "no transcript -> pass")

    # quoted function names are real log calls; a quoted name inside a literal is not
    QL = call(SQL, query='select public."log_page_investigation"(\'{}\'::jsonb)')
    QU = call(SQL, query='select "update_page_investigation"(\'00000000-0000-0000-0000-000000000000\', \'{}\'::jsonb)')
    ck(run([R1, R2, R3, QL], "q-log") is None, 'public."log_page_investigation"( counts as a log call')
    ck(run([R1, R2, R3, QU], "q-upd") is None, '"update_page_investigation"( counts as a log call')
    QLIT = call(SQL, query="select '\"log_page_investigation\"(' as note")
    ck(run([R1, R2, R3, QLIT], "q-lit") is not None, "a quoted name inside a string literal is not a log call")

    # receipts: one line per invocation, whatever the decision; failures swallowed
    def lines() -> list[str]:
        return open(receipt).read().splitlines() if os.path.exists(receipt) else []

    def proc(stdin: str, env_extra=None):
        return subprocess.run([sys.executable, os.path.abspath(__file__)], input=stdin, capture_output=True, text=True,
                              env={**os.environ, **(env_extra or {})})

    def sub(calls, sid, **more):
        p = transcript(calls)
        try:
            return proc(json.dumps({"transcript_path": p, "session_id": sid, **more}))
        finally:
            os.unlink(p)

    if os.path.exists(receipt):
        os.unlink(receipt)
    sub([R1, R2, R3], "rc-block", stop_hook_active=True)
    sub([R1, R2, R3], "rc-block")            # marker now present -> allow
    sub([R1], "rc-skip")
    proc("{bad")
    L = lines()
    ck(len(L) == 4, f"one receipt line per invocation (got {len(L)})")
    ck(len(L) == 4 and "session=rc-block" in L[0] and "active=True" in L[0] and "reads=3" in L[0] and "gsc_page_daily:1" in L[0]
       and "log_call=false" in L[0] and "marker=false" in L[0] and L[0].endswith("decision=block"), "block receipt line")
    ck(len(L) == 4 and "marker=true" in L[1] and L[1].endswith("decision=allow"), "allow receipt line")
    ck(len(L) == 4 and "reads=1" in L[2] and L[2].endswith("decision=skip:below-threshold"), "skip receipt line")
    ck(len(L) == 4 and "decision=error:" in L[3], "error receipt line")
    # a receipt-write failure never blocks, crashes or changes the verdict
    bad = proc(json.dumps({"session_id": "x"}), {"INVESTIGATION_LOG_RECEIPT": os.path.join(state, "no", "such", "dir", "r.log")})
    ck(bad.returncode == 0 and bad.stdout == "", "receipt-write failure is swallowed (allow path)")
    p = transcript([R1, R2, R3])
    try:
        bad = proc(json.dumps({"transcript_path": p, "session_id": "rc-fail"}), {"INVESTIGATION_LOG_RECEIPT": os.path.join(state, "no", "dir", "r.log")})
    finally:
        os.unlink(p)
    ck(bad.returncode == 0 and json.loads(bad.stdout)["decision"] == "block", "receipt-write failure is swallowed (block still emitted)")
    # trimming: over 5000 lines -> last 2000
    with open(receipt, "w") as fh:
        fh.write("old\n" * (RECEIPT_TRIM_AT + 1))
    write_receipt({"decision": "allow", "session": "trim"})
    L = lines()
    ck(len(L) == RECEIPT_KEEP and "session=trim" in L[-1], "receipt file is trimmed to the last 2000 lines")

    # process level: block JSON on stdout, junk fails open and visible
    p = transcript([R1, R2, R3])
    try:
        out = subprocess.run([sys.executable, os.path.abspath(__file__)], input=json.dumps({"transcript_path": p, "session_id": "proc"}),
                             capture_output=True, text=True, env=dict(os.environ))
        ck(out.returncode == 0 and json.loads(out.stdout)["decision"] == "block", "main(): emits decision=block")
    finally:
        os.unlink(p)
    out = subprocess.run([sys.executable, os.path.abspath(__file__)], input="{bad", capture_output=True, text=True)
    ck(out.returncode == 1 and out.stdout == "", "main(): junk input fails open and visible")

    shutil.rmtree(state, ignore_errors=True)
    print(f"investigation-log selftest: {checks - fails}/{checks} checks passed")
    return 1 if fails else 0


def main() -> int:
    if "--selftest" in sys.argv:
        return _selftest()
    info: dict = {"decision": "error:unknown"}
    try:
        raw = sys.stdin.read()
        payload = json.loads(raw) if raw.strip() else {}
        reason, info = decide(payload if isinstance(payload, dict) else {})
    except Exception as e:  # noqa: BLE001
        info["decision"] = f"error:{type(e).__name__}: {e}"
        write_receipt(info)
        sys.stderr.write(f"investigation-log: could not evaluate ({e}); letting the turn end.\n")
        return 1
    write_receipt(info)
    if reason:
        json.dump({"decision": "block", "reason": reason}, sys.stdout)
        sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
