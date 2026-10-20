#!/usr/bin/env python3
"""Shared SQL reader for the execute_sql guards (LCH-528).

WHAT IT DOES. Turns a SQL string into statements a guard can reason about without
being fooled by text that only LOOKS like SQL: comments are dropped, string and
dollar-quoted literals are collapsed to a placeholder ('?' and $$?$$), so the word
"DROP" inside a knowledge memory being INSERTed is not a DROP.

WHY A SHARED MODULE. prod-deploy-guard (is this DDL?) and bulk-write-guard (can this
write touch more than 5 rows?) ask different questions of the same text. Two private
lexers would drift, and a guard whose lexer disagrees with its sibling's produces
"allowed here, denied there" for the same statement — the inconsistency LC-1683 was
written to remove.

WHAT IT IS NOT. A parser. It is deliberately conservative: anything it cannot read
with confidence, the guards treat as unprovable and refuse, with a message that says
how to rewrite the statement so it can be read. Stdlib only.

Self-test: python3 sql_lexer.py --selftest
"""
from __future__ import annotations

import re
import sys

PLACEHOLDER = "'?'"
DOLLAR_PLACEHOLDER = "$$?$$"

_DOLLAR_TAG = re.compile(r"\$([A-Za-z_][A-Za-z0-9_]*)?\$")


def strip(sql: str) -> str:
    """Drop comments, collapse literals. Quoted identifiers keep their text."""
    out: list[str] = []
    i, n = 0, len(sql)
    while i < n:
        c = sql[i]
        nxt = sql[i + 1] if i + 1 < n else ""
        if c == "-" and nxt == "-":
            j = sql.find("\n", i)
            i = n if j < 0 else j
            continue
        if c == "/" and nxt == "*":
            # Postgres block comments nest.
            depth, i = 1, i + 2
            while i < n and depth:
                if sql.startswith("/*", i):
                    depth, i = depth + 1, i + 2
                elif sql.startswith("*/", i):
                    depth, i = depth - 1, i + 2
                else:
                    i += 1
            out.append(" ")
            continue
        if c == "'":
            # E'...' strings honour backslash escapes (E'it\'s'); plain strings do not.
            escapes = i > 0 and sql[i - 1] in "eE" and (i < 2 or not (sql[i - 2].isalnum()
                                                                       or sql[i - 2] == "_"))
            i += 1
            while i < n:
                if escapes and sql[i] == "\\":
                    i += 2
                    continue
                if sql[i] == "'":
                    if i + 1 < n and sql[i + 1] == "'":
                        i += 2
                        continue
                    i += 1
                    break
                i += 1
            out.append(PLACEHOLDER)
            continue
        if c == '"':
            j = sql.find('"', i + 1)
            j = n - 1 if j < 0 else j
            out.append(sql[i + 1:j])
            i = j + 1
            continue
        if c == "$":
            m = _DOLLAR_TAG.match(sql, i)
            # $1 positional params are not dollar quotes; the tag regex excludes digits.
            if m:
                tag = m.group(0)
                end = sql.find(tag, m.end())
                i = n if end < 0 else end + len(tag)
                out.append(DOLLAR_PLACEHOLDER)
                continue
        out.append(c)
        i += 1
    return "".join(out)


def statements(sql: str) -> list[str]:
    """Stripped, lower-cased, whitespace-collapsed statements, empties dropped."""
    body = strip(sql or "")
    return [s for s in (" ".join(p.split()).lower() for p in body.split(";")) if s]


def split_top(text: str, sep: str) -> list[str]:
    """Split on a keyword (' and ', ' or ') or a char (',') at paren depth 0."""
    parts, depth, start, i = [], 0, 0, 0
    kw = sep.strip()
    word = kw.isalpha()
    # A keyword is bounded by anything that is not an identifier char, so `or(` splits too.
    word_rx = re.compile(rf"(?<![\w$]){kw}(?![\w$])") if word else None
    while i < len(text):
        c = text[i]
        if c == "(":
            depth += 1
        elif c == ")":
            depth -= 1
        elif depth == 0:
            if word:
                m = word_rx.match(text, i)
                if m:
                    parts.append(text[start:i])
                    i = m.end()
                    start = i
                    continue
            elif c == sep:
                parts.append(text[start:i])
                start = i + 1
        i += 1
    parts.append(text[start:])
    return [p.strip() for p in parts]


def find_top(text: str, word: str, start: int = 0) -> int:
    """Index of `word` as a whole word at paren depth 0 from `start`, else -1.

    Depth is counted from `start`, so a subquery's WHERE (depth 1) is never
    mistaken for the outer statement's.
    """
    depth = 0
    rx = re.compile(rf"\b{re.escape(word)}\b")
    i = start
    while i < len(text):
        c = text[i]
        if c == "(":
            depth += 1
        elif c == ")":
            depth -= 1
        elif depth == 0:
            m = rx.match(text, i)
            if m:  # \b also checks the char before i, so "x_where" never matches
                return i
        i += 1
    return -1


