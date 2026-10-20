#!/usr/bin/env python3
"""Supabase exposure rules for SQL a session runs or a migration ships (LCH-531).

WHY THIS EXISTS. Every rule here was a sentence in supabase-architecture that recurred
anyway, and each has a real migration that broke it (the replay fixtures below):

  R1 table without RLS      LC-1550 20260920175316: public.price_write_policy had no
                            RLS, so anon could flip the price guard switch (LCH-530).
  R2 view without           LC-1611 20260924005656: v_product_tags_evidence, and LC-1099
     security_invoker       page_keyword_diffs, ran as their owner, so anon read rows
                            RLS hides (advisor ERROR security_definer_view; LCH-530 #1925).
                            MEASURED on PG16 2026-10-20: CREATE OR REPLACE VIEW without the
                            option RESETS security_invoker, so a later migration silently
                            undoes the fix. Every create-or-replace must carry it.
  R3 SECURITY DEFINER       LC-1099 20260820221740: get_article_keyword_summary et al.
     unrevoked / no         revoked from anon only and set no search_path. Supabase's
     search_path            default privileges grant EXECUTE to anon AND authenticated
                            directly (measured in pg_default_acl), so the revoke must name
                            public, anon and authenticated (advisor 0028/0029/0011).
  R4 GRANT to anon /        LC-1099 20260820221740: GRANT SELECT ON page_keyword_diffs
     authenticated          TO authenticated. Allowed only with an inline marker that
                            names the object and gives a reason:
                              -- supabase-guard: allow-grant public.x -- portal reads it
  R5 function without       96 existing (advisor WARN, reported debt); a new one warns.
     search_path

ONE JOB PER RULE (CLAUDE.md section 3). Each check answers one question and returns
PASS / BLOCK / WARN / NOT CHECKED with a reason. RULES is the list the engine reads as
data; adding a rule is a row and a function, never a change to the engine. A batch with a
DO block reports NOT CHECKED for what dynamic SQL could hide (it is never a PASS).

THE SAME MODULE runs as the PR gate (lint-supabase-rules.yml, preflight) and inside the
session mod supabase-guard (byte-identical copy, claude-mods.yml parity), so a PR and a
session are judged identically. Stdlib only.

Usage:
  supabase_rules.py --selftest
  supabase_rules.py --files a.sql b.sql
  supabase_rules.py --base origin/main      (migrations added or changed since base)
"""
from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys
from dataclasses import dataclass, field

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import sql_lexer  # noqa: E402

EXPOSED_SCHEMAS = {"public", "graphql_public"}
API_ROLES = {"anon", "authenticated"}
MIG_DIR = "supabase/migrations"

PASS, BLOCK, WARN, NOT_CHECKED = "PASS", "BLOCK", "WARN", "NOT CHECKED"

_NAME = r"((?:[\w$]+\.)?[\w$]+)"


@dataclass
class Batch:
    """One file or one SQL call, read once and shared by every rule."""
    raw: str
    statements: list[str] = field(default_factory=list)
    has_dynamic: bool = False  # always set by of(); the default is never read (equivalent mutant)

    @classmethod
    def of(cls, sql: str) -> "Batch":
        sts = []
        for st in sql_lexer.statements(sql or ""):
            st = re.sub(r"^(?:\(\s*)+", "", st)
            st = re.sub(r"^explain\s+(?:\([^)]*\)\s*|(?:analyze|verbose)\s+)*", "", st)
            sts.append(st)
        return cls(raw=sql or "", statements=sts, has_dynamic=any(re.match(r"^do\b", s) for s in sts))


@dataclass
class Result:
    rule: str
    verdict: str
    reason: str


def qualified(name: str) -> tuple[str, str]:
    """(schema, object); an unqualified name lands in public (the default search_path)."""
    parts = name.split(".")
    return (parts[0], parts[1]) if len(parts) == 2 else ("public", parts[0])


def q(name: str) -> str:
    return "%s.%s" % qualified(name)


def exposed(name: str) -> bool:
    return qualified(name)[0] in EXPOSED_SCHEMAS


# ---------------------------------------------------------------- R1 table RLS
CREATE_TABLE = re.compile(
    r"^create\s+(?:(?:global|local)\s+)?(?:(unlogged|temp|temporary)\s+)?table\s+(?:if\s+not\s+exists\s+)?" + _NAME)
