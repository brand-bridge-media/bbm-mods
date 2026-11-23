#!/usr/bin/env python3
"""t2-evidence-fill: answer ONE question: "does the T2 PR this session is opening carry its Evidence, filled?" (LC-2156).

WHY. LC-2153 gives every T2 pull request (money and config) a `## Evidence` section, so the operator's bbm-approver
approval is given from proof instead of from reading a diff. Its step 3 says the section must cost the operator no
time: the session that opens the PR fills it. This helper is the session side. It never decides what counts as
evidence: the slots are data (`scripts/ci/t2_evidence.json`) and the judge is `scripts/ci/t2_evidence.py`, both read
from the session's own checkout, so a slot added there is picked up here with no change.

    business analogy: the office assistant who staples the blank receipt form to every expense report before it goes
    to finance, writes in the numbers they already have, and hands it back if a line is still empty.

Two modes, JSON on stdin, JSON on stdout (the mod's register.ts is the only caller):

  {"mode": "capture", "command": "...", "output": "..."}
      A Bash command the session just ran successfully. If it was a test run (selftest, mutate.py, preflight,
      pytest, `claude plugin test`), returns {"entry": {"source": "...", "line": "..."}}: the last line of its output
      that carries a result count, normalised so a count reads number-first ("killed 31" -> "31 killed",
      "cases=12" -> "12 cases"), which is the shape the judge's `counts` rule accepts. Else {}.

  {"mode": "fill", "owner", "repo", "head", "body", "ready", "counts": [{"source","line"}...], "cwd"}
      A PR about to be created or edited. Finds the session's checkout of owner/repo that carries
      scripts/ci/t2_evidence.py (none: {"applicable": false}, so every other repo is left alone). Computes the tier
      of `head` against origin/main with scripts/ci/tier_label.py (the same rules that write the tier label). A
      tier other than T2 is left alone. For T2 (or an unreadable tier: proof is asked for, never a pass):
        1. inserts `t2_evidence.py template` when the body has no Evidence section (after "What this PR does");
        2. writes the captured test counts into the empty `counts` slot (Tests), never over the session's own text;
        3. runs `t2_evidence.py body --file` on the result and returns its gaps.
      Returns {"applicable": true, "tier", "body", "changed": [...], "result", "missing": [[label, why, how]],
      "deny": bool}. `deny` is true only when the call would make a CONFIRMED T2 PR ready for review while a slot is
      still empty: the ticket's "fill the slot before the PR leaves draft". A draft is filled and told, never stopped.

Fails open: any error, timeout or unreadable file returns {"applicable": false, "why": ...} and the call goes ahead
exactly as the session wrote it. `n/a: <reason>` always satisfies a slot, so a deny can never trap a session.

Usage: python3 t2-evidence-fill.py < payload.json      python3 t2-evidence-fill.py --selftest
Stdlib only.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import tempfile

T2 = "tier:T2"
EVIDENCE_SCRIPT = "scripts/ci/t2_evidence.py"
EVIDENCE_CONFIG = "scripts/ci/t2_evidence.json"
TIER_SCRIPT = "scripts/ci/tier_label.py"
STEP_TIMEOUT = 15

# A test run whose counts are worth keeping. Matched on the command the session typed.
TEST_CMD = re.compile(r"--selftest|\bselftest\b|mutate\.py|preflight|\bpytest\b|plugin\s+test|\bunittest\b|"
                      r"\b(?:npm|pnpm|yarn|deno|node)\s+(?:run\s+)?test\b", re.I)
# Result words a count can be attached to (the judge's `counts` rule accepts number-first: "31 killed", "12 passed").
WORDS = (r"killed|survived|no-op|import-error|syntax-error|runner-error|passed|failed|pass|fail|block|ok|cases|checks|"
         r"tests|errors|skipped|mutants|assertions")
WORD_FIRST = re.compile(r"\b(" + WORDS + r")(?:\s*=\s*|\s+)(\d+)\b", re.I)
COUNT = re.compile(r"\d+\s*/\s*\d+|\b\d+\s+(?:" + WORDS + r"|failures?|tests?|cases?|checks?)\b", re.I)
SOURCE = re.compile(r"[\w./~-]+\.(?:py|sh|mjs|ts|js)\b")
PLACEHOLDER = re.compile(r"^\s*(?:todo|tbd|tba|fill(?: in| me)?|\.{2,}|…|-+|<[^>:/=]*>|x+)?\s*\.?\s*$", re.I)
FOOTER = re.compile(r"^\s*🤖 Generated with")
MAX_LINE = 200
MAX_COUNTS = 4


# ---- capture -----------------------------------------------------------------------------------------------------------

def normalise(line: str) -> str:
    """'killed 31 · survived 0' -> '31 killed · 0 survived'; 'cases=12' -> '12 cases'. Number-first already: unchanged."""
    return WORD_FIRST.sub(lambda m: f"{m.group(2)} {m.group(1)}", line)


def source_of(command: str) -> str:
    """A short name for the test run: the script it ran (plus --selftest), the mod `claude plugin test` ran, or the
    command's first 40 characters."""
    m = re.search(r"plugin\s+test\s+(\S+)", command)
    if m:
        return "claude plugin test " + m.group(1).rstrip("/").split("/")[-1]
    names = [s for s in SOURCE.findall(command) if not s.endswith("python3")]
    if names:
        name = names[0].split("/")[-1]
        return name + (" --selftest" if "--selftest" in command else "")
    return command.strip()[:40]


def capture(command: str, output: str) -> dict:
    if not TEST_CMD.search(command or ""):
        return {}
    for raw in reversed((output or "").splitlines()):
        line = normalise(raw.strip())
        if line and COUNT.search(line):
            return {"entry": {"source": source_of(command), "line": line[:MAX_LINE]}}
    return {}


