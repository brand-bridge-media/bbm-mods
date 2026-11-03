#!/usr/bin/env python3
"""PreToolUse nudge: do not grow a source file that is already over the size limit (LC-1983).

WHAT IT DOES. On Write / Edit / MultiEdit to a .py/.ts/.tsx/.js/.mjs file that is already over the
limit (1,500 lines, or the `limit` in the repo's scripts/ci/file_size_ratchet.json), adds context
reminding the session of the strangler rule (CLAUDE.md section 3): extract the job you are touching
into its own module rather than add to the big file. ADVISORY ONLY: it never denies or asks. The
gate is CI (file-size-ratchet); this is the reminder at the moment of the edit.

QUIET WHEN IT CAN BE. Tests, generated files, vendored code and migrations are out of scope (same
globs as the CI check, read from the repo's config when it has one). An Edit that visibly removes
more lines than it adds says nothing: shrinking is what we want.

WHICH TICKET. Files with a known split ticket name it (SPLIT_TICKETS). Any other file is told to
open a split ticket before it grows.

Self-test: python3 oversized-file-nudge.py --selftest
"""
from __future__ import annotations

import json
import os
import re
import sys

LIMIT = 1500
EXTENSIONS = (".py", ".ts", ".tsx", ".js", ".mjs")
# The same scope as scripts/ci/file_size_ratchet.json; a repo's own config replaces it when present.
EXCLUDE = (
    "**/tests/**", "**/test/**", "**/__tests__/**", "**/test_*.py", "**/*_test.py", "**/conftest.py",
    "**/*.test.*", "**/*.spec.*", "**/*selftest*", "**/*.generated.*", "**/*.gen.*", "**/generated/**",
    "**/*.min.js", "**/*.d.ts", "**/database.types.ts", "**/.next/**", "**/vendor/**",
    "**/node_modules/**", "**/third_party/**", "supabase/migrations/**", "baselines/**", "**/baselines/**",
)
CONFIG_REL = os.path.join("scripts", "ci", "file_size_ratchet.json")
# basename -> the ticket that tracks splitting it. Everything else gets "open a split ticket".
SPLIT_TICKETS = {"heading_research.py": "LC-1982"}
TOOLS = {"Write", "Edit", "MultiEdit"}

NOTE = ("[mod:oversized-file-nudge] {rel} is already {n} lines (limit {limit}). Strangler rule "
        "(CLAUDE.md section 3): extract the job you are touching into its own module instead of "
        "adding to this file. {ticket} The file-size-ratchet check in CI blocks a PR that grows it "
        "(a line `size-exception: LC-<n>` in the PR body is the logged escape hatch). Advisory only.")


def _glob_re(glob: str) -> re.Pattern:
    out, i = "", 0
    while i < len(glob):
        if glob.startswith("**/", i):
            out, i = out + "(?:.*/)?", i + 3
        elif glob.startswith("**", i):
            out, i = out + ".*", i + 2
        elif glob[i] == "*":
            out, i = out + "[^/]*", i + 1
        elif glob[i] == "?":
            out, i = out + "[^/]", i + 1
        else:
            out, i = out + re.escape(glob[i]), i + 1
    return re.compile("^" + out + "$")


def find_root(path: str) -> str | None:
    """The nearest ancestor holding the ratchet config, else the nearest git root, else None."""
    d = os.path.dirname(os.path.abspath(path))
    git_root = None
    while True:
        if os.path.isfile(os.path.join(d, CONFIG_REL)):
            return d
        if git_root is None and os.path.exists(os.path.join(d, ".git")):
            git_root = d
        parent = os.path.dirname(d)
        if parent == d:
            return git_root
        d = parent


def settings(root: str | None) -> tuple[int, tuple, tuple]:
    """(limit, extensions, exclude globs): the repo's config when readable, else the defaults."""
    if root:
        try:
            with open(os.path.join(root, CONFIG_REL), encoding="utf-8") as f:
                cfg = json.load(f)
            limit = cfg["limit"]
            exts = tuple(cfg["extensions"])
            globs = tuple(g for grp in cfg["exclude"] for g in grp["globs"])
            if isinstance(limit, int) and not isinstance(limit, bool) and limit > 0 and exts:
                return limit, exts, globs
        except (OSError, ValueError, KeyError, TypeError):
            pass  # a broken config falls back to the defaults: a reminder must not fail on it
    return LIMIT, EXTENSIONS, EXCLUDE


