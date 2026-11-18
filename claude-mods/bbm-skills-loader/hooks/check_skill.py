#!/usr/bin/env python3
"""Checks the skill this plugin carries (LC-2227). Not a hook: nothing calls it at runtime.

Why it exists: claude.ai chat and Cowork find every BBM skill through this one loader. A broken
frontmatter, a description over claude.ai's 1024-character limit, or the pre-LC-1888 repo name
would strand them silently. A mod test cannot read files, so the check lives here, and
claude-mods.yml runs it on every PR through its `--selftest` count line.

  python3 check_skill.py            check ../skills/bbm-skills-loader/SKILL.md, exit 1 on a problem
  python3 check_skill.py --selftest check the real file plus decoys that must be refused
"""
import os
import re
import sys

NAME = "bbm-skills-loader"
SKILL = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "skills", NAME, "SKILL.md")
REPO = "brand-bridge-media/claude-skills"
OLD_REPO = "mykhaylenkostan/claude-skills"
INDEX = "living-cozy/skills/skill-library-index/SKILL.md"


def problems(text: str) -> list:
    out = []
    m = re.match(r"---\n(.*?)\n---\n", text, re.S)
    if not m:
        return ["no frontmatter"]
    fm = {}
    for line in m.group(1).splitlines():
        k, sep, v = line.partition(":")
        if sep:
            fm[k.strip()] = v.strip()
    if fm.get("name") != NAME:
        out.append(f"name is {fm.get('name')!r}, want {NAME!r}")
    desc = fm.get("description", "")
    if not 100 <= len(desc) <= 1024:
        out.append(f"description is {len(desc)} chars, want 100..1024")
    if REPO not in text:
        out.append(f"does not name {REPO}")
    if OLD_REPO in text:
        out.append(f"still names the pre-LC-1888 repo {OLD_REPO}")
    if INDEX not in text:
        out.append(f"does not point at {INDEX}")
    return out


def selftest() -> int:
    with open(SKILL, encoding="utf-8") as f:
        real = f.read()
    good_desc = "d" * 200
    base = f"---\nname: {NAME}\ndescription: {good_desc}\n---\n{REPO} {INDEX}\n"
    cases = [
        ("the shipped SKILL.md passes", real, True),
        ("a minimal good file passes", base, True),
        ("no frontmatter is refused", f"# x\n{REPO} {INDEX}\n", False),
        ("a wrong name is refused", base.replace(f"name: {NAME}", "name: other"), False),
        ("a description over 1024 is refused", base.replace(good_desc, "d" * 1025), False),
        ("an empty description is refused", base.replace(good_desc, ""), False),
        ("the old repo name is refused", base + OLD_REPO + "\n", False),
        ("a missing org repo is refused", base.replace(REPO, "x/y"), False),
        ("a missing index pointer is refused", base.replace(INDEX, "x"), False),
    ]
    passed = 0
    for label, text, want_ok in cases:
        ok = not problems(text)
        if ok == want_ok:
            passed += 1
        else:
            print(f"FAIL {label}: {problems(text)}")
    print(f"selftest: {passed}/{len(cases)} checks passed")
    return 0 if passed == len(cases) else 1


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        sys.exit(selftest())
    with open(SKILL, encoding="utf-8") as f:
        found = problems(f.read())
    for p in found:
        print(f"[mod:bbm-skills-loader] {p}")
    sys.exit(1 if found else 0)
