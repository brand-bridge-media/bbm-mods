#!/usr/bin/env python3
"""Verdict gates for .github/workflows/claude-mods.yml (LC-1711).

Kept in a script, not inline YAML, so each gate can carry a --selftest that feeds it
empty / decoy / zero-pass / ambiguous input and asserts it says NO. A gate that has
never been seen red is not verified (guardrail-design).

  ci_gates.py listed <marketplace.json> <mod>    exit 0 iff plugins[].source == ./claude-mods/<mod>
  ci_gates.py summary <test-output-file> <rc>     prints pass count iff one clean summary, exit 0
  ci_gates.py parity <fileA> <fileB>              exit 0 iff both carry the same non-empty PLAIN-COMMAND block
  ci_gates.py --selftest
"""
import json
import re
import sys


def is_listed(marketplace_text: str, mod: str) -> bool:
    try:
        plugins = json.loads(marketplace_text).get("plugins", [])
    except (ValueError, AttributeError):
        return False
    if not isinstance(plugins, list):
        return False
    want = "./claude-mods/" + mod
    return any(isinstance(p, dict) and p.get("source") == want for p in plugins)


def clean_pass_count(out: str, rc: int):
    """Passed-test count, or None unless the run is exactly one unambiguous clean summary."""
    if rc != 0:
        return None
    p = re.findall(r"(?m)^ *(\d+) pass$", out)
    f = re.findall(r"(?m)^ *(\d+) fail$", out)
    r = re.findall(r"(?m)^Ran (\d+) tests? across \d+ files?", out)
    if len(p) != 1 or len(f) != 1 or len(r) != 1:
        return None
    p, f, r = int(p[0]), int(f[0]), int(r[0])
    if p < 1 or f != 0 or p + f != r:
        return None
    return p


PLAIN_BEGIN = "// PLAIN-COMMAND-BEGIN"
PLAIN_END = "// PLAIN-COMMAND-END"


def plain_block(text: str):
    """The text between the PLAIN-COMMAND markers, or None unless there is exactly one well-formed,
    non-trivial block. run-state and refresh-run-guard each carry a copy of the plain-command test
    (a mod cannot import a sibling), so a fix in one must reach the other."""
    if text.count(PLAIN_BEGIN) != 1 or text.count(PLAIN_END) != 1:
        return None
    a = text.index(PLAIN_BEGIN)
    b = text.index(PLAIN_END)
    if b < a:
        return None
    body = text[text.index("\n", a) + 1 : b] if "\n" in text[a:b] else ""
    if sum(1 for ln in body.splitlines() if ln.strip()) < 20:
        return None
    return body


def plain_parity(a: str, b: str) -> bool:
    ba, bb = plain_block(a), plain_block(b)
    return ba is not None and ba == bb


def _demo() -> str:
    return PLAIN_BEGIN + "\n" + "".join(f"line {i}\n" for i in range(25)) + PLAIN_END + "\n"


def selftest() -> int:
    good = " 6 pass\n 0 fail\nRan 6 tests across 2 files. [0.5s]\n"
    cases = [
        # (name, got, expected)
        ("clean summary", clean_pass_count(good, 0), 6),
        ("empty output", clean_pass_count("", 0), None),
        ("nonzero rc with clean text", clean_pass_count(good, 1), None),
        ("zero pass", clean_pass_count(" 0 pass\n 0 fail\nRan 0 tests across 0 files.\n", 0), None),
        ("a failure", clean_pass_count(" 5 pass\n 1 fail\nRan 6 tests across 1 file.\n", 0), None),
        ("decoy extra pass line", clean_pass_count("  5 pass\n" + good, 0), None),
        ("decoy fail line after real pass", clean_pass_count(good + " 1 fail\n", 0), None),
        ("ran count disagrees", clean_pass_count(" 6 pass\n 0 fail\nRan 9 tests across 2 files.\n", 0), None),
        ("no ran line", clean_pass_count(" 6 pass\n 0 fail\n", 0), None),
        ("listed by source", is_listed('{"plugins":[{"name":"a","source":"./claude-mods/a"}]}', "a"), True),
        ("only in description", is_listed('{"description":"./claude-mods/a","plugins":[]}', "a"), False),
        ("other mod listed", is_listed('{"plugins":[{"source":"./claude-mods/b"}]}', "a"), False),
        ("prefix is not a match", is_listed('{"plugins":[{"source":"./claude-mods/ab"}]}', "a"), False),
        ("garbage json", is_listed("not json", "a"), False),
        ("plugins not a list", is_listed('{"plugins":{"source":"./claude-mods/a"}}', "a"), False),
        ("empty plugins", is_listed('{"plugins":[]}', "a"), False),
        ("parity: identical blocks", plain_parity(_demo(), _demo()), True),
        ("parity: one character differs", plain_parity(_demo(), _demo().replace("line 3", "line X")), False),
        ("parity: outside text may differ", plain_parity("a\n" + _demo(), "b\n" + _demo() + "c"), True),
        ("parity: markers missing", plain_parity(_demo(), "no markers at all"), False),
        ("parity: both missing is not parity", plain_parity("x", "x"), False),
        ("parity: empty block is not parity", plain_parity(PLAIN_BEGIN + "\n" + PLAIN_END, PLAIN_BEGIN + "\n" + PLAIN_END), False),
        ("parity: two begin markers", plain_parity(_demo() + _demo(), _demo() + _demo()), False),
        ("parity: end before begin", plain_parity(PLAIN_END + "\n" + PLAIN_BEGIN, PLAIN_END + "\n" + PLAIN_BEGIN), False),
    ]
    bad = [c for c in cases if c[1] != c[2]]
    for name, got, want in bad:
        print(f"FAIL {name}: got {got!r}, want {want!r}")
    n = len(cases) - len(bad)
    print(f"selftest: {n}/{len(cases)} checks passed")
    return 1 if bad else 0


def main(argv) -> int:
    if argv[1:] == ["--selftest"]:
        return selftest()
    if len(argv) == 4 and argv[1] == "listed":
        return 0 if is_listed(open(argv[2]).read(), argv[3]) else 1
    if len(argv) == 4 and argv[1] == "summary":
        n = clean_pass_count(open(argv[2]).read(), int(argv[3]))
        if n is None:
            return 1
        print(n)
        return 0
    if len(argv) == 4 and argv[1] == "parity":
        return 0 if plain_parity(open(argv[2]).read(), open(argv[3]).read()) else 1
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