def line_count(path: str) -> int | None:
    try:
        with open(path, "rb") as f:
            data = f.read()
    except OSError:
        return None
    return _lines(data, b"\n")


def _lines(data, nl):
    """Lines in a str/bytes: newlines, plus one for an unterminated last line; empty is 0."""
    return 0 if not data else data.count(nl) + (0 if data.endswith(nl) else 1)


def _added_minus_removed(tool_name: str, tool_input: dict) -> int | None:
    """Net lines the call adds when that is knowable from the call alone, else None."""
    def n(s):
        return _lines(str(s) if s else "", "\n")
    if tool_name == "Edit":
        return n(tool_input.get("new_string")) - n(tool_input.get("old_string"))
    if tool_name == "MultiEdit":
        edits = tool_input.get("edits")
        if isinstance(edits, list) and edits and all(isinstance(e, dict) for e in edits):
            return sum(n(e.get("new_string")) - n(e.get("old_string")) for e in edits)
    return None  # Write replaces the file: compared with the current size by the caller


def evaluate(tool_name: str, tool_input: dict) -> str | None:
    """The note to add as context, or None to stay silent."""
    if tool_name not in TOOLS:
        return None
    path = str(tool_input.get("file_path") or "")  # "" ends with no extension, so it falls out below
    root = find_root(path)
    limit, exts, globs = settings(root)
    if not path.endswith(exts):
        return None
    rel = os.path.relpath(os.path.abspath(path), root) if root else os.path.basename(path)
    rel = rel.replace(os.sep, "/")
    if any(_glob_re(g).match(rel) for g in globs):
        return None
    current = line_count(path)
    if current is None or current <= limit:
        return None  # a new file, an unreadable one, or one within the limit
    if tool_name == "Write":
        new = tool_input.get("content")
        if isinstance(new, str) and _lines(new, "\n") < current:
            return None
    else:
        delta = _added_minus_removed(tool_name, tool_input)
        if delta is not None and delta < 0:
            return None
    ticket = SPLIT_TICKETS.get(os.path.basename(path))
    ticket_text = ("%s tracks splitting this file: extend that work instead of growing it." % ticket
                   if ticket else
                   "No split ticket is known for it: open one (Technical Infrastructure, Refs LC-1983) "
                   "before adding more here.")
    return NOTE.format(rel=rel, n=current, limit=limit, ticket=ticket_text)