def close_paren(text: str, open_idx: int) -> int:
    """Index of the ')' matching text[open_idx] == '(' ; -1 if unbalanced."""
    depth = 0
    for i in range(open_idx, len(text)):
        if text[i] == "(":
            depth += 1
        elif text[i] == ")":
            depth -= 1
            if depth == 0:
                return i
    return -1


def _selftest() -> int:
    checks = fails = 0

    def ck(cond: bool, label: str) -> None:
        nonlocal checks, fails
        checks += 1
        if not cond:
            fails += 1
            sys.stderr.write(f"  FAIL: {label}\n")

    ck(statements("select 1; ; SELECT  2") == ["select 1", "select 2"], "split + normalise")
    ck(statements("insert into t values ('drop table x; delete from y')")
       == ["insert into t values ('?')"], "a semicolon inside a string does not split")
    ck(statements("select 1 -- drop table x\n") == ["select 1"], "line comment dropped")
    ck(statements("select /* a /* nested */ drop */ 1") == ["select 1"],
       "nested block comment dropped")
    ck(statements("select 'it''s'") == ["select '?'"], "doubled quote stays inside the literal")
    ck(statements("do $body$ begin drop table x; end $body$") == ["do $$?$$"],
       "tagged dollar quote collapsed, inner semicolon ignored")
    ck(statements("select $$x;y$$, $1") == ["select $$?$$, $1"],
       "plain dollar quote collapsed; $1 param untouched")
    ck(statements('update "Products" set a=1') == ["update products set a=1"],
       "quoted identifier keeps its text")
    ck(split_top("a = 1 and (b = 2 or c = 3) and d in (1, 2)", " and ")
       == ["a = 1", "(b = 2 or c = 3)", "d in (1, 2)"], "top-level AND split respects parens")
    ck(split_top("(1, 2), (3, (4, 5))", ",") == ["(1, 2)", "(3, (4, 5))"], "top-level comma split")
    ck(find_top("update t set a = (select 1 where x) where id = 1", "where") == 36,
       "find_top skips a WHERE inside parens")
    ck(find_top("set a = (select x from y where id = 'z')", "where") == -1,
       "no top-level WHERE -> -1")
    ck(find_top("somewhere where", "where") == 10, "find_top matches whole words only")
    ck(find_top("x_where where", "where") == 8, "an underscore-joined word is not the keyword")
    ck(close_paren("x (a (b) c) d", 2) == 10, "matching paren found")
    ck(close_paren("(a", 0) == -1, "unbalanced paren reports -1")
    ck(statements("select 1 -- drop table x") == ["select 1"],
       "line comment at end of input with no newline")
    ck(statements("select 3 - 1, 4 / 2") == ["select 3 - 1, 4 / 2"],
       "a lone minus or slash is arithmetic, not a comment")
    ck(statements("select 1 --x\nselect 2") == ["select 1 select 2"],
       "line comment ends at the newline")
    ck(statements(None) == [], "None is empty, not a crash")
    ck(statements("insert into t values (E'it\\'s'); drop table z")
       == ["insert into t values (e'?')", "drop table z"], "E'' backslash escape keeps the literal closed")
    ck(statements("select 'a\\'; drop table z") == ["select '?'", "drop table z"],
       "a backslash in a plain string is not an escape")
    ck(statements("select name'x'") == ["select name'?'"], "E only counts as a prefix, not inside a word")
    ck(statements("E'it\\'s'; drop table z") == ["e'?'", "drop table z"],
       "an E'' string at the very start of the input is still an escape string")
    ck(split_top("id='a' and b=1 or(c=2)", " or ") == ["id='a' and b=1", "(c=2)"],
       "or( splits without surrounding spaces")
    ck(split_top("color = 1 and orders = 2", " or ") == ["color = 1 and orders = 2"],
       "or inside identifiers does not split")
    # Fuzz: adversarial fragments must terminate and return a list (no hang, no raise).
    import random
    rnd = random.Random(528)
    frags = ["'", '"', "$$", "$a$", "--", "/*", "*/", "\n", ";", "(", ")", "x", " ", "''", "$1"]
    ok = True
    for _ in range(3000):
        try:
            text = "".join(rnd.choice(frags) for _ in range(rnd.randint(0, 40)))
            ok &= isinstance(statements(text), list)
        except Exception:  # noqa: BLE001
            ok = False
    ck(ok, "3000 adversarial inputs terminate and return a list")
    ck(statements("select 'unterminated") == ["select '?'"], "unterminated literal does not crash")

    print(f"sql_lexer selftest: {checks - fails}/{checks} checks passed")
    return 1 if fails else 0


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        raise SystemExit(_selftest())
    raise SystemExit(0)