ENABLE_RLS = re.compile(
    r"^alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?" + _NAME + r"\b.*\benable\s+row\s+level\s+security\b")


def check_table_rls(b: Batch) -> list[str]:
    created, enabled = [], set()
    for st in b.statements:
        m = CREATE_TABLE.match(st)
        if m and m.group(1) not in ("temp", "temporary") and exposed(m.group(2)) and q(m.group(2)) not in created:
            created.append(q(m.group(2)))
        m = ENABLE_RLS.match(st)
        if m:
            enabled.add(q(m.group(1)))
    return [f"{t}: CREATE TABLE without ALTER TABLE {t} ENABLE ROW LEVEL SECURITY (then "
            f"REVOKE ALL ON {t} FROM anon, authenticated)" for t in created if t not in enabled]


# ------------------------------------------------------ R2 view security_invoker
CREATE_VIEW = re.compile(
    r"^create\s+(?:or\s+replace\s+)?(?:(temp|temporary)\s+)?(?:recursive\s+)?view\s+" + _NAME + r"(.*)$")
ALTER_VIEW_SET = re.compile(r"^alter\s+view\s+(?:if\s+exists\s+)?" + _NAME + r"\s+(set|reset)\s*\((.*)\)\s*$")
INVOKER_ON = re.compile(r"\bsecurity_invoker\b(?!\s*=\s*(?:false|off|0|no)\b)(?:\s*=\s*(?:true|on|1|yes)\b)?")
INVOKER_OFF = re.compile(r"\bsecurity_invoker\s*=\s*(?:false|off|0|no)\b")


def _view_options(tail: str) -> str:
    """The WITH (...) options before AS in a CREATE VIEW tail, '' when there are none."""
    m = re.match(r"\s*(?:\([^)]*\)\s*)?with\s*\(", tail)
    if not m:
        return ""
    end = sql_lexer.close_paren(tail, m.end() - 1)
    return tail[m.end():end] if end > 0 else ""


def check_view_invoker(b: Batch) -> list[str]:
    missing: list[str] = []
    fixed: set[str] = set()
    bad: list[str] = []
    for st in b.statements:
        m = CREATE_VIEW.match(st)
        if m and m.group(1) is None and exposed(m.group(2)):
            opts = _view_options(m.group(3))
            if INVOKER_ON.search(opts) and not INVOKER_OFF.search(opts):
                fixed.add(q(m.group(2)))
            elif q(m.group(2)) not in missing:
                missing.append(q(m.group(2)))
            continue
        m = ALTER_VIEW_SET.match(st)
        if m and exposed(m.group(1)) and "security_invoker" in m.group(3):
            if m.group(2) == "reset" or INVOKER_OFF.search(m.group(3)):
                bad.append(f"{q(m.group(1))}: ALTER VIEW turns security_invoker off; the view would read past RLS")
            else:
                fixed.add(q(m.group(1)))
    return [f"{v}: CREATE [OR REPLACE] VIEW without WITH (security_invoker = true); the view runs as its owner "
            "and reads past RLS (advisor security_definer_view). OR REPLACE without the option RESETS it."
            for v in missing if v not in fixed] + bad


# ------------------------------------------------- R3 definer revoke + search_path
CREATE_FN = re.compile(r"^create\s+(?:or\s+replace\s+)?(?:function|procedure)\s+" + _NAME + r"\s*\(")
REVOKE_FN = re.compile(r"^revoke\s+(?:execute|all)(?:\s+privileges)?\s+on\s+(?:function|procedure|routine)\s+"
                       + _NAME + r"\b.*?\bfrom\s+(.*)$")
REVOKE_ALL_FNS = re.compile(r"^revoke\s+(?:execute|all)(?:\s+privileges)?\s+on\s+all\s+(?:functions|routines)\s+"
                            r"in\s+schema\s+([\w$]+)\s+from\s+(.*)$")
ALTER_FN_PATH = re.compile(r"^alter\s+(?:function|procedure|routine)\s+" + _NAME + r"\b.*\bset\s+search_path\b")
NEEDED_REVOKE = {"public", "anon", "authenticated"}


def _roles(text: str) -> set[str]:
    text = re.split(r"\b(?:cascade|restrict|granted\s+by)\b", text)[0]
    return {r.strip() for r in text.split(",") if r.strip()}