def _selftest() -> int:
    import subprocess
    import tempfile
    checks = fails = 0

    def ck(cond, label):
        nonlocal checks, fails
        checks += 1
        if not cond:
            fails += 1
            sys.stderr.write("  FAIL: %s\n" % label)

    with tempfile.TemporaryDirectory() as td:
        os.makedirs(os.path.join(td, ".git"))

        def put(rel, n):
            p = os.path.join(td, rel)
            os.makedirs(os.path.dirname(p), exist_ok=True)
            with open(p, "w") as f:
                f.write("x = 1\n" * n)
            return p

        big = put("lib/big.py", LIMIT + 5)
        small = put("lib/small.py", LIMIT)
        hr = put("webflow/bulk-operations/heading-research/heading_research.py", LIMIT + 5)
        test_big = put("lib/tests/test_big.py", LIMIT + 5)
        vend = put("scripts/ci/vendor/v.py", LIMIT + 5)
        md = put("lib/notes.md", LIMIT + 5)
        tsx = put("ui/page.tsx", LIMIT + 5)

        g = evaluate("Edit", {"file_path": big, "old_string": "a", "new_string": "a\nb"})
        ck(g is not None and "[mod:oversized-file-nudge]" in g, "a growing edit to an over-limit file is nudged, with the prefix")
        ck(g is not None and "%d lines" % (LIMIT + 5) in g and "strangler" in g.lower(), "the note gives the size and the rule")
        ck(g is not None and "open one" in g and "LC-1982" not in g, "an unknown file is told to open a split ticket")
        g = evaluate("Edit", {"file_path": hr, "old_string": "a", "new_string": "a\nb"})
        ck(g is not None and "LC-1982" in g, "heading_research.py names LC-1982")
        ck(evaluate("Edit", {"file_path": big, "old_string": "a\nb\nc", "new_string": "a"}) is None, "a shrinking edit is silent")
        ck(evaluate("Edit", {"file_path": big, "old_string": "a", "new_string": "b"}) is not None, "a same-size edit is nudged")
        ck(evaluate("Edit", {"file_path": big}) is not None, "an edit with no strings is nudged (size unknown)")
        ck(evaluate("MultiEdit", {"file_path": big, "edits": [{"old_string": "a\nb", "new_string": "a"}]}) is None,
           "a shrinking MultiEdit is silent")
        ck(evaluate("MultiEdit", {"file_path": big, "edits": [{"old_string": "a", "new_string": "a\nb"}]}) is not None,
           "a growing MultiEdit is nudged")
        ck(evaluate("Write", {"file_path": big, "content": "x = 1\n" * (LIMIT + 50)}) is not None, "a Write that grows the file is nudged")
        ck(evaluate("Write", {"file_path": big, "content": "x = 1\n" * 10}) is None, "a Write that shrinks the file is silent")
        ck(evaluate("Edit", {"file_path": small, "old_string": "a", "new_string": "a\nb"}) is None, "a file at the limit is silent")
        ck(evaluate("Write", {"file_path": os.path.join(td, "lib/new.py"), "content": "x"}) is None, "a new file is silent")
        for label, p in (("test file", test_big), ("vendored file", vend), ("non-source file", md)):
            ck(evaluate("Edit", {"file_path": p, "old_string": "a", "new_string": "a\nb"}) is None, "%s is out of scope" % label)
        ck(evaluate("Edit", {"file_path": tsx, "old_string": "a", "new_string": "a\nb"}) is not None, ".tsx is in scope")
        ck(evaluate("Read", {"file_path": big}) is None, "Read is ignored")
        named = evaluate("Edit", {"file_path": big}) or ""
        ck("lib/big.py" in named, "the note names the file relative to the repo root")
        for label, tin in (("no edits", {}), ("edits not a list", {"edits": "x"}), ("empty edits", {"edits": []}),
                           ("edits of the wrong type", {"edits": ["x"]})):
            ck(evaluate("MultiEdit", dict(tin, file_path=big)) is not None, "MultiEdit with %s is nudged (size unknown)" % label)
        ck(evaluate("Write", {"file_path": big, "content": ""}) is None, "a Write that empties the file is silent")
        ck(evaluate("Write", {"file_path": big}) is not None, "a Write with no content is nudged")
        ck(_glob_re("a/**").match("a/b/c") and not _glob_re("a/**").match("b/a/c"), "glob: trailing ** spans dirs, anchored")
        ck(_glob_re("**/x.py").match("x.py") and _glob_re("**/x.py").match("a/b/x.py"), "glob: **/ spans zero or more dirs")
        ck(_glob_re("*.py").match("a.py") and not _glob_re("*.py").match("d/a.py"), "glob: * stays in one segment")
        ck(_glob_re("a?.py").match("ab.py") and not _glob_re("a?.py").match("a/.py"), "glob: ? is one non-slash char")
        ck(evaluate("Edit", {}) is None and evaluate("Edit", {"file_path": None}) is None, "a missing path does not crash")

        # a repo's own config (limit and scope) wins over the defaults
        cfgp = put("scripts/ci/file_size_ratchet.json", 0)
        with open(cfgp, "w") as f:
            json.dump({"limit": 10, "extensions": [".py"], "exclude": [{"reason": "r", "globs": ["lib/skip.py"]}]}, f)
        mid, skip = put("lib/mid.py", 20), put("lib/skip.py", 20)
        edit = {"old_string": "a", "new_string": "a\nb"}
        m = evaluate("Edit", dict(edit, file_path=mid))
        ck(m is not None and "(limit 10)" in m, "the repo config's limit is used")
        ck(evaluate("Edit", dict(edit, file_path=skip)) is None, "the repo config's exclusions are used")
        ck(evaluate("Edit", dict(edit, file_path=tsx)) is None, "the repo config's extensions are used")
        # a config in a sub-directory beats the git root above it
        sub = put("pkg/scripts/ci/file_size_ratchet.json", 0)
        with open(sub, "w") as f:
            json.dump({"limit": 7, "extensions": [".py"], "exclude": []}, f)
        deep = put("pkg/src/deep.py", 20)
        m = evaluate("Edit", dict(edit, file_path=deep))
        ck(m is not None and "(limit 7)" in m and "src/deep.py" in m and "pkg/src" not in m,
           "the nearest config's root wins over a git root above it")
        os.remove(sub)
        for label, bad in (("zero limit", {"limit": 0, "extensions": [".py"], "exclude": []}),
                           ("bool limit", {"limit": True, "extensions": [".py"], "exclude": []}),
                           ("no extensions", {"limit": 5, "extensions": [], "exclude": []})):
            with open(cfgp, "w") as f:
                json.dump(bad, f)
            ck(evaluate("Edit", dict(edit, file_path=mid)) is None and evaluate("Edit", dict(edit, file_path=big)) is not None,
               "a config with a %s falls back to the defaults" % label)
        with open(cfgp, "w") as f:
            f.write("{broken")
        ck(evaluate("Edit", dict(edit, file_path=mid)) is None and evaluate("Edit", dict(edit, file_path=big)) is not None,
           "a broken config falls back to the defaults")

        # no repo at all: no root, and the defaults apply
        with tempfile.TemporaryDirectory() as bare:
            loose = os.path.join(bare, "loose.py")
            with open(loose, "w") as f:
                f.write("x = 1\n" * (LIMIT + 5))
            ck(find_root(loose) is None, "outside any repo there is no root")
            ck("loose.py is already" in (evaluate("Edit", dict(edit, file_path=loose)) or ""), "outside a repo the defaults still nudge")

        # the hook's own entry point
        run = lambda s: subprocess.run([sys.executable, os.path.abspath(__file__)], input=s, capture_output=True, text=True)  # noqa: E731
        p = run(json.dumps({"tool_name": "Edit", "tool_input": dict(edit, file_path=big)}))
        out = json.loads(p.stdout) if p.stdout.strip() else {}
        h = out.get("hookSpecificOutput", {})
        ck(p.returncode == 0 and "[mod:oversized-file-nudge]" in h.get("additionalContext", ""), "main(): emits additionalContext")
        ck("permissionDecision" not in h and h.get("hookEventName") == "PreToolUse", "main(): never emits a deny or an ask")
        p = run(json.dumps({"tool_name": "Edit", "tool_input": dict(edit, file_path=small)}))
        ck(p.returncode == 0 and p.stdout == "", "main(): silent when nothing to say")
        p = run(json.dumps({"tool_name": "Write", "tool_input": None}))
        ck(p.returncode == 0 and p.stdout == "", "main(): null input is silent")
        p = run("{x")
        ck(p.returncode == 1 and p.stdout == "", "main(): junk fails open and visible")
        p = subprocess.run([sys.executable, os.path.abspath(__file__), "--bogus"], input="{}", capture_output=True, text=True)
        ck(p.returncode == 2 and p.stdout == "" and "unknown arguments" in p.stderr, "main(): an unknown argument is refused, not run as a hook")

    print("oversized-file-nudge selftest: %d/%d checks passed" % (checks - fails, checks))
    return 1 if fails else 0