def bind(entry: dict, command: str, cwd: str | None = None, run=None) -> dict:
    """LC-2310: stamp a captured run with where it ran: the branch ("" when HEAD is detached, as in a worktree), the HEAD
    sha and whether the tree had uncommitted changes. Where: a leading `cd <dir> &&` of the command, else `cwd` (the
    session's, from the hook), else the helper's own. The sha unreadable: the entry stays unstamped, and an unstamped run
    is never written into a PR body (it is reported as skipped)."""
    run = run or _run
    m = re.match(r"\s*cd\s+(\"[^\"]+\"|'[^']+'|\S+)\s*(?:&&|;)", command or "")
    where = m.group(1).strip("\"'") if m else (cwd or os.getcwd())
    rc, branch = run(["git", "-C", where, "rev-parse", "--abbrev-ref", "HEAD"])
    rc2, sha = run(["git", "-C", where, "rev-parse", "HEAD"])
    sha = sha.strip()
    if rc2 != 0 or not sha:
        return entry
    branch = branch.strip() if rc == 0 and branch.strip() != "HEAD" else ""
    rc3, dirty = run(["git", "-C", where, "status", "--porcelain", "--untracked-files=no"])
    return {**entry, "branch": branch, "sha": sha, "dirty": rc3 == 0 and bool(dirty.strip())}


# ---- fill: pure parts --------------------------------------------------------------------------------------------------

def _strip_comments(text: str) -> str:
    return re.sub(r"<!--.*?(?:-->|\Z)", "", text, flags=re.S)


def _heading_re(heading: str) -> re.Pattern:
    return re.compile(r"^(#{2,3})\s+" + re.escape(heading) + r"\s*:?\s*#*\s*$", re.I)


def has_section(body: str, heading: str) -> bool:
    pat = _heading_re(heading)
    return any(pat.match(ln) for ln in _strip_comments(body).splitlines())


def insert_section(body: str, block: str) -> str:
    """The Evidence block goes right after the 'What this PR does' (or 'Summary') section, where the PR template puts it;
    without one, before the 'Generated with' footer; else at the end."""
    lines = (body or "").splitlines()
    blk = block.rstrip("\n").splitlines()
    anchor = re.compile(r"^##\s+(?:what this pr does|summary)\b", re.I)
    at = None
    for i, ln in enumerate(lines):
        if anchor.match(ln):
            at = next((j for j in range(i + 1, len(lines)) if re.match(r"^#{1,2}\s", lines[j])), len(lines))
            break
    if at is None:
        at = next((j for j in range(len(lines)) if FOOTER.match(lines[j])), len(lines))
    before, after = lines[:at], lines[at:]
    while before and not before[-1].strip():
        before.pop()
    out = before + ([""] if before else []) + blk + ([""] if after else []) + after
    return "\n".join(out) + "\n"


def fill_slot(body: str, heading: str, label: str, text: str) -> tuple[str, bool]:
    """Write `text` into the `- **label:**` bullet of the Evidence section when, and only when, it is empty (or a
    placeholder such as TODO) and nothing follows it before the next bullet. Never overwrites the session's own words."""
    lines = body.splitlines()
    head = _heading_re(heading)
    bullet = re.compile(r"^\s*[-*]\s*(?:\*\*|__)?\s*" + re.escape(label) + r"\s*:?\s*(?:\*\*|__)?\s*:?\s*(.*)$", re.I)
    start = next((i for i, ln in enumerate(lines) if head.match(ln)), None)
    if start is None:
        return body, False
    level = len(head.match(lines[start]).group(1))
    for i in range(start + 1, len(lines)):
        m = re.match(r"^(#{1,6})\s", lines[i])
        if m and len(m.group(1)) <= level:
            break
        b = bullet.match(lines[i])
        if not b:
            continue
        if not PLACEHOLDER.match(b.group(1)):
            return body, False
        rest = []
        for ln in lines[i + 1:]:
            if re.match(r"^\s*[-*]\s", ln) or re.match(r"^#{1,6}\s", ln):
                break
            rest.append(ln)
        if _strip_comments("\n".join(rest)).strip():
            return body, False  # the value runs on below the bullet: the session wrote it
        lines[i] = f"- **{label}:** {text}"
        return "\n".join(lines) + ("\n" if body.endswith("\n") else ""), True
    return body, False


def counts_text(counts: list) -> str:
    """'source: line; source: line' from the newest captured runs (the caller passes them newest last)."""
    seen, out = set(), []
    for c in reversed(counts or []):
        if not isinstance(c, dict):
            continue
        src, line = str(c.get("source") or "").strip(), str(c.get("line") or "").strip()
        if not line or src in seen:
            continue
        seen.add(src)
        if c.get("at_head") is False or c.get("dirty"):
            line += f" [run at {str(c.get('sha') or '')[:7]}{', tree dirty' if c.get('dirty') else ''}]"
        out.append(f"{src}: {line}" if src else line)
        if len(out) == MAX_COUNTS:
            break
    return "; ".join(reversed(out))


def parse_judge(output: str) -> tuple[str, list]:
    """(RESULT word, [[label, why, how]]) from `t2_evidence.py body` output."""
    result = "NOT CHECKED"
    m = re.findall(r"^RESULT=(PASS|BLOCK|NOT CHECKED)\b", output or "", re.M)
    if m:
        result = m[-1]
    missing = []
    for ln in (output or "").splitlines():
        g = re.match(r"^\s+-\s+(.+?):\s+(.*?)\.\s+How:\s*(.*)$", ln)
        if g:
            missing.append([g.group(1), g.group(2), g.group(3)])
    return result, missing