def _functions(b: Batch) -> list[tuple[str, str]]:
    """(qualified name, statement) for each CREATE FUNCTION/PROCEDURE in an exposed schema."""
    out = []
    for st in b.statements:
        m = CREATE_FN.match(st)
        if m and exposed(m.group(1)):
            out.append((q(m.group(1)), st))
    return out


def _search_path_set(b: Batch) -> set[str]:
    return {q(m.group(1)) for st in b.statements for m in [ALTER_FN_PATH.match(st)] if m}


def check_definer(b: Batch) -> list[str]:
    revoked: dict[str, set[str]] = {}
    schema_wide: dict[str, set[str]] = {}
    for st in b.statements:
        m = REVOKE_FN.match(st)
        if m:
            revoked.setdefault(q(m.group(1)), set()).update(_roles(m.group(2)))
        m = REVOKE_ALL_FNS.match(st)
        if m:
            schema_wide.setdefault(m.group(1), set()).update(_roles(m.group(2)))
    path_set = _search_path_set(b)
    out = []
    for name, st in _functions(b):
        if not re.search(r"\bsecurity\s+definer\b", st):
            continue
        problems = []
        if not re.search(r"\bset\s+search_path\b", st) and name not in path_set:
            problems.append("no SET search_path (advisor 0011)")
        # A trigger function cannot be called through PostgREST; only its search_path matters.
        if not re.search(r"\breturns\s+(?:event_)?trigger\b", st):
            have = revoked.get(name, set()) | schema_wide.get(name.split(".")[0], set())
            lacking = sorted(NEEDED_REVOKE - have)
            if lacking:
                problems.append(f"EXECUTE not revoked from {', '.join(lacking)} (Supabase default privileges grant it "
                                "to anon and authenticated directly; advisor 0028/0029)")
        if problems:
            out.append(f"{name}: SECURITY DEFINER with {'; '.join(problems)}. Add `SET search_path = ''` to the "
                       f"definition and `REVOKE EXECUTE ON FUNCTION {name}(<args>) FROM public, anon, authenticated;`")
    return out


# ------------------------------------------------- R4 grants to API roles
GRANT = re.compile(r"^grant\s+(.*?)\s+on\s+(.*?)\s+to\s+(.*)$")
DEFAULT_GRANT = re.compile(r"^alter\s+default\s+privileges\b.*\bgrant\b.*\bto\s+(.*)$")
# The reason must be on the marker's own line: [ \t], not \s, or an empty reason would borrow
# the next line (the GRANT itself) as its "reason".
ALLOW = re.compile(r"supabase-guard:[ \t]*allow-grant[ \t]+([\w$.\"]+)[ \t]*(?:--|:|—|-)[ \t]*(\S[^\n]*)",
                   re.IGNORECASE)


def _grant_object(on: str) -> tuple[str, str] | None:
    """(kind, qualified name) of a GRANT target; None for a schema (not a relation or function)."""
    on = on.strip()
    if re.match(r"^(?:schema|database|language|tablespace|foreign\s+(?:data\s+wrapper|server))\b", on):
        return None
    m = re.match(r"^all\s+(tables|sequences|functions|routines|procedures)\s+in\s+schema\s+([\w$]+)", on)
    if m:
        return ("all " + m.group(1), m.group(2) + ".*")
    m = re.match(r"^(?:(table|sequence|function|procedure|routine)\s+)?" + _NAME, on)
    return (m.group(1) or "table", q(m.group(2))) if m else ("?", on[:40])


def allowed_grants(raw: str) -> dict[str, str]:
    """{object: reason} from inline allow markers in the raw SQL (comments are where they live)."""
    # A reason is words, not punctuation: "-- allow-grant x --" must not pass with "-" as its reason.
    return {q(m.group(1).replace('"', "").lower()): m.group(2).strip() for m in ALLOW.finditer(raw or "")
            if len(re.findall(r"[A-Za-z]", m.group(2))) >= 3}