def main() -> int:
    if "--selftest" in sys.argv:
        return _selftest()
    if len(sys.argv) > 1:
        # The mod runs this hook with no arguments, payload on stdin (py.ts runArgs). Refusing any
        # other argument makes a broken --selftest dispatch fail the selftest run loudly, instead of
        # the run being read as a silent hook call that exits 0 (LC-2016: the floor's main|guard-off).
        sys.stderr.write("oversized-file-nudge: unknown arguments %r; the hook takes its payload on stdin.\n" % sys.argv[1:])
        return 2
    try:
        raw = sys.stdin.read()
        payload = json.loads(raw) if raw.strip() else {}
        tool_input = payload.get("tool_input") or {}
        note = evaluate(payload.get("tool_name") or "", tool_input if isinstance(tool_input, dict) else {})
    except Exception as e:  # noqa: BLE001
        sys.stderr.write("oversized-file-nudge: could not evaluate (%s); allowing the call.\n" % e)
        return 1
    if note:
        json.dump({"hookSpecificOutput": {"hookEventName": "PreToolUse", "additionalContext": note}}, sys.stdout)
        sys.stdout.write("\n")
    return 0


# Equivalent mutant, waived (LC-1983): with the __main__ guard off the selftest prints nothing and
# exits 0; CI reads the count line, which kills it. The floor waiver names LC-1983 and points here.
if __name__ == "__main__":
    raise SystemExit(main())