def tier_from_receipt(output: str) -> str | None:
    m = re.search(r"^RESULT=PASS label=(tier:\S+)", output or "", re.M)
    return m.group(1) if m else None


def same_repo(url: str, owner: str, repo: str) -> bool:
    u = (url or "").strip().lower().rstrip("/")
    u = u[:-4] if u.endswith(".git") else u
    want = f"{owner}/{repo}".lower()
    return bool(owner and repo) and (u.endswith("/" + want) or u.endswith(":" + want))


# ---- fill: I/O ---------------------------------------------------------------------------------------------------------

def _run(argv: list, cwd: str | None = None, stdin: str | None = None) -> tuple[int, str]:
    try:
        r = subprocess.run(argv, cwd=cwd, input=stdin, capture_output=True, text=True, timeout=STEP_TIMEOUT)
        return r.returncode, r.stdout
    except (OSError, subprocess.SubprocessError):
        return 127, ""


def find_checkout(owner: str, repo: str, cwd: str | None, run=_run) -> str | None:
    """The session's clone of owner/repo that carries the evidence script, or None."""
    cands = []  # an empty owner or repo never matches: same_repo refuses it
    for d in (cwd, os.getcwd()):
        if d:
            rc, out = run(["git", "-C", d, "rev-parse", "--show-toplevel"])
            if rc == 0 and out.strip():
                cands.append(out.strip())
    home = os.environ.get("HOME") or ""
    cands += [os.path.join(p, repo) for p in (home, "/home/user", "/home/claude") if p]
    for top in dict.fromkeys(cands):
        if not os.path.isfile(os.path.join(top, EVIDENCE_SCRIPT)):
            continue
        rc, url = run(["git", "-C", top, "remote", "get-url", "origin"])
        if rc == 0 and same_repo(url, owner, repo):
            return top
    return None


def tier_of(top: str, head: str, run=_run) -> str | None:
    """tier_label.py's answer for the files `head` changes against origin/main, or None when it cannot be read."""
    branch = (head or "").split(":", 1)[-1].strip()
    if not branch or not os.path.isfile(os.path.join(top, TIER_SCRIPT)):
        return None
    for ref in (branch, f"origin/{branch}"):
        rc, _ = run(["git", "-C", top, "rev-parse", "--verify", "--quiet", ref])
        if rc != 0:
            continue
        rc, files = run(["git", "-C", top, "diff", "--name-only", "--no-renames", f"origin/main...{ref}"])
        if rc != 0 or not files.strip():
            return None
        rc, out = run(["python3", "-I", os.path.join(top, TIER_SCRIPT), "files"], cwd=top, stdin=files)
        return tier_from_receipt(out) if rc == 0 else None
    return None


def head_sha(top: str, head: str, run=_run) -> str | None:
    branch = (head or "").split(":", 1)[-1].strip()
    for ref in (branch, f"origin/{branch}"):
        if not branch:
            return None
        rc, out = run(["git", "-C", top, "rev-parse", "--verify", "--quiet", ref])
        if rc == 0 and out.strip():
            return out.strip()
    return None


def classify_counts(counts: list, head: str, sha: str | None, ancestor) -> tuple[list, list]:
    """LC-2310: (kept, skipped reasons). A run is the PR's own when it ran on the PR's head branch (or on no known branch:
    a worktree, a detached HEAD) AND its commit is the PR head or an ancestor of it (test, then commit, is the normal
    order, so the stamp is usually one commit behind; dirty or clean). A run on another branch, on a commit outside the
    head's history, or without a stamp is dropped with the reason, so the Tests slot stays empty (NOT CHECKED) and the
    session says why, never someone else's results in what the operator approves from."""
    branch = (head or "").split(":", 1)[-1].strip()
    kept, skipped = [], []
    for c in counts or []:
        if not isinstance(c, dict):
            continue
        name = str(c.get("source") or "a test run")
        csha, cbranch = str(c.get("sha") or ""), str(c.get("branch") or "")
        if not csha:
            skipped.append(f"{name}: unstamped (no branch or commit recorded)")
        elif cbranch and cbranch != branch:
            skipped.append(f"{name}: ran on branch {cbranch}, not {branch or 'this PR head'}")
        elif not sha:
            skipped.append(f"{name}: the PR head commit could not be read")
        elif csha == sha or ancestor(csha):
            kept.append({**c, "at_head": csha == sha})
        else:
            skipped.append(f"{name}: ran at {csha[:7]}, which is not in the PR head's history")
    return kept, skipped


def is_ancestor(top: str, commit: str, sha: str, run=_run) -> bool:
    rc, _ = run(["git", "-C", top, "merge-base", "--is-ancestor", commit, sha])
    return rc == 0