def check_grants(b: Batch) -> list[str]:
    allow = allowed_grants(b.raw)
    out = []
    for st in b.statements:
        m = DEFAULT_GRANT.match(st)
        if m:
            roles = _roles(m.group(1)) & API_ROLES
            if roles:
                out.append(f"ALTER DEFAULT PRIVILEGES grants to {', '.join(sorted(roles))}: every future object "
                           "would be exposed. Not allowed from a migration or session.")
            continue
        m = GRANT.match(st)
        if not m:
            continue
        roles = _roles(m.group(3)) & API_ROLES
        target = _grant_object(m.group(2))
        if not roles or target is None:
            continue
        kind, name = target
        if name in allow and allow[name]:
            continue
        out.append(f"{name} ({kind}): GRANT {m.group(1)} TO {', '.join(sorted(roles))} with no allow marker. If it is "
                   f"meant, add `-- supabase-guard: allow-grant {name} -- <why this role needs it>` in the same "
                   "file; otherwise drop the grant (service_role bypasses RLS and needs no grant).")
    return out


# ------------------------------------------------- R5 search_path on any function
def check_search_path(b: Batch) -> list[str]:
    path_set = _search_path_set(b)
    return [f"{name}: new function without SET search_path (advisor 0011; 96 existing are reported debt)"
            for name, st in _functions(b)
            if not re.search(r"\bsecurity\s+definer\b", st)  # R3 already blocks a definer without it
            and not re.search(r"\bset\s+search_path\b", st) and name not in path_set]


# The engine reads this list as data. A rule = id, what it guards, its action, its check.
RULES = [
    {"id": "R1", "title": "table has RLS", "action": "block", "check": check_table_rls, "dynamic_blind": True},
    {"id": "R2", "title": "view is security_invoker", "action": "block", "check": check_view_invoker, "dynamic_blind": True},
    {"id": "R3", "title": "definer revoked + search_path", "action": "block", "check": check_definer, "dynamic_blind": True},
    {"id": "R4", "title": "no unmarked grant to anon/authenticated", "action": "block", "check": check_grants, "dynamic_blind": True},
    {"id": "R5", "title": "function sets search_path", "action": "warn", "check": check_search_path, "dynamic_blind": False},
]


def evaluate(sql: str) -> list[Result]:
    """One verdict per rule for one file or SQL call."""
    b = Batch.of(sql)
    out = []
    for rule in RULES:
        try:
            findings = rule["check"](b)
        except Exception as e:  # noqa: BLE001 - one broken rule must not hide the others
            out.append(Result(rule["id"], NOT_CHECKED, f"{rule['title']}: check failed ({e})"))
            continue
        if findings:
            out.append(Result(rule["id"], BLOCK if rule["action"] == "block" else WARN, " | ".join(findings)))
        elif b.has_dynamic and rule["dynamic_blind"]:
            out.append(Result(rule["id"], NOT_CHECKED, f"{rule['title']}: a DO block's dynamic SQL is not read"))
        else:
            out.append(Result(rule["id"], PASS, rule["title"]))
    return out


def blocking(results: list[Result]) -> list[Result]:
    return [r for r in results if r.verdict == BLOCK]


def changed_migrations(base: str) -> list[str]:
    out = subprocess.run(["git", "diff", "--name-only", "--diff-filter=AM", f"{base}...HEAD", "--", MIG_DIR],
                         capture_output=True, text=True, check=True).stdout
    return [p for p in out.split() if p.endswith(".sql")]


def lint_files(paths: list[str]) -> int:
    failed = 0
    for p in paths:
        with open(p, encoding="utf-8") as fh:
            results = evaluate(fh.read())
        for r in results:
            line = f"{r.rule} {r.verdict}: {r.reason}"
            if r.verdict == BLOCK:
                failed = 1
                print(f"::error file={p}::{line}")
            elif r.verdict in (WARN, NOT_CHECKED):
                print(f"::warning file={p}::{line}")
            else:
                print(f"{p}: {line}")
    print(f"supabase_rules: {len(paths)} file(s) checked, {'FAIL' if failed else 'ok'}")
    return failed


# Replays from real history (the statements that shipped), kept inline so the session mod's
# copy can run them with no repo checkout. CI also replays the real files (lint workflow).
REPLAY_R1_LC1550 = """
CREATE TABLE IF NOT EXISTS public.product_price_write_log (id bigserial primary key, note text);
CREATE TABLE IF NOT EXISTS public.price_write_policy (mode text not null default 'warn');
"""
REPLAY_R2_LC1611 = """
create or replace view public.v_product_tags_evidence as
  select p.id as product_id, t.tag from public.products p join public.product_tags t on t.product_id = p.id;
"""
REPLAY_R3_R4_LC1099 = """
CREATE OR REPLACE VIEW public.page_keyword_diffs AS SELECT 1 AS a;
CREATE OR REPLACE FUNCTION public.get_article_keyword_summary(p_article_id uuid)
RETURNS TABLE (k text) LANGUAGE sql STABLE SECURITY DEFINER AS $$ select 'x' $$;
REVOKE ALL ON FUNCTION public.get_article_keyword_summary FROM anon;
GRANT EXECUTE ON FUNCTION public.get_article_keyword_summary TO authenticated;
GRANT SELECT ON public.page_keyword_diffs TO authenticated;
"""


def _selftest() -> int:
    checks = fails = 0

    def ck(cond: bool, label: str) -> None:
        nonlocal checks, fails
        checks += 1
        if not cond:
            fails += 1
            sys.stderr.write(f"  FAIL: {label}\n")

    def v(sql: str) -> dict[str, Result]:
        return {r.rule: r for r in evaluate(sql)}

    # ---- replays: each rule blocks the migration that broke it
    r = v(REPLAY_R1_LC1550)
    ck(r["R1"].verdict == BLOCK and "price_write_policy" in r["R1"].reason, "R1 replay LC-1550 blocks")
    r = v(REPLAY_R2_LC1611)
    ck(r["R2"].verdict == BLOCK and "v_product_tags_evidence" in r["R2"].reason, "R2 replay LC-1611 blocks")
    r = v(REPLAY_R3_R4_LC1099)
    ck(r["R3"].verdict == BLOCK and "no SET search_path" in r["R3"].reason
       and "EXECUTE not revoked from authenticated, public (" in r["R3"].reason,
       "R3 replay LC-1099 blocks: no search_path, revoke lacks public + authenticated (anon was revoked)")
    ck(r["R4"].verdict == BLOCK and "page_keyword_diffs" in r["R4"].reason
       and "get_article_keyword_summary" in r["R4"].reason, "R4 replay LC-1099 blocks both grants")
    ck(r["R2"].verdict == BLOCK and "page_keyword_diffs" in r["R2"].reason, "R2 also catches page_keyword_diffs")

    # ---- R1
    ok_r1 = REPLAY_R1_LC1550 + "alter table public.product_price_write_log enable row level security; " \
        "alter table if exists only price_write_policy enable row level security;"
    ck(v(ok_r1)["R1"].verdict == PASS, "R1 passes with ENABLE (qualified or not)")
    ck(v("create temp table s (a int); create table private.x (a int)")["R1"].verdict == PASS,
       "R1: temp and non-exposed schemas exempt")
    ck(v("create table m (a int) partition by range (a); alter table m enable row level security; "
         "create table m_1 partition of m for values from (1) to (2)")["R1"].reason.startswith("public.m_1"),
       "R1: a partition needs its own RLS")
    ck(v("insert into t values ('create table x (a int)')")["R1"].verdict == PASS, "R1: a literal is not DDL")

    # ---- R2
    ck(v("create view public.v with (security_invoker = true) as select 1")["R2"].verdict == PASS, "R2 with option")
    ck(v("create or replace view v with (security_invoker=on, security_barrier) as select 1")["R2"].verdict == PASS,
       "R2 option among others, `on`")
    ck(v("create view v with (security_invoker) as select 1")["R2"].verdict == PASS, "R2 bare boolean option")
    ck(v("create view v (a, b) with (security_invoker = true) as select 1, 2")["R2"].verdict == PASS,
       "R2 column list before WITH")
    ck(v("create view v with (security_invoker = false) as select 1")["R2"].verdict == BLOCK, "R2 explicit false")
    ck(v("create view v as select 1; alter view v set (security_invoker = true)")["R2"].verdict == PASS,
       "R2 fixed by ALTER VIEW in the same batch")
    ck(v("alter view public.v set (security_invoker = off)")["R2"].verdict == BLOCK, "R2 ALTER VIEW off blocks")
    ck(v("alter view v reset (security_invoker)")["R2"].verdict == BLOCK, "R2 RESET blocks")
    ck(v("create view private.v as select 1; create temp view t as select 1")["R2"].verdict == PASS,
       "R2 non-exposed and temp views exempt")
    ck(v("create materialized view mv as select 1")["R2"].verdict == PASS, "R2 matview is not a view here")
    ck(v("create view v as select 'with (security_invoker = true)' as s")["R2"].verdict == BLOCK,
       "R2 the option inside a literal does not count")

    # ---- R3
    good_fn = ("create or replace function public.f(a int) returns int language sql security definer "
               "set search_path = '' as $$ select 1 $$; "
               "revoke execute on function public.f(int) from public, anon, authenticated")
    ck(v(good_fn)["R3"].verdict == PASS, "R3 passes: search_path + full revoke")
    ck(v(good_fn.replace("set search_path = '' ", "") + "; alter function public.f(int) set search_path = ''")
       ["R3"].verdict == PASS, "R3 search_path via ALTER FUNCTION")
    ck("anon" in v(good_fn.replace("public, anon, authenticated", "public"))["R3"].reason,
       "R3 PUBLIC alone is not enough (default privileges)")
    ck(v(good_fn.replace("public, anon, authenticated", "public") + "; revoke all on function f from anon; "
         "revoke execute on function f(int) from authenticated cascade")["R3"].verdict == PASS,
       "R3 revokes may be split across statements")
    ck(v(good_fn.split(";")[0] + "; revoke execute on all functions in schema public from public, anon, authenticated")
       ["R3"].verdict == PASS, "R3 schema-wide revoke counts")
    trig = "create function public.tg() returns trigger language plpgsql security definer as $$ begin return new; end $$"
    ck("search_path" in v(trig)["R3"].reason and "not revoked" not in v(trig)["R3"].reason,
       "R3 trigger function: search_path only")
    ck(v("create function public.g() returns int language sql security invoker as $$ select 1 $$")["R3"].verdict
       == PASS, "R3 invoker is not R3's")
    ck(v("create function private.h() returns int language sql security definer as $$ select 1 $$")["R3"].verdict
       == PASS, "R3 non-exposed schema exempt")

    # ---- R4
    ck(v("grant select on public.t to service_role")["R4"].verdict == PASS, "R4 service_role is fine")
    ck(v("grant usage on schema public to anon")["R4"].verdict == PASS, "R4 schema grants are not R4's")
    marked = "-- supabase-guard: allow-grant public.page_keyword_diffs -- the portal's logged-in users read it\n" \
             "grant select on public.page_keyword_diffs to authenticated"
    ck(v(marked)["R4"].verdict == PASS, "R4 allow marker with a reason passes")
    ck(v("-- supabase-guard: allow-grant public.other -- reason\ngrant select on public.t to anon")["R4"].verdict
       == BLOCK, "R4 a marker for another object does not cover this one")
    ck(v("-- supabase-guard: allow-grant public.t --\ngrant select on public.t to anon")["R4"].verdict == BLOCK,
       "R4 a marker with no reason does not count")
    ck(v("grant all on all tables in schema public to authenticated")["R4"].verdict == BLOCK, "R4 schema-wide grant")
    ck(v("alter default privileges in schema public grant select on tables to anon")["R4"].verdict == BLOCK,
       "R4 default privileges to anon")
    ck(v("grant execute on function public.f(int) to anon, service_role")["R4"].verdict == BLOCK,
       "R4 function grant to anon")

    # ---- R5
    ck(v("create function public.p() returns int language sql as $$ select 1 $$")["R5"].verdict == WARN,
       "R5 warns, never blocks")
    ck(v("create function public.p() returns int language sql set search_path = public as $$ select 1 $$")["R5"]
       .verdict == PASS, "R5 search_path set")
    ck(v(good_fn.replace("set search_path = '' ", ""))["R5"].verdict == PASS, "R5 leaves definers to R3")

    # ---- engine
    d = v("do $$ begin execute 'create table x (a int)'; end $$")
    ck(d["R1"].verdict == NOT_CHECKED and d["R5"].verdict == PASS, "a DO block is NOT CHECKED, never PASS")
    ck([r.rule for r in evaluate("")] == ["R1", "R2", "R3", "R4", "R5"] and not blocking(evaluate("")),
       "one verdict per rule, in RULES order; empty input blocks nothing")
    ck(all(r.verdict == PASS for r in evaluate("select 1")), "ordinary SQL passes every rule")
    saved = RULES[0]["check"]
    RULES[0]["check"] = lambda b: 1 / 0
    try:
        ck(v("select 1")["R1"].verdict == NOT_CHECKED, "a crashing rule is NOT CHECKED, not hidden")
    finally:
        RULES[0]["check"] = saved

    vd = v("do $$ begin perform 1; end $$")
    ck(all(vd[r].verdict == NOT_CHECKED for r in ("R1", "R2", "R3", "R4")) and vd["R5"].verdict == PASS,
       "a DO block makes every dynamic-blind rule NOT CHECKED (R1-R4), and only those")
    ck("public.t (table)" in v("grant select on public.t to anon")["R4"].reason,
       "a GRANT with no object kind is named as a table")
    ck("public.* (all tables)" in v("grant select on all tables in schema public to anon")["R4"].reason,
       "GRANT ON ALL TABLES IN SCHEMA is named as the whole schema")

    # ---- CLI + --base through real git
    import tempfile
    with tempfile.TemporaryDirectory() as repo:
        def git(*a):
            subprocess.run(["git", "-C", repo, *a], check=True, capture_output=True, text=True)
        git("init", "-q", "-b", "main")
        git("config", "user.email", "t@t"); git("config", "user.name", "t")
        git("config", "commit.gpgsign", "false")  # a session's signing helper is not this test's subject
        os.makedirs(os.path.join(repo, MIG_DIR))
        open(os.path.join(repo, MIG_DIR, "001_old.sql"), "w").write(REPLAY_R1_LC1550)
        git("add", "-A"); git("commit", "-qm", "base")
        git("checkout", "-qb", "pr")
        open(os.path.join(repo, MIG_DIR, "002_new.sql"), "w").write(ok_r1)
        open(os.path.join(repo, "notes.txt"), "w").write("x")
        git("add", "-A"); git("commit", "-qm", "pr")
        cwd = os.getcwd()
        try:
            os.chdir(repo)
            ck(changed_migrations("main") == [f"{MIG_DIR}/002_new.sql"], "--base lists only the PR's migrations")
            try:
                changed_migrations("no-such-ref")
                ck(False, "--base on an unknown ref raises")
            except subprocess.CalledProcessError:
                ck(True, "--base on an unknown ref raises")
            import contextlib
            import io
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf):
                rc_bad = lint_files([f"{MIG_DIR}/001_old.sql"])
                rc_good = lint_files([f"{MIG_DIR}/002_new.sql"])
            ck(rc_bad == 1 and rc_good == 0, "CLI: the LC-1550 replay fails, the fixed file passes")
            ck("::error file=" in buf.getvalue() and "R1 BLOCK" in buf.getvalue(), "CLI: blocks are annotations")
            open(os.path.join(repo, MIG_DIR, "003_warn.sql"), "w").write(
                "create function public.w() returns int language sql as $$ select 1 $$;")
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf):
                rc_warn = lint_files([f"{MIG_DIR}/003_warn.sql"])
            wl = buf.getvalue().splitlines()
            ck(rc_warn == 0 and f"::warning file={MIG_DIR}/003_warn.sql::R5 WARN" in "\n".join(wl)
               and not any(l.startswith("::warning") and " PASS" in l for l in wl),
               "CLI: a warning is a ::warning annotation, a PASS is not, and neither fails")
            p = subprocess.run([sys.executable, os.path.abspath(__file__), "--files", f"{MIG_DIR}/001_old.sql"],
                               capture_output=True, text=True)
            ck(p.returncode == 1 and "R1 BLOCK" in p.stdout, "CLI: --files fails on the LC-1550 replay")
            p = subprocess.run([sys.executable, os.path.abspath(__file__), "--base", "main"],
                               capture_output=True, text=True)
            ck(p.returncode == 0 and "1 file(s) checked" in p.stdout, "CLI: --base main checks the PR's one migration")
        finally:
            os.chdir(cwd)

    print(f"supabase_rules selftest: {checks - fails}/{checks} checks passed")
    return 1 if fails else 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--selftest", action="store_true")
    ap.add_argument("--files", nargs="*")
    ap.add_argument("--base")
    a = ap.parse_args()
    if a.selftest:
        return _selftest()
    if a.files is not None:
        return lint_files(a.files)
    if a.base:
        return lint_files(changed_migrations(a.base))
    ap.error("one of --selftest, --files, --base")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