def fill(p: dict, run=_run) -> dict:
    owner, repo = str(p.get("owner") or ""), str(p.get("repo") or "")
    top = find_checkout(owner, repo, p.get("cwd"), run)
    if not top:
        return {"applicable": False, "why": f"no checkout of {owner}/{repo} with {EVIDENCE_SCRIPT}"}
    try:
        with open(os.path.join(top, EVIDENCE_CONFIG), encoding="utf-8") as fh:
            cfg = json.load(fh)
        heading = str(cfg["heading"])
        counts_label = next((s["label"] for s in cfg["slots"] if s.get("rule") == "counts"), None)
    except (OSError, ValueError, KeyError, TypeError) as e:
        return {"applicable": False, "why": f"evidence config unreadable: {e}"}
    tier = tier_of(top, str(p.get("head") or ""), run)
    if tier is not None and tier != T2:
        return {"applicable": False, "why": f"{tier}: no Evidence section is asked for"}
    script = os.path.join(top, EVIDENCE_SCRIPT)
    body = p.get("body") if isinstance(p.get("body"), str) else ""
    changed = []
    if not has_section(body, heading):
        rc, block = run(["python3", "-I", script, "template"], cwd=top)
        if rc != 0 or not block.strip():
            return {"applicable": False, "why": "t2_evidence.py template gave nothing"}
        body = insert_section(body, block)
        changed.append(f"added the `## {heading}` section")
    hsha = head_sha(top, str(p.get("head") or ""), run)
    kept, skipped = classify_counts(p.get("counts") or [], str(p.get("head") or ""), hsha,
                                    lambda c: bool(hsha) and is_ancestor(top, c, hsha, run))
    text = counts_text(kept)
    if counts_label and text:
        body, did = fill_slot(body, heading, counts_label, text)
        if did:
            changed.append(f"filled {counts_label} from this session's test runs ({text})")
    fd, path = tempfile.mkstemp(prefix="t2-evidence-", suffix=".md")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(body)
        rc, out = run(["python3", "-I", script, "body", "--file", path], cwd=top)
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass
    result, missing = parse_judge(out)
    deny = bool(p.get("ready")) and tier == T2 and result == "BLOCK" and bool(missing)
    return {"applicable": True, "tier": tier or "unreadable (treated as T2)", "body": body, "changed": changed,
            "result": result, "missing": missing, "deny": deny, "skipped": skipped}


def main_io(stdin: str) -> dict:
    try:
        p = json.loads(stdin or "{}")
        if not isinstance(p, dict):
            return {}
        if p.get("mode") == "capture":
            got = capture(str(p.get("command") or ""), str(p.get("output") or ""))
            if got.get("entry"):
                got = {"entry": bind(got["entry"], str(p.get("command") or ""), p.get("cwd"))}
            return got
        if p.get("mode") == "fill":
            return fill(p)
    except Exception as e:  # noqa: BLE001  fail open: the mod lets the call through unchanged
        return {"applicable": False, "why": f"helper error: {type(e).__name__}: {e}"[:200]}
    return {}


# ---- selftest ----------------------------------------------------------------------------------------------------------

# A stand-in for scripts/ci/t2_evidence.py with the same CLI (template, body --file) so the selftest is hermetic.
# The real script is exercised too when this file sits in a checkout that has it (see `real` below).
FAKE_EVIDENCE = r'''
import json, os, re, sys
cfg = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "t2_evidence.json")))
if sys.argv[1] == "template":
    print("## " + cfg["heading"] + "\n\n<!-- guidance -->\n\n" + "\n".join("- **%s:** " % s["label"] for s in cfg["slots"]))
    sys.exit(0)
body = open(sys.argv[3]).read()
miss = []
for s in cfg["slots"]:
    m = re.search(r"^- \*\*" + re.escape(s["label"]) + r":\*\* *(.*)$", body, re.M)
    if not m or not m.group(1).strip():
        miss.append(s["label"])
for lab in miss:
    print("  - %s: empty. How: fill it" % lab)
print("RESULT=%s tier=tier:T2 why=x" % ("BLOCK" if miss else "PASS"))
sys.exit(1 if miss else 0)
'''
FAKE_TIER = 'import sys, os\nsys.stdin.read()\nprint("RESULT=PASS label=" + os.environ.get("FAKE_TIER", "tier:T2") + " files=1 why=x")\n'
CONFIG = {"heading": "Evidence", "slots": [{"label": "What it does", "rule": "text"}, {"label": "Tests", "rule": "counts"},
                                           {"label": "Screenshot", "rule": "image"}]}


def selftest() -> int:
    results: list[tuple[str, bool]] = []

    def check(name: str, got, want) -> None:
        ok = got == want
        results.append((name, ok))
        if not ok:
            print(f"  FAIL {name}: got {got!r}, want {want!r}")

    # capture
    check("mutate line normalised", capture("python3 -I scripts/delegation/mutate.py x.py",
                                             "noise\nkilled 31 · survived 0 · no-op 2\n")["entry"],
          {"source": "mutate.py", "line": "31 killed · 0 survived · 2 no-op"})
    check("selftest key=value normalised", capture("python3 scripts/ci/foo.py --selftest", "SELFTEST_RESULT=PASS cases=12"),
          {"entry": {"source": "foo.py --selftest", "line": "SELFTEST_RESULT=PASS 12 cases"}})
    check("last count line wins", capture("bash scripts/ci/preflight.sh", "3 passed\npreflight: 5 passed, 0 failed\nbye"),
          {"entry": {"source": "preflight.sh", "line": "preflight: 5 passed, 0 failed"}})
    check("fraction kept", capture("python3 t.py --selftest", "selftest: 9/9 checks passed")["entry"]["line"],
          "selftest: 9/9 checks passed")
    check("plugin test source", capture("claude plugin test claude-mods/ci-preflight/", "✓ 40 passed")["entry"]["source"],
          "claude plugin test ci-preflight")
    check("not a test command", capture("git log --oneline -3", "12 passed"), {})
    check("no count in output", capture("python3 x.py --selftest", "SELFTEST PASS"), {})
    check("stray number is not a count", capture("python3 x.py --selftest", "phase 2 done"), {})
    check("source fallback", source_of("pytest -q"), "pytest -q")

    # pure fill parts
    check("section found", has_section("x\n## Evidence\n- a", "Evidence"), True)
    check("section in a comment is not a section", has_section("<!--\n## Evidence\n-->", "Evidence"), False)
    check("### heading counts", has_section("### evidence:", "Evidence"), True)
    ins = insert_section("## What this PR does\n\nStuff.\n\n## Refs\n- r\n", "## Evidence\n- **T:** \n")
    check("inserted after What this PR does", ins, "## What this PR does\n\nStuff.\n\n## Evidence\n- **T:** \n\n## Refs\n- r\n")
    check("inserted before footer", insert_section("Body\n\n🤖 Generated with x\n", "## Evidence\n"),
          "Body\n\n## Evidence\n\n🤖 Generated with x\n")
    check("appended", insert_section("Body", "## Evidence\n"), "Body\n\n## Evidence\n")
    check("empty body", insert_section("", "## Evidence\n"), "## Evidence\n")
    b = "## Evidence\n\n- **What it does:** x\n- **Tests:** \n- **Screenshot:** n/a: none\n"
    check("empty slot filled", fill_slot(b, "Evidence", "Tests", "a.py: 3 passed"),
          ("## Evidence\n\n- **What it does:** x\n- **Tests:** a.py: 3 passed\n- **Screenshot:** n/a: none\n", True))
    check("TODO slot filled", fill_slot("## Evidence\n- **Tests:** TODO\n", "Evidence", "Tests", "9 passed")[1], True)
    check("own text kept", fill_slot("## Evidence\n- **Tests:** 4/4 PASS\n", "Evidence", "Tests", "9 passed")[1], False)
    check("run-on value kept", fill_slot("## Evidence\n- **Tests:**\n  see 4/4 below\n- **X:** y\n", "Evidence", "Tests", "9")[1],
          False)
    check("comment below is not a value", fill_slot("## Evidence\n- **Tests:**\n<!-- hint -->\n", "Evidence", "Tests", "9")[1],
          True)
    check("slot outside section untouched", fill_slot("## Evidence\n- **A:** a\n## Other\n- **Tests:** \n", "Evidence", "Tests",
                                                      "9")[1], False)
    check("no section, nothing filled", fill_slot("- **Tests:** \n", "Evidence", "Tests", "9")[1], False)
    check("counts newest, deduped, capped", counts_text(
        [{"source": "a", "line": "1 passed"}, {"source": "b", "line": "2 passed"}, {"source": "a", "line": "3 passed"},
         {"source": "c", "line": "4 passed"}, {"source": "d", "line": "5 passed"}, {"source": "e", "line": "6 passed"}]),
        "a: 3 passed; c: 4 passed; d: 5 passed; e: 6 passed")
    check("counts junk skipped", counts_text([None, {"source": "a"}, {"line": "7 ok"}]), "7 ok")
    check("judge parsed", parse_judge("  - Tests: empty. How: paste it. e.g. 4/4\nRESULT=BLOCK tier=tier:T2 why=x"),
          ("BLOCK", [["Tests", "empty", "paste it. e.g. 4/4"]]))
    check("judge silent is NOT CHECKED", parse_judge(""), ("NOT CHECKED", []))
    check("tier receipt", tier_from_receipt("x\nRESULT=PASS label=tier:T1 files=2 why=y"), "tier:T1")
    check("tier NOT CHECKED", tier_from_receipt("RESULT=NOT CHECKED label= why=y"), None)
    check("repo https", same_repo("https://github.com/brand-bridge-media/bbm-infrastructure.git\n", "brand-bridge-media",
                                  "bbm-infrastructure"), True)
    check("repo proxy", same_repo("http://p@127.0.0.1:1/git/Brand-Bridge-Media/bbm-infrastructure", "brand-bridge-media",
                                  "bbm-infrastructure"), True)
    check("repo ssh", same_repo("git@github.com:brand-bridge-media/bbm-infrastructure", "brand-bridge-media",
                                "bbm-infrastructure"), True)
    check("other repo", same_repo("https://github.com/x/bbm-infrastructure-old", "x", "bbm-infrastructure"), False)
    check("suffix is not the repo", same_repo("https://github.com/y/xbbm-infrastructure", "y", "bbm-infrastructure"), False)

    # end to end, in a throwaway git repo with stand-in scripts
    with tempfile.TemporaryDirectory() as tmp:
        origin, top = os.path.join(tmp, "origin.git"), os.path.join(tmp, "bbm-infrastructure")
        # Hermetic git: no global or system config (commit signing, hooks, templates), fixed identity. The mutation
        # harness runs this from a scratch tree whose environment differs from a session's.
        env = {**os.environ, "GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1", "GIT_AUTHOR_NAME": "t",
               "GIT_AUTHOR_EMAIL": "t@t", "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@t"}
        g = lambda *a: subprocess.run(["git", *a], cwd=top, capture_output=True, text=True, check=True, env=env)  # noqa: E731
        subprocess.run(["git", "init", "-q", "--bare", origin], check=True, capture_output=True, env=env)
        os.makedirs(os.path.join(top, "scripts/ci"))
        g_init = subprocess.run(["git", "init", "-q", "-b", "main"], cwd=top, capture_output=True, env=env)
        results.append(("git init", g_init.returncode == 0))
        for rel, text in ((EVIDENCE_SCRIPT, FAKE_EVIDENCE), (TIER_SCRIPT, FAKE_TIER),
                          (EVIDENCE_CONFIG, json.dumps(CONFIG))):
            with open(os.path.join(top, rel), "w", encoding="utf-8") as fh:
                fh.write(text)
        g("add", ".")
        g("commit", "-qm", "base")
        g("remote", "add", "origin", origin)
        g("push", "-q", "origin", "main")
        g("fetch", "-q", "origin")
        g("checkout", "-qb", "lc1-x")
        with open(os.path.join(top, "a.sql"), "w") as fh:
            fh.write("x")
        g("add", ".")
        g("commit", "-qm", "change")
        g("remote", "set-url", "origin", "https://github.com/o/bbm-infrastructure.git")
        sha = g("rev-parse", "HEAD").stdout.strip()
        base = {"mode": "fill", "owner": "o", "repo": "bbm-infrastructure", "head": "o:lc1-x", "cwd": top,
                "counts": [{"source": "mutate.py", "line": "31 killed", "branch": "lc1-x", "sha": sha}]}

        r = fill({**base, "body": "## What this PR does\n\nMoves a cron.\n\n## Refs\n- LC-1\n", "ready": False})
        check("e2e T2 draft: applicable", r.get("applicable"), True)
        check("e2e T2 draft: section added and Tests filled", r.get("changed", [""])[0].startswith("added"), True)
        check("e2e T2 draft: both changes reported", [c.split(" ")[0] for c in r.get("changed", [])], ["added", "filled"])
        check("e2e T2 draft: Tests text", "- **Tests:** mutate.py: 31 killed" in r.get("body", ""), True)
        check("e2e T2 draft: gaps listed", [m[0] for m in r.get("missing", [])], ["What it does", "Screenshot"])
        check("e2e T2 draft: not denied", r.get("deny"), False)
        # LC-2310: results of another PR / a commit outside the head's history / an unstamped run never reach the Tests slot,
        # and each drop says why. A run one commit behind the head (test, then commit), dirty or clean, still counts.
        pr_body = "## What this PR does\n\nx\n\n## Evidence\n\n- **Tests:** \n"
        parent = g("rev-parse", "HEAD~1").stdout.strip()
        for why, c, reason in (("another branch", {"branch": "lc2-y", "sha": sha}, "ran on branch lc2-y"),
                               ("a commit outside the history", {"branch": "lc1-x", "sha": "0" * 40}, "not in the PR head's history"),
                               ("another branch, ancestor sha", {"branch": "lc2-y", "sha": parent}, "ran on branch lc2-y"),
                               ("unrelated sha, no branch", {"branch": "", "sha": "1" * 40}, "not in the PR head's history"),
                               ("no stamp", {}, "unstamped")):
            r = fill({**base, "body": pr_body, "ready": False, "counts": [{"source": "x.py", "line": "5 passed", **c}]})
            check(f"e2e LC-2310 {why}: results not written", "5 passed" in r.get("body", ""), False)
            check(f"e2e LC-2310 {why}: Tests left for the session", [m[0] for m in r.get("missing", [])].count("Tests"), 1)
            check(f"e2e LC-2310 {why}: reason given", [reason in x for x in r.get("skipped", [])], [True])
        r = fill({**base, "body": pr_body, "ready": False})
        check("e2e LC-2310 own run on this branch and sha: filled", "- **Tests:** mutate.py: 31 killed" in r.get("body", ""), True)
        check("e2e LC-2310 own run: nothing skipped", r.get("skipped"), [])
        for why, c, tail in (("one commit behind, clean", {"branch": "lc1-x", "sha": parent, "dirty": False}, f"[run at {parent[:7]}]"),
                             ("one commit behind, dirty", {"branch": "lc1-x", "sha": parent, "dirty": True}, f"[run at {parent[:7]}, tree dirty]"),
                             ("detached HEAD at an ancestor", {"branch": "", "sha": parent}, f"[run at {parent[:7]}]"),
                             ("detached HEAD at the head", {"branch": "", "sha": sha}, "5 passed")):
            r = fill({**base, "body": pr_body, "ready": False, "counts": [{"source": "x.py", "line": "5 passed", **c}]})
            check(f"e2e LC-2310 {why}: filled", f"- **Tests:** x.py: 5 passed" in r.get("body", "") and tail in r.get("body", ""), True)
            check(f"e2e LC-2310 {why}: nothing skipped", r.get("skipped"), [])
        check("bind: stamped with branch, sha, clean", bind({"source": "s", "line": "1 passed"}, "pytest", top),
              {"source": "s", "line": "1 passed", "branch": "lc1-x", "sha": sha, "dirty": False})
        with open(os.path.join(top, "a.sql"), "w") as fh:
            fh.write("changed")
        check("bind: uncommitted change is recorded", bind({"s": 1}, "pytest", top).get("dirty"), True)
        check("bind: a detached HEAD keeps the sha, no branch", (lambda b: (b.get("branch"), b.get("sha")))(
            bind({"s": 1}, "x", "/x", lambda a, cwd=None, stdin=None: (0, "HEAD") if "--abbrev-ref" in a else (0, "abc"))),
            ("", "abc"))
        check("bind: cd prefix picks the checkout", bind({"source": "s"}, f"cd {top} && pytest", "/nonexistent").get("sha"), sha)
        check("bind: no checkout, no stamp", bind({"source": "s"}, "pytest", tmp), {"source": "s"})
        check("bind: failed sha not stamped", bind({"s": 1}, "x", "/x", lambda a, cwd=None, stdin=None:
                                                   (0, "b") if "--abbrev-ref" in a else (1, "s")), {"s": 1})
        check("bind: empty sha not stamped", bind({"s": 1}, "x", "/x", lambda a, cwd=None, stdin=None:
                                                  (0, "b") if "--abbrev-ref" in a else (0, " ")), {"s": 1})
        # classify_counts, unit level
        st = {"source": "a", "branch": "b", "sha": "s1"}
        kc = lambda cs, head="b", hs="s1", anc=lambda c: False: classify_counts(cs, head, hs, anc)  # noqa: E731
        check("classify: same sha kept", kc([st])[0], [{**st, "at_head": True}])
        check("classify: ancestor kept, flagged behind", kc([{**st, "sha": "s0"}], anc=lambda c: c == "s0")[0],
              [{**st, "sha": "s0", "at_head": False}])
        check("classify: non-ancestor dropped with reason", kc([{**st, "sha": "s0"}])[1],
              ["a: ran at s0, which is not in the PR head's history"])
        check("classify: other branch dropped even at the head sha", kc([{**st, "branch": "c"}]),
              ([], ["a: ran on branch c, not b"]))
        check("classify: unknown branch matches on sha", kc([{**st, "branch": ""}])[0], [{**st, "branch": "", "at_head": True}])
        check("classify: unstamped dropped", kc([{"source": "a"}]), ([], ["a: unstamped (no branch or commit recorded)"]))
        check("classify: unreadable head commit keeps nothing", kc([st], hs=None),
              ([], ["a: the PR head commit could not be read"]))
        check("classify: owner prefix on the head", kc([st], head="o:b")[0], [{**st, "at_head": True}])
        check("classify: junk skipped silently", kc([None, "x", st])[0], [{**st, "at_head": True}])
        check("classify: unnamed run still named", kc([{"sha": "s1", "branch": "z"}])[1], ["a test run: ran on branch z, not b"])
        sh = lambda out: (lambda argv, cwd=None, stdin=None: out)  # noqa: E731
        check("head_sha: empty head", head_sha("/x", "", sh((0, "abc"))), None)
        check("head_sha: empty output is not a sha", head_sha("/x", "b", sh((0, " \n"))), None)
        check("head_sha: found", head_sha("/x", "o:b", sh((0, "abc\n"))), "abc")
        check("head_sha: failing rev-parse", head_sha("/x", "b", sh((1, "abc"))), None)
        check("is_ancestor: yes", is_ancestor("/x", "a", "b", sh((0, ""))), True)
        check("is_ancestor: no", is_ancestor("/x", "a", "b", sh((1, ""))), False)
        check("is_ancestor: unknown object", is_ancestor("/x", "a", "b", sh((128, ""))), False)
        with open(os.path.join(top, "a.sql"), "w") as fh:
            fh.write("x")
        r = fill({**base, "body": "body", "ready": True})
        check("e2e T2 ready with gaps: denied", r.get("deny"), True)
        full = "## Evidence\n- **What it does:** moves it\n- **Tests:** 4/4\n- **Screenshot:** n/a: nothing visible\n"
        r = fill({**base, "body": full, "ready": True})
        check("e2e T2 ready, all filled: allowed, untouched", (r.get("deny"), r.get("body"), r.get("changed")), (False, full, []))
        os.environ["FAKE_TIER"] = "tier:T1"
        r = fill({**base, "body": "body", "ready": True})
        check("e2e T1: left alone", r.get("applicable"), False)
        os.environ.pop("FAKE_TIER")
        r = fill({**base, "head": "o:no-such-branch", "body": "body", "ready": True})
        check("e2e unreadable tier: filled, never denied", (r.get("applicable"), r.get("deny")), (True, False))
        check("e2e unreadable tier: says so", "unreadable" in str(r.get("tier")), True)
        r = fill({**base, "repo": "other-repo", "body": "body", "ready": True})
        check("e2e other repo: left alone", r.get("applicable"), False)
        got = main_io(json.dumps({"mode": "capture", "command": "pytest", "output": "3 passed", "cwd": top}))["entry"]
        check("main_io capture: cd prefix stamps that checkout", main_io(json.dumps(
            {"mode": "capture", "command": f"cd {top} && pytest", "output": "3 passed", "cwd": tmp}))["entry"].get("sha"), sha)
        check("main_io capture",(got["source"], got["line"], got["branch"], got["sha"]), ("pytest", "3 passed", "lc1-x", sha))
        check("main_io junk fails open", main_io("not json").get("applicable"), False)
        check("main_io unknown mode", main_io('{"mode": "x"}'), {})

    # I/O edges, with a fake `run` (argv -> (rc, stdout)) and throwaway directories
    check("owner missing is never a match", same_repo("https://github.com//r", "", "r"), False)
    with tempfile.TemporaryDirectory() as tmp:
        withs, without = os.path.join(tmp, "with"), os.path.join(tmp, "without")
        for d in (withs, without):
            os.makedirs(os.path.join(d, "scripts/ci"))
        for rel in (EVIDENCE_SCRIPT, TIER_SCRIPT):
            open(os.path.join(withs, rel), "w").close()
        url = "https://github.com/o/r"

        def fake(answers):
            def run(argv, cwd=None, stdin=None):
                key = " ".join(argv)
                for k, v in answers.items():
                    if k in key:
                        return v
                return 1, ""
            return run
        check("toplevel from a failed rev-parse is ignored",
              find_checkout("o", "r", "/x", fake({"show-toplevel": (1, withs), "get-url": (0, url)})), None)
        check("toplevel found and matched", find_checkout("o", "r", "/x", fake({"show-toplevel": (0, withs + "\n"),
                                                                                 "get-url": (0, url)})), withs)
        check("a clone without the evidence script is skipped",
              find_checkout("o", "r", "/x", fake({"show-toplevel": (0, without), "get-url": (0, url)})), None)
        check("a clone of another repo is skipped",
              find_checkout("o", "r", "/x", fake({"show-toplevel": (0, withs), "get-url": (0, "https://github.com/o/z")})),
              None)
        old_home = os.environ.get("HOME")
        os.environ["HOME"] = tmp
        check("found under HOME/<repo>", find_checkout("o", "with", None, fake({"get-url": (0, "https://github.com/o/with")})),
              withs)
        if old_home is None:
            os.environ.pop("HOME")
        else:
            os.environ["HOME"] = old_home
        t1 = (0, "RESULT=PASS label=tier:T1 files=1 why=x")
        check("tier: empty head", tier_of(withs, "", fake({"rev-parse": (0, ""), "diff": (0, "a"), "files": t1})), None)
        check("tier: no tier script", tier_of(without, "b", fake({"rev-parse": (0, ""), "diff": (0, "a"), "files": t1})),
              None)
        seen = []

        def remote_only(argv, cwd=None, stdin=None):
            seen.append(" ".join(argv))
            if "rev-parse" in argv:
                return (0, "") if argv[-1] == "origin/b" else (1, "")
            return {"diff": (0, "a\n"), "files": t1}.get(next((k for k in ("diff", "files") if k in argv), ""), (1, ""))
        check("tier: falls back to origin/<branch>", tier_of(withs, "o:b", remote_only), "tier:T1")
        check("tier: diffed the remote branch", any(x.endswith("origin/main...origin/b") for x in seen), True)
        check("tier: failed diff", tier_of(withs, "b", fake({"rev-parse": (0, ""), "diff": (1, "a"), "files": t1})), None)
        check("tier: empty diff", tier_of(withs, "b", fake({"rev-parse": (0, ""), "diff": (0, " \n"), "files": t1})), None)
        check("tier: failed labeller", tier_of(withs, "b", fake({"rev-parse": (0, ""), "diff": (0, "a"),
                                                                    "files": (1, t1[1])})), None)
        base = {"owner": "o", "repo": "r", "cwd": "/x", "head": "b", "body": "x", "ready": True}
        top_ok = {"show-toplevel": (0, withs), "get-url": (0, url)}
        r = fill(base, fake({"show-toplevel": (1, "")}))
        check("fill: no checkout says so", (r["applicable"], "no checkout" in r["why"]), (False, True))
        r = fill(base, fake(top_ok))
        check("fill: unreadable config is not applicable", (r["applicable"], "config" in r["why"]), (False, True))
        with open(os.path.join(withs, EVIDENCE_CONFIG), "w") as fh:
            json.dump(CONFIG, fh)
        r = fill(base, fake({**top_ok, "template": (1, "## Evidence")}))
        check("fill: failed template is not applicable", (r["applicable"], "template" in r["why"]), (False, True))
        r = fill(base, fake({**top_ok, "template": (0, "  \n")}))
        check("fill: empty template is not applicable", r["applicable"], False)
        judge = (1, "  - What it does: empty. How: h\nRESULT=BLOCK tier=tier:T2 why=x")
        r = fill(base, fake({**top_ok, "template": (0, "## Evidence\n- **Tests:** \n"), "body --file": judge}))
        check("fill: no counts, nothing claimed as filled", r["changed"], ["added the `## Evidence` section"])
        check("fill: unreadable tier never denies", r["deny"], False)
        r = fill({**base, "body": "## Evidence\n- **Tests:** 4/4\n", "counts": [{"source": "a", "line": "9 passed"}]},
                 fake({**top_ok, "body --file": judge}))
        check("fill: session's own Tests kept, nothing claimed", (r["changed"], "4/4" in r["body"]), ([], True))
        check("main_io: a non-object payload", main_io("[1]"), {})
        check("main_io: fill mode reaches fill", "no checkout" in main_io(json.dumps({"mode": "fill", "owner": "o",
                                                                                     "repo": "nope-" + tmp[-6:]}))["why"],
              True)
        rc = subprocess.run([sys.executable, "-I", os.path.abspath(__file__)], input='{"mode": "capture", "command": "pytest",'
                            ' "output": "2 passed"}', capture_output=True, text=True, timeout=30)
        got = json.loads(rc.stdout or "{}").get("entry", {})
        check("CLI: stdin JSON in, JSON out", (got.get("source"), got.get("line")), ("pytest", "2 passed"))

    # The real judge and template, when this file sits in a checkout that has them (bbm-infrastructure after LC-2153).
    real = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", ".."))
    if os.path.isfile(os.path.join(real, EVIDENCE_SCRIPT)):
        rc, block = _run(["python3", "-I", os.path.join(real, EVIDENCE_SCRIPT), "template"], cwd=real)
        body = insert_section("## What this PR does\n\nx\n", block)
        cfg = json.load(open(os.path.join(real, EVIDENCE_CONFIG), encoding="utf-8"))
        lab = next(s["label"] for s in cfg["slots"] if s["rule"] == "counts")
        body, did = fill_slot(body, cfg["heading"], lab, counts_text([{"source": "mutate.py", "line": normalise("killed 31")}]))
        fd, path = tempfile.mkstemp(suffix=".md")
        with os.fdopen(fd, "w") as fh:
            fh.write(body)
        rc, out = _run(["python3", "-I", os.path.join(real, EVIDENCE_SCRIPT), "body", "--file", path], cwd=real)
        os.unlink(path)
        result, missing = parse_judge(out)
        check("real: template found and slot filled", (has_section(body, cfg["heading"]), did), (True, True))
        check("real: the judge accepts the filled counts", lab in [m[0] for m in missing], False)
        check("real: the judge lists the other gaps", (result, len(missing)), ("BLOCK", len(cfg["slots"]) - 1))
    else:
        print("  NOT CHECKED real t2_evidence.py: not in this checkout yet (LC-2153); the stand-in covered the CLI")

    passed = sum(1 for _, ok in results if ok)
    print(f"t2-evidence-fill selftest: {passed}/{len(results)} checks passed")
    return 0 if passed == len(results) else 1


if __name__ == "__main__":  # accepted survivors here: the harness runs the selftest in-process; CLI case covers it
    # Accepted survivor (guard-off / `in` -> `not in` on the next line; LC-1877 proposed waivers): with it broken,
    # `--selftest` skips the selftest and prints a JSON answer for an empty stdin with exit 0, the same code a passing
    # selftest gives; mutate.py judges only that exit code and the selftest never runs to assert on it. It has no count
    # line, and claude-mods.yml fails the job on the missing count line, so CI catches it where the selftest cannot.
    if "--selftest" in sys.argv[1:]:
        sys.exit(selftest())
    print(json.dumps(main_io(sys.stdin.read())))
