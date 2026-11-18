#!/usr/bin/env python3
"""PreToolUse gate: a PR that changes how code is tested, merged or deployed needs an LCH-600 review (LC-2207).

WHAT IT DOES. On a GitHub `create_pull_request`, or an `update_pull_request` that takes a PR out of draft,
it reads what the PR changes (the session's local clone: `git diff --name-status` plus `-U0` hunks; for an
update, the PR's own file list and patches from the connector). A change counts when it matches the repo's
`gate` patterns in hooks/paths.json and is not a pure addition the repo allows (`new_ok`: a brand-new file
such as a new `test-*.yml`; `append_ok`: a file that only gains lines, such as a new row in
`risk_tiers.json`). If anything counts, the PR body must carry one line per reviewed ticket:

    LCH-600-Review: <KEY> accepted | rebutted | skipped

and this session's Jira calls must show the exchange on <KEY>, read comment by comment:
  * the session wrote a comment starting `[LCH-600 review request]` on <KEY>;
  * accepted: a comment STARTING `[LCH-600 feedback]`, created after that request, was read, and the
    session then wrote a comment starting `[LCH-600 response]`;
  * rebutted: as accepted, plus a `[LCH-600 feedback]` comment created after the session's latest
    response (LCH-600 answered the argument);
  * skipped: the session wrote a comment starting `Skipping LCH-600 review:` plus a reason.
Quoting the marker mid-comment (a request that says "reply with [LCH-600 feedback]") never counts.

WHY. Operator decision (2026-11-17): every change to how code is tested, merged or deployed is reviewed by
the LCH-600 program (Deploy and CI speed) before a session acts on it. The trigger is the files, not the
project. LCH-600 reviewed this gate itself on LC-2207 (comment 192938); its ten points shaped this version.

MODE. paths.json `mode`: `shadow` (the default while it beds in) only warns, with a note that starts
`[mod:lch600-review-gate] SHADOW would-deny`, which register.ts toasts so session-close counts it;
`enforce` denies. The CI step that makes this authoritative is LC-2209; the mod is the early warning.

EXEMPT. A PR title that STARTS with an LCH key, or a branch named `lch<N>-...` (incidents, LCH-600's work).
Pushing a branch is never gated: sessions push to save work in an ephemeral container.

WHAT IT CANNOT SEE. A PreToolUse hook gets no transcript, so register.ts records the Jira calls this gate
reads and hands them over as `transcript_rows`. A container restart loses them: re-read the ticket.

FAIL OPEN. Unreadable input, no clone, a failed diff, a bad paths.json or any exception allows the call
and writes one line to stderr (exit 1). A diff it could not read adds a NOT CHECKED note.
Kill switch: `claude plugin disable lch600-review-gate`.

Self-test: python3 lch600-review-gate.py --selftest
"""
from __future__ import annotations

import fnmatch
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import transcript_reader  # noqa: E402

TAG = "[mod:lch600-review-gate]"
PATHS_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "paths.json")
EXEMPT_TITLE = re.compile(r"^\s*LCH-\d+\b", re.I)
EXEMPT_BRANCH = re.compile(r"^lch-?\d+", re.I)
LINE_RE = re.compile(r"^\s*LCH-600-Review:\s*([A-Z][A-Z0-9]+-\d+)\s+(accepted|rebutted|skipped)\b", re.I | re.M)
KEY_RE = re.compile(r"^[A-Z][A-Z0-9]+-\d+$")


def _marker(name: str) -> re.Pattern:
    # Jira's markdown export escapes brackets (`\[LCH-600 feedback\]`, seen on LC-2207), so allow a backslash.
    return re.compile(r"^\s*\\?\[" + re.escape(name) + r"\\?\]", re.I)


REQUEST, FEEDBACK, RESPONSE = _marker("LCH-600 review request"), _marker("LCH-600 feedback"), _marker("LCH-600 response")
SKIP = re.compile(r"^\s*Skipping LCH-600 review:\s*\S", re.I)
JIRA_URL = "https://b-b-m.atlassian.net/browse/"
STEP_TIMEOUT = 8
COMMENT_OPS = ("addCommentToJiraIssue", "addOrEditJiraIssueComment")
GUIDE = ".github/MERGE-QUEUE.md (LCH-600 review before CI and deploy changes)"


# ---- rules data -----------------------------------------------------------------------------------------------------

RULE_KEYS = ("new_ok", "append_ok", "derived")
DISPATCH_TRIGGERS = {"workflow_dispatch", "workflow_call"}


def load_rules(path: str = PATHS_FILE) -> dict:
    with open(path, encoding="utf-8") as fh:
        data = json.load(fh)
    if data.get("mode") not in ("shadow", "enforce"):
        raise ValueError("paths.json: mode must be shadow or enforce")
    _when(str(data.get("shadow_until")) + "T00:00:00+00:00") or _bad("shadow_until must be YYYY-MM-DD")
    for name, r in [("default", data.get("default"))] + list((data.get("repos") or {}).items()):
        r = r or {}
        for k in ("gate", "ask_seconds"):
            v = r.get(k)
            if not isinstance(v, list) or not all(isinstance(p, str) and p for p in v):
                raise ValueError(f"paths.json: {name}.{k} must be a list of non-empty strings")
        for k in RULE_KEYS:
            if not isinstance(r.get(k), dict):
                raise ValueError(f"paths.json: {name}.{k} must be an object")
        for pat, cfg in list(r["new_ok"].items()) + list(r["append_ok"].items()):
            if not isinstance(cfg, dict) or cfg.get("rule") not in ("dispatch_only", "lines", "selftest_block", "json_grow"):
                raise ValueError(f"paths.json: {name} {pat}: unknown rule")
    return data


def today_ok_for_shadow(rules: dict, today: str | None = None) -> bool:
    """False once shadow mode outlives shadow_until: the selftest then fails, so the enforce decision is not forgotten."""
    today = today or datetime.now(timezone.utc).strftime("%Y-%m-%d")
    return rules["mode"] != "shadow" or today <= str(rules["shadow_until"])


def _bad(msg: str):
    raise ValueError("paths.json: " + msg)


def repo_rules(rules: dict, owner: str, repo: str) -> dict:
    want = f"{owner}/{repo}".lower()
    for name, r in (rules.get("repos") or {}).items():
        if name.lower() == want:
            return r
    return rules["default"]


def _match(path: str, patterns) -> bool:
    return any(fnmatch.fnmatchcase(path, p) for p in patterns)


def _rule_for(path: str, mapping: dict) -> dict | None:
    for pat, cfg in mapping.items():
        if fnmatch.fnmatchcase(path, pat):
            return cfg
    return None


def _is_append(removed: list[str], added: list[str]) -> bool:
    """True when every removed line reappears with a trailing comma (a JSON row appended after it)."""
    pool = [a.rstrip() for a in added]
    for r in removed:
        want = r.rstrip() + ","
        if want in pool:
            pool.remove(want)
        else:
            return False
    return True


def workflow_triggers(lines: list[str]) -> set[str] | None:
    """The event names under a workflow's top-level `on:`, or None when there is no readable `on:`."""
    for i, ln in enumerate(lines):
        m = re.match(r"""^(?:on|"on"|'on'|true)\s*:\s*(.*?)\s*(?:#.*)?$""", ln)
        if not m:
            continue
        if m.group(1):  # inline: `on: push`, `on: [push, pull_request]`, `on: {push: ...}`
            return set(re.findall(r"[A-Za-z_]+", m.group(1)))
        body = []
        for nxt in lines[i + 1:]:
            if nxt.strip() == "" or nxt.lstrip().startswith("#"):
                continue
            if not nxt[:1].isspace():
                break
            body.append(nxt)
        if not body:
            return None
        indent = min(len(b) - len(b.lstrip()) for b in body)
        names = set()
        for b in body:
            if len(b) - len(b.lstrip()) == indent:
                k = re.match(r"^\s*-?\s*([A-Za-z_]+)", b)
                if k:
                    names.add(k.group(1))
        return names
    return None


def selftest_block(hunks: list[list[str]]) -> bool:
    """Every added line is a comment, a blank, or part of a `run_one <name> \\` block (the registration shape)."""
    for hunk in hunks:
        cont = False
        for ln in hunk:
            if ln.strip() == "" or ln.lstrip().startswith("#"):
                cont = False
            elif re.match(r"^run_one [\w.-]+ \\$", ln.rstrip()):
                cont = True
            elif ln[:1].isspace() and cont:
                cont = ln.rstrip().endswith("\\")
            else:
                return False
    return True


def json_grow(base_text, head_text, cfg: dict) -> bool:
    """Every `grow` list or map (dotted path, e.g. label_tiers.t1_strict) kept every old entry and only gained;
    every other non-`_` key is unchanged. Growing a strict tier tightens review; shrinking one loosens it."""
    try:
        base, head = json.loads(base_text), json.loads(head_text)
    except (TypeError, ValueError):
        return False
    return isinstance(base, dict) and isinstance(head, dict) and _grow_ok(base, head, set(cfg.get("grow") or []), "")


def _only_gained(b, h) -> bool:
    """A list kept every old entry; a dict kept every old key and each old value only gained (new keys allowed)."""
    if isinstance(b, list) and isinstance(h, list):
        return all(e in h for e in b)
    if isinstance(b, dict) and isinstance(h, dict):
        return all(k in h and (b[k] == h[k] or _only_gained(b[k], h[k])) for k in b)
    return False


def _grow_ok(base: dict, head: dict, grow: set, prefix: str) -> bool:
    for k in set(base) | set(head):
        if k.startswith("_"):
            continue
        path, b, h = prefix + k, base.get(k), head.get(k)
        if path in grow:
            if not _only_gained(b, h):
                return False
        elif any(g.startswith(path + ".") for g in grow) and isinstance(b, dict) and isinstance(h, dict):
            if not _grow_ok(b, h, grow, path + "."):
                return False
        elif b != h:
            return False
    return True


def _append_passes(cfg: dict, c: dict) -> bool:
    if not (c.get("removed") or c.get("added")):
        return False  # a modified file with no readable hunks (GitHub omits large patches) is never an append
    rule = cfg["rule"]
    if rule == "lines":
        return _is_append(c.get("removed") or [], c.get("added") or [])
    if rule == "selftest_block":
        return not c.get("removed") and selftest_block(c.get("hunks") or [])
    if rule == "json_grow":
        return json_grow(c.get("base_text"), c.get("head_text"), cfg)
    return False


def _new_passes(cfg: dict, c: dict) -> bool:
    if cfg["rule"] == "dispatch_only":
        t = workflow_triggers(c.get("added") or [])
        return bool(t) and t <= DISPATCH_TRIGGERS
    return False


def gated_changes(changes: list[dict], r: dict) -> list[str]:
    """Paths among `changes` that need a review. A change: {path, status A/M/D/R, removed, added, hunks,
    base_text, head_text}; the text fields are read only for files whose rule needs them."""
    paths = {c["path"] for c in changes}
    out = []
    for c in changes:
        path, status = c["path"], c["status"]
        if not _match(path, r["gate"]):
            continue
        gen = (r["derived"].get(path) or {}).get("generator")
        if gen and gen not in paths:
            continue  # generated output: its inputs are judged on their own, and `quick` refuses a hand edit
        cfg = _rule_for(path, r["new_ok"]) if status == "A" else _rule_for(path, r["append_ok"]) if status == "M" else None
        if cfg and (_new_passes(cfg, c) if status == "A" else _append_passes(cfg, c)):
            continue
        out.append(path)
    return out


def needs_content(path: str, status: str, r: dict) -> tuple[bool, bool]:
    """(read the hunks, read the base and head text) for this file under these rules."""
    if not _match(path, r["gate"]):
        return False, False
    cfg = _rule_for(path, r["new_ok"]) if status == "A" else _rule_for(path, r["append_ok"]) if status == "M" else None
    return bool(cfg), bool(cfg and cfg["rule"] == "json_grow")


def payload_rules(payload: dict, rules: dict) -> dict:
    """The rules of the repo a create/update PR call names."""
    inp = payload.get("tool_input") or {}
    return repo_rules(rules, str(inp.get("owner") or ""), str(inp.get("repo") or ""))


def is_exempt(title, head) -> bool:
    branch = str(head or "").split(":", 1)[-1].strip()
    return bool(EXEMPT_TITLE.match(str(title or "")) or EXEMPT_BRANCH.match(branch))


def review_lines(body: str) -> list[tuple[str, str]]:
    return [(k.upper(), v.lower()) for k, v in LINE_RE.findall(body or "")]


# ---- Jira evidence --------------------------------------------------------------------------------------------------

def _op(name: str, inp: dict) -> tuple[str, dict]:
    """(operation, arguments) for a direct Atlassian tool or the generic execute runners."""
    short = name.rsplit("__", 1)[-1]
    if short in ("executeRead", "executeWrite") and isinstance(inp.get("inputs"), dict):
        return str(inp.get("name") or ""), inp["inputs"]
    return short, inp


def _key_of(args: dict) -> str:
    for k in ("issueIdOrKey", "issueKey", "key"):
        v = args.get(k)
        if isinstance(v, str) and KEY_RE.match(v.strip().upper()):
            return v.strip().upper()
    return ""


def _adf_text(node) -> str:
    if isinstance(node, dict):
        if node.get("type") == "text":
            return str(node.get("text") or "")
        return "".join(_adf_text(c) for c in node.get("content") or [])
    if isinstance(node, list):
        return "".join(_adf_text(c) for c in node)
    return ""


def _body_text(v) -> str:
    if isinstance(v, str):
        return v
    if isinstance(v, (dict, list)):
        return _adf_text(v)
    return ""


def _comment_of(args: dict) -> str:
    for k in ("commentBody", "body", "comment"):
        if k in args:
            return _body_text(args[k])
    return ""


def _when(s) -> datetime | None:
    try:
        return datetime.fromisoformat(str(s))
    except (TypeError, ValueError):
        return None


def _json(text: str):
    try:
        return json.loads(text)
    except (TypeError, ValueError):
        return None


def read_comments(data, key_hint: str = "") -> list[tuple[str, str, str, datetime | None]]:
    """(issue key, comment id, body, created) for every comment in a Jira read result.

    Comments are attributed to the issue that holds them (issues.nodes[].key / fields.comment.comments),
    never to a key that merely appears elsewhere in the text (LCH-600 feedback item 10a)."""
    out = []

    def walk(node, key):
        if isinstance(node, dict):
            k = node.get("key") if isinstance(node.get("key"), str) and KEY_RE.match(node["key"]) else key
            comments = node.get("comments")
            if isinstance(comments, list) and k:
                for c in comments:
                    # LC-2207 waived: `or` differs only for a bare string "body" entry, which Jira never returns.
                    if isinstance(c, dict) and ("body" in c):
                        out.append((k.upper(), str(c.get("id") or ""), _body_text(c.get("body")), _when(c.get("created"))))
            for name, v in node.items():
                if name != "comments":
                    walk(v, k)
        elif isinstance(node, list):
            for v in node:
                walk(v, key)

    walk(data, key_hint)
    return out


def evidence(rows: list[dict]) -> dict:
    """Per key: request/response/skip comment ids this session wrote, and every comment it read."""
    ev: dict[str, dict] = {}

    def slot(key):
        return ev.setdefault(key, {"requests": [], "responses": [], "skipped": False, "read": {}, "mine": set()})

    for name, inp, text in transcript_reader.tool_calls_with_results(rows):
        if not name.startswith("mcp__Atlassian"):
            continue
        op, args = _op(name, inp if isinstance(inp, dict) else {})
        if op in COMMENT_OPS:
            key, body, res = _key_of(args), _comment_of(args), _json(text)
            if not key or not isinstance(res, dict) or not res.get("id"):
                continue  # a write without a returned comment id did not land
            s = slot(key)
            s["read"][str(res["id"])] = (body, _when(res.get("created")))
            s["mine"].add(str(res["id"]))  # never counts as LCH-600's feedback (round 2, item 1)
            if REQUEST.match(body):
                s["requests"].append(str(res["id"]))
            elif RESPONSE.match(body):
                s["responses"].append(str(res["id"]))
            elif SKIP.match(body):
                s["skipped"] = True
        else:
            for key, cid, body, created in read_comments(_json(text), _key_of(args)):
                if cid:
                    slot(key)["read"][cid] = (body, created)
    return ev


def _latest(s: dict, ids: list[str]) -> datetime | None:
    # LC-2207 waived: every written id is in s["read"], so `and` -> `or` only differs when it lets a None through,
    # and the max() of [None] is still None (covered by "request with no created time").
    times = [s["read"][i][1] for i in ids if i in s["read"] and s["read"][i][1] is not None]
    return max(times) if times else None


def _feedback_after(s: dict, t: datetime) -> datetime | None:
    """The FIRST feedback comment created after `t`, or None."""
    times = [c for cid, (b, c) in s["read"].items()
             if cid not in s["mine"] and c is not None and c > t and FEEDBACK.match(b)]
    return min(times) if times else None


def missing_evidence(lines: list[tuple[str, str]], rows: list[dict]) -> list[str]:
    ev = evidence(rows)
    gaps = []
    for key, verdict in lines:
        s = ev.get(key) or {"requests": [], "responses": [], "skipped": False, "read": {}, "mine": set()}
        if verdict == "skipped":
            if not s["skipped"]:
                gaps.append(f"{key} skipped: no `Skipping LCH-600 review: <reason>` comment from this session on {key}")
            continue
        req = _latest(s, s["requests"])
        if req is None:
            gaps.append(f"{key} {verdict}: this session has not posted a `[LCH-600 review request]` comment on {key}")
            continue
        fb = _feedback_after(s, req)
        if fb is None:
            gaps.append(f"{key} {verdict}: no comment starting `[LCH-600 feedback]` read on {key} after your request")
            continue
        resp = _latest(s, s["responses"])
        if resp is None or resp < fb:
            gaps.append(f"{key} {verdict}: no `[LCH-600 response]` comment from this session on {key} after the feedback")
            continue
        if verdict == "rebutted" and _feedback_after(s, resp) is None:
            gaps.append(f"{key} rebutted: LCH-600 has not answered your rebuttal yet (no `[LCH-600 feedback]` after it)")
    return gaps


# ---- the decision ---------------------------------------------------------------------------------------------------

def flow_text(files: list[str], ask_seconds: bool = False) -> str:
    shown = ", ".join(files[:6]) + (f" and {len(files) - 6} more" if len(files) > 6 else "")
    return (
        f"This PR changes how code is tested, merged or deployed ({shown}), so LCH-600 (Deploy and CI speed) "
        f"reviews it first (operator decision 2026-11-17, LC-2207). Pushing the branch is fine. Protocol: {GUIDE}.\n"
        "1. On each Jira story this PR serves, post a comment that STARTS with `[LCH-600 review request]`: what "
        "changes and why, the files, the expected effect on PR wait time, links to the stories.\n"
        "2. Wake the LCH-600 review desk (LCH-722) with send_message(session_id=\"session_01LpqYrCPF63BFU9BJKCpLK7\", "
        "message=\"LCH-600 review request on LC-1234, LC-1235\"). No send_message tool? Do nothing: the desk sweeps "
        "Jira every 30 minutes. Never ask the operator to relay it.\n"
        "3. Check back with send_later at 5, 10, 20, 40 and 60 minutes. After that, stop polling and give the "
        "operator a NEEDS YOU banner saying the review is waiting.\n"
        "4. Answer on the ticket with a comment that STARTS with `[LCH-600 response] ACCEPT` (capitals), or "
        "`[LCH-600 response] ARGUE` plus your evidence. If you argue, wait for LCH-600's next feedback comment.\n"
        "5. Add one line per ticket to the PR body, `LCH-600-Review: LC-1234 accepted <feedback comment id>` (or `rebutted <id>`), and "
        "repeat this call.\n"
        "A T2 PR: finish this review before the approval request goes out, so the operator approves once. "
        "Urgent: comment `Skipping LCH-600 review: <reason>` on the ticket and use `LCH-600-Review: LC-1234 "
        "skipped`. A PR titled with an LCH key is exempt."
        + ("\nThis PR adds or changes a check that runs on every PR: the review request must state the seconds it adds "
           "per PR and which existing check it folds into or retires (LCH-620)." if ask_seconds else "")
    )


def decide(payload: dict, changes: list[dict] | None, rules: dict) -> dict | None:
    """The hook answer, or None to allow silently. `changes` None = what the PR changes could not be read."""
    inp = payload.get("tool_input") or {}
    if is_exempt(inp.get("title"), inp.get("head")):
        return None
    if changes is None:
        return {"hookSpecificOutput": {"hookEventName": "PreToolUse", "additionalContext":
                f"{TAG} NOT CHECKED: could not read what this PR changes. If it touches CI, CD, deploy or "
                f"test-runner files it still needs an LCH-600 review (LC-2207). Protocol: {GUIDE}."}}
    # LC-2207 waived: a missing owner/repo falls to the default rules either way ("" or "None"), an equivalent mutant.
    r = payload_rules(payload, rules)
    hit = gated_changes(changes, r)
    if not hit:
        return None
    lines = review_lines(str(inp.get("body") or ""))
    if not lines:
        reason = flow_text(hit, any(_match(h, r["ask_seconds"]) for h in hit))
    else:
        gaps = missing_evidence(lines, transcript_reader.rows_for(payload))
        if not gaps:
            return None
        reason = ("The PR body names an LCH-600 review, but this session's Jira calls do not show it. Missing:\n- "
                  + "\n- ".join(gaps)
                  + "\nRe-read the ticket (getJiraIssue with the comment field) or post the missing comment, then "
                  f"repeat the call. Tickets: " + ", ".join(JIRA_URL + k for k, _ in lines))
    if rules.get("mode") == "enforce":
        return {"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny",
                                       "permissionDecisionReason": f"{TAG} {reason}\nNothing was sent."}}
    return {"hookSpecificOutput": {"hookEventName": "PreToolUse", "additionalContext":
            f"{TAG} SHADOW would-deny (the gate is in shadow mode, so the call goes through; follow the "
            f"protocol anyway): {reason}"}}


# ---- reading what a PR changes --------------------------------------------------------------------------------------

def _run(argv: list) -> tuple[int, str]:
    try:
        r = subprocess.run(argv, capture_output=True, text=True, timeout=STEP_TIMEOUT)
        return r.returncode, r.stdout
    except (OSError, subprocess.SubprocessError):
        return 127, ""


def same_repo(url: str, owner: str, repo: str) -> bool:
    u = (url or "").strip().lower().rstrip("/")
    u = u[:-4] if u.endswith(".git") else u
    want = f"{owner}/{repo}".lower()
    return bool(owner and repo) and (u.endswith("/" + want) or u.endswith(":" + want))


def find_checkout(owner: str, repo: str, run=_run) -> str | None:
    cands = []
    rc, out = run(["git", "-C", os.getcwd(), "rev-parse", "--show-toplevel"])
    if rc == 0 and out.strip():
        cands.append(out.strip())
    home = os.environ.get("HOME") or ""
    # LC-2207 waived: `and repo` is belt and braces; same_repo() already refuses an empty repo, an equivalent mutant.
    cands += [os.path.join(p, repo) for p in (os.getcwd(), home, "/home/user", "/home/claude") if p and repo]
    for top in dict.fromkeys(cands):
        rc, url = run(["git", "-C", top, "remote", "get-url", "origin"])
        if rc == 0 and same_repo(url, owner, repo):
            return top
    return None


def parse_hunks(patch: str) -> tuple[list[str], list[str], list[list[str]]]:
    """(removed, added, added lines per hunk) of a unified diff, headers skipped."""
    removed, added, hunks = [], [], []
    for ln in (patch or "").splitlines():
        if ln.startswith(("+++", "---")):
            continue
        if ln.startswith("@@") or not hunks:
            hunks.append([])  # the @@ line itself starts with neither - nor +, so it is skipped below
        if ln.startswith("-"):
            removed.append(ln[1:])
        elif ln.startswith("+"):
            added.append(ln[1:])
            hunks[-1].append(ln[1:])
    return removed, added, [h for h in hunks if h]


def _change(path: str, status: str, patch: str = "") -> dict:
    removed, added, hunks = parse_hunks(patch)
    return {"path": path, "status": status, "removed": removed, "added": added, "hunks": hunks,
            "base_text": None, "head_text": None}


def changes_from_git(top: str, base: str, ref: str, r: dict, run=_run) -> list[dict] | None:
    rng = f"origin/{base}...{ref}"
    rc, out = run(["git", "-C", top, "diff", "--name-status", "--no-renames", rng])
    if rc != 0:
        return None
    changes = []
    for ln in out.splitlines():
        parts = ln.split("\t")
        if len(parts) < 2:
            continue
        c = _change(parts[-1], parts[0][:1])
        hunks, texts = needs_content(c["path"], c["status"], r)
        if hunks:
            rc, patch = run(["git", "-C", top, "diff", "-U0", rng, "--", c["path"]])
            if rc != 0:
                return None
            c = _change(c["path"], c["status"], patch)
        if texts:
            # An unreadable side comes back as empty text, which json_grow refuses, so the file stays gated.
            c["base_text"] = run(["git", "-C", top, "show", f"origin/{base}:{c['path']}"])[1]
            c["head_text"] = run(["git", "-C", top, "show", f"{ref}:{c['path']}"])[1]
        changes.append(c)
    return changes


def changed_files(payload: dict, r: dict, run=_run) -> list[dict] | None:
    """What the PR changes: the connector's file list when register.ts supplied one, else the local clone."""
    supplied = payload.get("pr_files")
    if isinstance(supplied, list):
        status = {"added": "A", "removed": "D", "modified": "M", "renamed": "R", "changed": "M", "copied": "A"}
        out = []
        for f in supplied:
            if not isinstance(f, dict) or not f.get("filename"):
                return None
            out.append(_change(str(f["filename"]), status.get(str(f.get("status")), "M"), str(f.get("patch") or "")))
        return out  # base/head text is not read here, so a json_grow file stays gated on this path
    inp = payload.get("tool_input") or {}
    top = find_checkout(str(inp.get("owner") or ""), str(inp.get("repo") or ""), run)
    branch = str(inp.get("head") or "").split(":", 1)[-1].strip()
    base = str(inp.get("base") or "main").strip() or "main"
    if not top or not branch:
        return None
    for ref in (branch, f"origin/{branch}"):
        rc, _ = run(["git", "-C", top, "rev-parse", "--verify", "--quiet", ref])
        if rc == 0:
            return changes_from_git(top, base, ref, r, run)
    return None


def replay(since: str, rules: dict, owner: str = "brand-bridge-media", repo: str = "bbm-infrastructure",
           run=_run) -> list[tuple[str, list[str]]]:
    """The merges to origin/main since `since` that these rules would gate: the shadow-mode count (LC-2207).

    Run from a clone of the repo: python3 lch600-review-gate.py --replay --since 2026-11-17"""
    r = repo_rules(rules, owner, repo)
    rc, log = run(["git", "log", "origin/main", f"--since={since}", "--format=%H%x09%s"])
    out = []
    for ln in log.splitlines() if rc == 0 else []:
        sha, _, subject = ln.partition("\t")
        rc, ns = run(["git", "diff", "--name-status", "--no-renames", f"{sha}^", sha])
        changes = []
        for row in ns.splitlines() if rc == 0 else []:
            parts = row.split("\t")  # a junk row becomes an ungated path, so it needs no guard here
            c = _change(parts[-1], parts[0][:1])
            hunks, texts = needs_content(c["path"], c["status"], r)
            if hunks:
                c = _change(c["path"], c["status"], run(["git", "diff", "-U0", f"{sha}^", sha, "--", c["path"]])[1])
            if texts:
                c["base_text"] = run(["git", "show", f"{sha}^:{c['path']}"])[1]
                c["head_text"] = run(["git", "show", f"{sha}:{c['path']}"])[1]
            changes.append(c)
        hit = gated_changes(changes, r)
        if hit and not is_exempt(subject, ""):
            out.append((subject, hit))
    return out


def main() -> int:
    try:
        payload = json.load(sys.stdin)
        tool = str(payload.get("tool_name") or "")
        if not tool.endswith(("__create_pull_request", "__update_pull_request")):
            return 0
        rules = load_rules()
        r = payload_rules(payload, rules)
        out = decide(payload, changed_files(payload, r), rules)
        if out:
            print(json.dumps(out))
        return 0
    except Exception as exc:  # fail open: a broken gate must never stop a PR
        print(f"{TAG} did not run: {exc}", file=sys.stderr)
        return 1


# ---- selftest -------------------------------------------------------------------------------------------------------

_IDS = iter(range(10**6))

# LC-2207's own review request (comment 192929): it quotes the feedback marker mid-text and must never count.
REAL_REQUEST = ("\\[LCH-600 review request\\]\n\n**What this is.** ...\n\n**What I need back.** A comment on this "
                "ticket starting `[LCH-600 feedback]`: what to change, add or drop, ranked by importance.")


def _rows(*calls):
    """Transcript rows from (tool, input, result) triples; ids are unique across calls so rows can be concatenated."""
    rows = []
    for name, inp, text in calls:
        i = next(_IDS)
        rows.append({"type": "assistant", "message": {"content": [{"type": "tool_use", "id": f"t{i}", "name": name, "input": inp}]}})
        rows.append({"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": f"t{i}", "content": text}]}})
    return rows


GET = "mcp__Atlassian__getJiraIssue"
ADD = "mcp__Atlassian__addCommentToJiraIssue"


def _write(key, body, cid, created):
    return _rows((ADD, {"issueIdOrKey": key, "commentBody": body}, json.dumps({"id": cid, "created": created})))


def _read(key, comments):
    issue = {"key": key, "fields": {"comment": {"comments": [
        {"id": cid, "body": body, "created": created} for cid, body, created in comments]}}}
    return _rows((GET, {"issueIdOrKey": key}, json.dumps({"issues": {"nodes": [issue]}})))


def cli_mode(argv: list[str]) -> str:
    return "replay" if "--replay" in argv else "selftest" if "--selftest" in argv else "hook"


def replay_cli(argv: list[str], run=_run) -> int:
    since = argv[argv.index("--since") + 1] if "--since" in argv else "7 days ago"
    hits = replay(since, load_rules(), run=run)
    for subject, files in hits:
        print(f"would-deny  {subject[:90]}  <- {', '.join(files[:4])}")
    print(f"replay: {len(hits)} merge(s) since {since} would need an LCH-600 review")
    return 0


def _selftest() -> int:
    results: list[tuple[str, bool]] = []

    def check(label, got, want):
        results.append((label, got == want))
        if got != want:
            print(f"FAIL {label}: got {got!r}, want {want!r}")

    rules = load_rules()
    infra = repo_rules(rules, "brand-bridge-media", "bbm-infrastructure")
    check("rules: repo lookup ignores case", repo_rules(rules, "Brand-Bridge-Media", "BBM-Infrastructure") is infra, True)
    check("rules: unknown repo gets default", repo_rules(rules, "o", "r") is rules["default"], True)
    check("rules: shipped in shadow mode", rules["mode"], "shadow")

    def ch(path, status="M", removed=(), added=(), hunks=None, base=None, head=None):
        return {"path": path, "status": status, "removed": list(removed), "added": list(added),
                "hunks": [list(added)] if hunks is None and added else hunks or [], "base_text": base, "head_text": head}

    check("edit to a workflow gated", gated_changes([ch(".github/workflows/deploy.yml")], infra), [".github/workflows/deploy.yml"])
    check("rules: shadow has an end date (on 2026-11-24 read the replay and decide)", today_ok_for_shadow(rules), True)
    check("shadow: day after the end fails", today_ok_for_shadow(rules, "2026-11-25"), False)
    check("shadow: last day passes", today_ok_for_shadow(rules, "2026-11-24"), True)
    check("enforce: no end date needed", today_ok_for_shadow(dict(rules, mode="enforce"), "2099-01-01"), True)
    check("generated tests.yml, generator unchanged: passes", gated_changes([ch(".github/workflows/tests.yml")], infra), [])
    check("generated tests.yml, generator changed: gated", gated_changes(
          [ch(".github/workflows/tests.yml"), ch("scripts/ci/tests_suites.py")], infra),
          [".github/workflows/tests.yml", "scripts/ci/tests_suites.py"])
    check("generated manifest, generator unchanged: passes", gated_changes([ch("scripts/ci/tests_suites.json")], infra), [])
    DISPATCH = ["name: x", "on:", "  workflow_dispatch:", "    inputs:", "      a: {}", "jobs:", "  j:", "    runs-on: x"]
    check("deleted workflow gated", gated_changes([ch(".github/workflows/x.yml", "D")], infra), [".github/workflows/x.yml"])
    check("new test-*.yml, dispatch only: passes", gated_changes([ch(".github/workflows/test-foo.yml", "A", added=DISPATCH)], infra), [])
    check("new run-*.yml, dispatch + call: passes", gated_changes([ch(".github/workflows/run-foo.yml", "A",
          added=["on: [workflow_dispatch, workflow_call]"])], infra), [])
    check("new test-*.yml on pull_request: gated", gated_changes([ch(".github/workflows/test-foo.yml", "A",
          added=["on:", "  pull_request:", "  workflow_dispatch:"])], infra), [".github/workflows/test-foo.yml"])
    check("new run-*.yml on schedule: gated", gated_changes([ch(".github/workflows/run-foo.yml", "A",
          added=["'on':", "  schedule:", "    - cron: '0 * * * *'"])], infra), [".github/workflows/run-foo.yml"])
    check("new test-*.yml with no on: gated", gated_changes([ch(".github/workflows/test-foo.yml", "A", added=["jobs:"])], infra),
          [".github/workflows/test-foo.yml"])
    check("triggers: inline push", workflow_triggers(["on: push # c"]), {"push"})
    check("triggers: list form", workflow_triggers(["on:", "  - push", "  - workflow_dispatch"]), {"push", "workflow_dispatch"})
    check("triggers: nested keys ignored", workflow_triggers(["on:", "  workflow_call:", "    inputs:", "      pull_request: {}"]),
          {"workflow_call"})
    check("triggers: blank and comment lines skipped", workflow_triggers(["on:", "", "  # x", "  workflow_dispatch:"]),
          {"workflow_dispatch"})
    check("triggers: empty on block", workflow_triggers(["on:", "jobs:"]), None)
    check("edited run-*.yml gated", gated_changes([ch(".github/workflows/run-foo.yml")], infra), [".github/workflows/run-foo.yml"])
    check("new deploy workflow gated", gated_changes([ch(".github/workflows/deploy-x.yml", "A")], infra),
          [".github/workflows/deploy-x.yml"])
    block = ["# LC-1 new selftest", "run_one lc1_thing \\", "    python3 x.py --selftest \\", "    --quiet", ""]
    check("selftest: run_one block passes", gated_changes([ch("scripts/run_selftests.sh", added=block)], infra), [])
    check("selftest: exit 0 gated", gated_changes([ch("scripts/run_selftests.sh", added=["exit 0"])], infra),
          ["scripts/run_selftests.sh"])
    check("selftest: stray indented line gated", gated_changes([ch("scripts/run_selftests.sh", added=["  exit 0"])], infra),
          ["scripts/run_selftests.sh"])
    check("selftest: line after a block ends gated", gated_changes([ch("scripts/run_selftests.sh",
          added=["run_one a \\", "    x", "    exit 0"])], infra), ["scripts/run_selftests.sh"])
    check("selftest: edited line gated", gated_changes([ch("scripts/run_selftests.sh", removed=["a"], added=block)], infra),
          ["scripts/run_selftests.sh"])
    check("modified file with no hunks gated", gated_changes([ch("scripts/run_selftests.sh")], infra), ["scripts/run_selftests.sh"])
    tiers = {"_why": "x", "max_files": 9, "tier0": ["docs/*"], "tier2": ["a"], "tier1_pin": [],
             "label_tiers": {"t1_strict": ["s"], "t2": ["m"], "sql_classified": ["q"]}}

    def tiers_change(**kw):
        head = json.loads(json.dumps(tiers))
        for k, v in kw.items():
            if "." in k:
                a, b = k.split(".")
                head[a][b] = v
            else:
                head[k] = v
        return [ch("scripts/ci/risk_tiers.json", added=["x"], base=json.dumps(tiers), head=json.dumps(head))]
    check("risk tiers: tier2 grows, passes", gated_changes(tiers_change(tier2=["a", "b"]), infra), [])
    check("risk tiers: t1_strict grows, passes", gated_changes(tiers_change(**{"label_tiers.t1_strict": ["s", "t"]}), infra), [])
    check("risk tiers: tier0 grows, gated", gated_changes(tiers_change(tier0=["docs/*", "scripts/*"]), infra),
          ["scripts/ci/risk_tiers.json"])
    check("risk tiers: tier2 loses an entry, gated", gated_changes(tiers_change(tier2=["b"]), infra), ["scripts/ci/risk_tiers.json"])
    check("risk tiers: max_files changed, gated", gated_changes(tiers_change(max_files=99), infra), ["scripts/ci/risk_tiers.json"])
    check("risk tiers: sql_classified changed, gated", gated_changes(
          tiers_change(**{"label_tiers.sql_classified": ["q", "r"]}), infra), ["scripts/ci/risk_tiers.json"])
    check("risk tiers: _why changed, passes", gated_changes(tiers_change(_why="y"), infra), [])
    check("risk tiers: no base text (connector), gated", gated_changes([ch("scripts/ci/risk_tiers.json", added=["x"])], infra),
          ["scripts/ci/risk_tiers.json"])
    check("json grow: not an object", json_grow("[]", "[]", {"grow": []}), False)
    check("json grow: grow key turned into a string", json_grow('{"a": []}', '{"a": "x"}', {"grow": ["a"]}), False)
    check("json grow: nested parent not a dict", json_grow('{"a": {"b": []}}', '{"a": 1}', {"grow": ["a.b"]}), False)
    cfg = {"_why": "x", "exclude_jobs": {"j": "r"}, "trimmed_pr_paths": {"s1": ["a"]}, "min_suites": 3}

    def cfg_change(**kw):
        return [ch("scripts/ci/tests_suites.config.json", added=["x"], base=json.dumps(cfg), head=json.dumps(dict(cfg, **kw)))]
    check("suite config: new suite paths, passes", gated_changes(cfg_change(trimmed_pr_paths={"s1": ["a"], "s2": ["b"]}), infra), [])
    check("suite config: suite gains a path, passes", gated_changes(cfg_change(trimmed_pr_paths={"s1": ["a", "c"]}), infra), [])
    check("suite config: suite loses a path, gated", gated_changes(cfg_change(trimmed_pr_paths={"s1": []}), infra),
          ["scripts/ci/tests_suites.config.json"])
    check("suite config: suite removed, gated", gated_changes(cfg_change(trimmed_pr_paths={}), infra),
          ["scripts/ci/tests_suites.config.json"])
    check("suite config: exclusion added, gated", gated_changes(cfg_change(exclude_jobs={"j": "r", "k": "r"}), infra),
          ["scripts/ci/tests_suites.config.json"])
    check("suite config: min_suites changed, gated", gated_changes(cfg_change(min_suites=1), infra),
          ["scripts/ci/tests_suites.config.json"])
    check("append to a non-append file gated", gated_changes([ch("scripts/ci/merge_train.json", added=["1"])], infra),
          ["scripts/ci/merge_train.json"])
    check("lines rule still works where configured", _append_passes({"rule": "lines"}, ch("x", added=["a"])), True)
    check("lines rule: no removed key", _append_passes({"rule": "lines"}, {"added": ["a"]}), True)
    check("lines rule: no added key", _append_passes({"rule": "lines"}, {"removed": ["a"]}), False)
    check("append rule: row kept with a comma", _is_append(["a"], ["a,", "b"]), True)
    check("only gained: list against a map", _only_gained([], {}), False)
    check("only gained: map against a list", _only_gained({}, []), False)
    check("content: ungated file in a rule map", needs_content("x", "A", {"gate": [], "new_ok": {"x": {"rule": "dispatch_only"}},
          "append_ok": {}}), (False, False))
    check("flow text: no seconds question by default", "seconds" in flow_text(["a"]), False)
    check("unknown rule never passes", _append_passes({"rule": "nope"}, ch("x", added=["a"])), False)
    check("unknown new rule never passes", _new_passes({"rule": "nope"}, ch("x", "A", added=["on: workflow_dispatch"])), False)
    check("content: hunks for an append file", needs_content("scripts/run_selftests.sh", "M", infra), (True, False))
    check("content: text for a json_grow file", needs_content("scripts/ci/risk_tiers.json", "M", infra), (True, True))
    check("content: nothing for a plain gated file", needs_content(".github/workflows/deploy.yml", "M", infra), (False, False))
    check("content: nothing for an ungated file", needs_content("README.md", "M", infra), (False, False))
    check("new file outside new_ok gated", gated_changes([ch("scripts/ci/new_gate.py", "A")], infra), ["scripts/ci/new_gate.py"])
    check("wrangler.toml gated", gated_changes([ch("cloudflare-workers/link/wrangler.toml")], infra),
          ["cloudflare-workers/link/wrangler.toml"])
    check("merge-governing mod gated", gated_changes([ch("claude-mods/t2-evidence-fill/hooks/x.py")], infra),
          ["claude-mods/t2-evidence-fill/hooks/x.py"])
    check("worker code not gated", gated_changes([ch("cloudflare-workers/x/src/index.ts"), ch("README.md")], infra), [])
    check("track epics not gated", gated_changes([ch("infra/track-epics.json")], infra), [])
    check("lookalike not gated", gated_changes([ch("docs/.github/workflows/x")], infra), [])
    guard = repo_rules(rules, "brand-bridge-media", "bbm-guardrails")
    check("guardrails: review policy gated", gated_changes([ch("review_policy.json")], guard), ["review_policy.json"])
    check("guardrails: other file not gated", gated_changes([ch("README.md")], guard), [])
    agent = repo_rules(rules, "brand-bridge-media", "bbm-refresh-agent")
    check("refresh-agent: budget gate gated", gated_changes([ch("agent/budget_gate.py")], agent), ["agent/budget_gate.py"])
    check("default: workflow gated", gated_changes([ch(".github/workflows/x.yml")], rules["default"]), [".github/workflows/x.yml"])
    check("append rule: removal with no match", _is_append(["x"], ["y"]), False)
    check("append rule: each removal used once", _is_append(["a", "a"], ["a,"]), False)
    check("append rule: pure additions", _is_append([], ["a"]), True)

    check("payload rules: named repo", payload_rules({"tool_input": {"owner": "brand-bridge-media", "repo": "bbm-guardrails"}},
          rules) is repo_rules(rules, "brand-bridge-media", "bbm-guardrails"), True)
    check("payload rules: nothing named", payload_rules({"tool_input": None}, rules) is rules["default"], True)
    check("payload rules: null owner", payload_rules({"tool_input": {"owner": None, "repo": "bbm-guardrails"}},
          rules) is rules["default"], True)
    check("exempt: title starts with LCH", is_exempt("LCH-612 fix runner", "x"), True)
    check("exempt: LCH mid-title is not", is_exempt("LC-2300 tune (refs LCH-600)", "x"), False)
    check("exempt: lch branch", is_exempt("t", "lch612-fix"), True)
    check("exempt: owner-prefixed lch branch", is_exempt("t", "o:LCH-612-fix"), True)
    check("exempt: LC branch is not", is_exempt("t", "lc612-fix"), False)
    check("exempt: project-thread branch is not", is_exempt("LC-1 t", "claude/project-thread-x"), False)
    check("exempt: nothing given", is_exempt(None, None), False)

    check("lines parsed", review_lines("x\nLCH-600-Review: lc-12 Accepted\n  LCH-600-Review: LC-13 skipped (urgent)"),
          [("LC-12", "accepted"), ("LC-13", "skipped")])
    check("bad verdict ignored", review_lines("LCH-600-Review: LC-12 maybe"), [])
    check("mid-line ignored", review_lines("see LCH-600-Review: LC-12 accepted"), [])

    T = "2026-11-17T14:{:02d}:00.000-0600"
    req = _write("LC-12", "[LCH-600 review request] plan", "100", T.format(0))
    fb = _read("LC-12", [("100", REAL_REQUEST, T.format(0)), ("101", "\\[LCH-600 feedback\\] fold it", T.format(5))])
    resp = _write("LC-12", "[LCH-600 response] Accepted", "102", T.format(8))
    check("accepted: request, feedback, response", missing_evidence([("LC-12", "accepted")], req + fb + resp), [])
    mine_fb = _write("LC-12", "[LCH-600 feedback] looks fine", "150", T.format(3))
    mine_read = _read("LC-12", [("150", "[LCH-600 feedback] looks fine", T.format(3))])
    check("feedback this session wrote itself does not count",
          len(missing_evidence([("LC-12", "accepted")], req + mine_fb + mine_read + resp)), 1)
    check("own feedback does not answer a rebuttal", len(missing_evidence([("LC-12", "rebutted")],
          req + fb + resp + _write("LC-12", "[LCH-600 feedback] ok", "151", T.format(20)))), 1)
    check("accepted: no request from this session", "has not posted" in " ".join(
        missing_evidence([("LC-12", "accepted")], fb + resp)), True)
    undated = _rows((ADD, {"issueIdOrKey": "LC-12", "commentBody": "[LCH-600 review request] x"}, json.dumps({"id": "100"})))
    check("request with no created time: treated as not posted", "has not posted" in " ".join(
        missing_evidence([("LC-12", "accepted")], undated + _read("LC-12", [("101", "[LCH-600 feedback] y", T.format(5))]) + resp)), True)
    check("runner without inputs: ignored, no crash", evidence(_rows(("mcp__Atlassian_MCP__executeRead", {"name": "x"}, "{}"))), {})
    check("key: non-string ignored", _key_of({"issueIdOrKey": 123}), "")
    check("key: not a key ignored", _key_of({"issueIdOrKey": "hello"}), "")
    check("ADF: top-level list read", _body_text([{"type": "text", "text": "x"}, {"type": "text", "text": "y"}]), "xy")
    check("read: non-dict comment skipped", read_comments({"key": "LC-1", "comments": ["x", {"id": "2", "body": "b"}]})[0][1], "2")
    check("accepted: no response", len(missing_evidence([("LC-12", "accepted")], req + fb)), 1)
    check("accepted: no feedback read", len(missing_evidence([("LC-12", "accepted")], req + resp)), 1)
    check("accepted: nothing", len(missing_evidence([("LC-12", "accepted")], [])), 1)
    only_request = _read("LC-12", [("100", REAL_REQUEST, T.format(0))])
    check("REAL request quoting the marker is not feedback",
          len(missing_evidence([("LC-12", "accepted")], req + only_request + resp)), 1)
    old_fb = _read("LC-12", [("90", "[LCH-600 feedback] earlier round", "2026-11-16T10:00:00.000-0600")])
    check("feedback older than the request does not count", len(missing_evidence([("LC-12", "accepted")], req + old_fb + resp)), 1)
    early_resp = _write("LC-12", "[LCH-600 response] ok", "99", T.format(1))
    check("response before the feedback does not count", len(missing_evidence([("LC-12", "accepted")], req + early_resp + fb)), 1)
    check("feedback on another issue does not count", len(missing_evidence([("LC-12", "accepted")],
          req + _read("LC-99", [("101", "[LCH-600 feedback] x", T.format(5))]) + resp)), 1)
    bad_write = _rows((ADD, {"issueIdOrKey": "LC-12", "commentBody": "[LCH-600 response] x"}, "Error: 403"))
    check("failed comment write does not count", len(missing_evidence([("LC-12", "accepted")], req + fb + bad_write)), 1)
    check("rebutted: needs LCH-600's answer after it", len(missing_evidence([("LC-12", "rebutted")], req + fb + resp)), 1)
    answer = _read("LC-12", [("103", "[LCH-600 feedback] fair, keep it", T.format(20))])
    check("rebutted: answered", missing_evidence([("LC-12", "rebutted")], req + fb + resp + answer), [])
    skip = _write("LC-12", "Skipping LCH-600 review: prod down", "104", T.format(1))
    check("skipped with comment", missing_evidence([("LC-12", "skipped")], skip), [])
    check("skipped without comment", len(missing_evidence([("LC-12", "skipped")], [])), 1)
    check("skip with no reason does not count",
          len(missing_evidence([("LC-12", "skipped")], _write("LC-12", "Skipping LCH-600 review:", "105", T.format(1)))), 1)
    runner = _rows(("mcp__Atlassian_MCP__executeWrite", {"name": "addOrEditJiraIssueComment", "cloudId": "c",
                    "inputs": {"issueIdOrKey": "lc-12", "body": "[LCH-600 response] no"}},
                    json.dumps({"id": "102", "created": T.format(8)})),
                   ("mcp__Atlassian_MCP__executeRead", {"name": "listJiraIssueComments", "inputs": {"issueIdOrKey": "LC-12"}},
                    json.dumps({"comments": [{"id": "101", "body": "[LCH-600 feedback] y", "created": T.format(5)},
                                             {"id": "103", "body": "[LCH-600 feedback] z", "created": T.format(20)}]})))
    check("execute runners count", missing_evidence([("LC-12", "rebutted")], req + runner), [])
    adf = {"type": "doc", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "[LCH-600 response] ok"}]}]}
    adf_resp = _rows((ADD, {"issueIdOrKey": "LC-12", "commentBody": adf}, json.dumps({"id": "102", "created": T.format(8)})))
    check("ADF response counts", missing_evidence([("LC-12", "accepted")], req + fb + adf_resp), [])
    check("non-Atlassian tool ignored", len(missing_evidence([("LC-12", "accepted")],
          req + _rows(("mcp__other__getJiraIssue", {"issueIdOrKey": "LC-12"},
                       json.dumps({"key": "LC-12", "comments": [{"id": "101", "body": "[LCH-600 feedback] x",
                                                                "created": T.format(5)}]}))) + resp)), 1)
    check("read: comments keep their own issue", [c[0] for c in read_comments(
        {"issues": {"nodes": [{"key": "LC-1", "fields": {"comment": {"comments": [{"id": "1", "body": "b"}]}}},
                              {"key": "LC-2", "fields": {"comment": {"comments": [{"id": "2", "body": "c"}]}}}]}})],
          ["LC-1", "LC-2"])
    check("read: non-JSON text gives nothing", read_comments(None, "LC-1"), [])
    check("when: bad date", _when("nope"), None)

    wf = [ch(".github/workflows/deploy.yml")]
    base = {"tool_name": "mcp__github__create_pull_request",
            "tool_input": {"owner": "brand-bridge-media", "repo": "bbm-infrastructure", "head": "lc1-x",
                           "title": "LC-1 t", "body": ""}}
    enforce = dict(rules, mode="enforce")

    def with_body(body, rows=None):
        p = json.loads(json.dumps(base))
        p["tool_input"]["body"] = body
        p["transcript_rows"] = rows or []
        return p

    d = decide(with_body(""), wf, enforce)["hookSpecificOutput"]
    check("enforce, no line: deny", d.get("permissionDecision"), "deny")
    check("deny names the mod", d["permissionDecisionReason"].startswith(TAG), True)
    check("deny wakes the review desk, not the operator (LCH-722)",
          "session_01LpqYrCPF63BFU9BJKCpLK7" in d["permissionDecisionReason"]
          and "paste" not in d["permissionDecisionReason"], True)
    check("deny backs off then stops", "5, 10, 20, 40 and 60" in d["permissionDecisionReason"]
          and "NEEDS YOU" in d["permissionDecisionReason"], True)
    check("deny points to the protocol doc", "MERGE-QUEUE.md" in d["permissionDecisionReason"], True)
    check("deny names the response keywords and the sweep cadence",
          "[LCH-600 response] ACCEPT" in d["permissionDecisionReason"]
          and "[LCH-600 response] ARGUE" in d["permissionDecisionReason"]
          and "every 30 minutes" in d["permissionDecisionReason"], True)
    check("deny orders it before T2 approval", "T2" in d["permissionDecisionReason"], True)
    check("plain gate: no seconds question", "seconds" in d["permissionDecisionReason"], False)
    qc = decide(with_body(""), [ch("scripts/ci/quick_checks.d/x.sh", "A")], enforce)["hookSpecificOutput"]
    check("quick check: asks for the seconds it adds", "seconds it adds" in qc["permissionDecisionReason"]
          and "LCH-620" in qc["permissionDecisionReason"], True)
    s = decide(with_body(""), wf, rules)["hookSpecificOutput"]
    check("shadow: no decision", "permissionDecision" in s, False)
    check("shadow: says would-deny", s["additionalContext"].startswith(f"{TAG} SHADOW would-deny"), True)
    check("no gated files: allow", decide(with_body(""), [ch("README.md")], enforce), None)
    check("empty diff: allow", decide(with_body(""), [], enforce), None)
    nc = decide(with_body(""), None, enforce)["hookSpecificOutput"]
    check("unreadable diff: note, no deny", "permissionDecision" in nc, False)
    check("unreadable diff: says NOT CHECKED", "NOT CHECKED" in nc["additionalContext"], True)
    check("line with evidence: allow", decide(with_body("LCH-600-Review: LC-12 accepted", req + fb + resp), wf, enforce), None)
    d2 = decide(with_body("LCH-600-Review: LC-12 accepted", req + fb), wf, enforce)["hookSpecificOutput"]
    check("line without evidence: deny", d2.get("permissionDecision"), "deny")
    check("line without evidence: names the gap", "[LCH-600 response]" in d2["permissionDecisionReason"], True)
    lch = with_body("")
    lch["tool_input"]["title"] = "LCH-640 runner fix"
    check("LCH PR exempt", decide(lch, wf, enforce), None)
    check("two lines, one missing: deny", decide(with_body(
        "LCH-600-Review: LC-12 accepted\nLCH-600-Review: LC-13 accepted", req + fb + resp), wf, enforce) is not None, True)
    other = with_body("")
    other["tool_input"]["repo"] = "bbm-guardrails"
    check("per-repo rules applied", decide(other, [ch("scripts/ci/x.py")], enforce), None)

    files = [{"filename": ".github/workflows/run-x.yml", "status": "added", "patch": "@@ +1 @@\n+on: workflow_dispatch"},
             {"filename": "scripts/run_selftests.sh", "status": "modified",
              "patch": "@@ -9 +9,2 @@\n+run_one b \\\n+    python3 b.py --selftest"}]
    check("connector files: additions pass", gated_changes(changed_files({"pr_files": files}, infra), infra), [])
    files2 = [{"filename": "scripts/run_selftests.sh", "status": "modified", "patch": "@@ -9 +9 @@\n-a\n+b"}]
    check("connector files: edit gated", gated_changes(changed_files({"pr_files": files2}, infra), infra), ["scripts/run_selftests.sh"])
    check("connector files: removed maps to D", changed_files({"pr_files": [{"filename": "a", "status": "removed"}]}, infra)[0]["status"], "D")
    check("connector files: junk entry unreadable", changed_files({"pr_files": [{"status": "added"}]}, infra), None)
    check("hunks: headers skipped", parse_hunks("--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n c"), (["a"], ["b"], [["b"]]))
    check("hunks: split per @@", parse_hunks("@@ -1 +1 @@\n+a\n@@ -9 +9 @@\n+b\n+c")[2], [["a"], ["b", "c"]])
    check("hunks: patch with no @@ is one hunk", parse_hunks("+a\n+b")[2], [["a", "b"]])
    check("connector: risk tiers stays gated (no base text)", gated_changes(changed_files({"pr_files": [
          {"filename": "scripts/ci/risk_tiers.json", "status": "modified", "patch": "@@ -1 +1,2 @@\n+x"}]}, infra), infra),
          ["scripts/ci/risk_tiers.json"])

    def fake(table):
        seen = []

        def run(argv):
            seen.append(argv)
            for k, v in table.items():
                if k in argv:
                    return v
            return (1, "")
        return run, seen

    ok = {"--show-toplevel": (0, "/repo\n"), "get-url": (0, "git@github.com:o/r.git\n"), "--verify": (0, ""),
          "--name-status": (0, "A\t.github/workflows/test-a.yml\nM\tscripts/run_selftests.sh\nD\told.sh\n"),
          "-U0": (0, "@@ -3 +3,2 @@\n+x\n")}
    show = {"origin/main:scripts/ci/risk_tiers.json": (0, '{"tier2": []}'), "b:scripts/ci/risk_tiers.json": (0, '{"tier2": ["z"]}')}
    tiers_ok = dict(ok, **{"--name-status": (0, "M\tscripts/ci/risk_tiers.json\n")}, **show)
    run, _ = fake(tiers_ok)
    got = changed_files({"tool_input": {"owner": "o", "repo": "r", "head": "b"}}, infra, run)
    check("git: json_grow reads base and head", (got[0]["base_text"], got[0]["head_text"]), ('{"tier2": []}', '{"tier2": ["z"]}'))
    check("git: json_grow file passes end to end", gated_changes(got, infra), [])
    run, _ = fake(dict(tiers_ok, **{"b:scripts/ci/risk_tiers.json": (128, "")}))
    got = changed_files({"tool_input": {"owner": "o", "repo": "r", "head": "b"}}, infra, run)
    check("git: unreadable head text keeps it gated", gated_changes(got, infra), ["scripts/ci/risk_tiers.json"])
    run, seen = fake(ok)
    got = changed_files({"tool_input": {"owner": "o", "repo": "r", "head": "o:lc1-x", "base": "main"}}, infra, run)
    check("git: statuses read", [(c["path"], c["status"]) for c in got],
          [(".github/workflows/test-a.yml", "A"), ("scripts/run_selftests.sh", "M"), ("old.sh", "D")])
    check("git: modified file's added lines read", got[1]["added"], ["x"])
    check("git: diff against base", any("origin/main...lc1-x" in a for a in seen), True)
    run, seen = fake(ok)
    changed_files({"tool_input": {"owner": "o", "repo": "r", "head": "b", "base": "dev"}}, infra, run)
    check("git: base honoured", any("origin/dev...b" in a for a in seen), True)
    run, _ = fake(dict(ok, **{"-U0": (128, "")}))
    check("git: failed hunk read gives None", changed_files({"tool_input": {"owner": "o", "repo": "r", "head": "b"}}, infra, run), None)
    run, _ = fake(dict(ok, **{"--name-status": (128, "")}))
    check("git: failed diff gives None", changed_files({"tool_input": {"owner": "o", "repo": "r", "head": "b"}}, infra, run), None)
    run, _ = fake(dict(ok, **{"--name-status": (0, "junkline\n")}))
    check("git: junk line skipped", changed_files({"tool_input": {"owner": "o", "repo": "r", "head": "b"}}, infra, run), [])
    run, _ = fake({"--show-toplevel": (0, "/repo\n"), "get-url": (0, "https://github.com/x/other\n")})
    check("wrong repo: None", changed_files({"tool_input": {"owner": "o", "repo": "r", "head": "b"}}, infra, run), None)
    run, _ = fake({"--show-toplevel": (0, "/repo\n"), "get-url": (0, "https://github.com/o/r\n")})
    check("unknown branch: None", changed_files({"tool_input": {"owner": "o", "repo": "r", "head": "b"}}, infra, run), None)
    run, _ = fake(ok)
    check("no head: None", changed_files({"tool_input": {"owner": "o", "repo": "r", "head": ""}}, infra, run), None)

    def by_dir(urls, top=(1, "")):
        def run(argv):
            if "--show-toplevel" in argv:
                return top
            if "get-url" in argv:
                return urls.get(argv[2], (1, ""))
            return (1, "")
        return run
    here = os.path.join(os.getcwd(), "r")
    check("no toplevel: falls back to <cwd>/<repo>", find_checkout("o", "r", by_dir({here: (0, "https://github.com/o/r")})), here)
    check("toplevel used first", find_checkout("o", "r", by_dir(
        {"/t": (0, "https://github.com/o/r"), here: (0, "https://github.com/o/r")}, top=(0, "/t\n"))), "/t")
    check("failed toplevel ignored", find_checkout("o", "r", by_dir({"/t": (0, "https://github.com/o/r")}, top=(1, "/t\n"))), None)
    check("failed get-url ignored", find_checkout("o", "r", by_dir({here: (1, "https://github.com/o/r")})), None)
    old_home = os.environ.get("HOME")
    os.environ["HOME"] = "/fake-home"
    try:
        check("home clone found", find_checkout("o", "r", by_dir({"/fake-home/r": (0, "https://github.com/o/r")})), "/fake-home/r")
    finally:
        if old_home is None:
            os.environ.pop("HOME", None)
        else:
            os.environ["HOME"] = old_home
    check("same_repo needs owner", same_repo("https://github.com//r", "", "r"), False)

    rlog = {"log": (0, "s1\tLC-1 tighten deploy\ns2\tLCH-9 runner fix\ns3\tLC-2 docs\ns4\tLC-3 tiers\n"),
            "s1^": None}

    def rrun(argv):
        if argv[1] == "log":
            return rlog["log"]
        sha = argv[-1] if argv[1] == "diff" and "--name-status" in argv else None
        if sha:
            return {"s1": (0, "M\t.github/workflows/deploy.yml\nbad\n"), "s2": (0, "M\t.github/workflows/deploy.yml\n"),
                    "s3": (0, "M\tREADME.md\n"), "s4": (0, "M\tscripts/ci/risk_tiers.json\n")}[sha]
        if argv[1] == "diff":
            return (0, "@@ -1 +1,2 @@\n+x")
        return (0, '{"tier2": []}') if argv[2].startswith("s4^") else (0, '{"tier2": ["z"]}')
    check("replay: gated, not exempt", replay("2026-11-17", rules, run=rrun), [("LC-1 tighten deploy", [".github/workflows/deploy.yml"])])
    rlog["log"] = (1, "s1\tLC-1 x\n")
    check("replay: failed log gives nothing", replay("2026-11-17", rules, run=rrun), [])

    def rrun_tiers(argv):
        if argv[1] == "log":
            return (0, "s4\tLC-3 tiers\n")
        if "--name-status" in argv:
            return (0, "M\tscripts/ci/risk_tiers.json\n")
        if argv[1] == "diff":
            return (0, "@@ -1 +1,2 @@\n+x")
        return (0, '{"tier0": []}') if argv[2].startswith("s4^") else (0, '{"tier0": ["z"]}')
    check("replay: reads base and head for json_grow", replay("d", rules, run=rrun_tiers), [("LC-3 tiers", ["scripts/ci/risk_tiers.json"])])
    check("replay: failed name-status gives no hits", replay("d", rules, run=lambda a: (0, "s\tLC-1\n") if a[1] == "log"
          else (1, "M\t.github/workflows/deploy.yml\n")), [])

    import tempfile
    with tempfile.TemporaryDirectory() as td:
        good = json.load(open(PATHS_FILE, encoding="utf-8"))
        for label, data in (("bad mode", dict(good, mode="loud")),
                            ("gate not a list", dict(good, default=dict(good["default"], gate="x"))),
                            ("empty pattern", dict(good, default=dict(good["default"], gate=[""]))),
                            ("rule map as a list", dict(good, default=dict(good["default"], new_ok=[]))),
                            ("unknown rule", dict(good, default=dict(good["default"], append_ok={"x": {"rule": "maybe"}}))),
                            ("bad shadow_until", dict(good, shadow_until="next week")),
                            ("repo missing a key", dict(good, repos={"o/r": {"gate": []}}))):
            f = os.path.join(td, "p.json")
            with open(f, "w") as fh:
                json.dump(data, fh)
            try:
                load_rules(f)
                check(f"paths.json {label} refused", False, True)
            except ValueError:
                check(f"paths.json {label} refused", True, True)
    many = [f"f{i}" for i in range(8)]
    check("long file list shortened", "and 2 more" in flow_text(many) and "f6" not in flow_text(many), True)
    check("short file list whole", "more)" in flow_text(many[:6]), False)
    check("_run captures text", _run([sys.executable, "-c", "print('x')"]), (0, "x\n"))
    me = os.path.abspath(__file__)

    def cli(stdin):
        r = subprocess.run([sys.executable, "-I", me], input=stdin, capture_output=True, text=True,
                           timeout=30, cwd=tempfile.gettempdir())
        return r.returncode, r.stdout.strip()
    check("cli: other tool is silent", cli(json.dumps({"tool_name": "mcp__github__merge_pull_request"})), (0, ""))
    rc, out = cli(json.dumps({"tool_name": "mcp__github__create_pull_request",
                              "tool_input": {"owner": "nobody", "repo": "no-such-repo-xyz", "head": "b", "title": "LC-1"}}))
    check("cli: no clone gives NOT CHECKED", rc == 0 and "NOT CHECKED" in out, True)
    rc, out = cli(json.dumps({"tool_name": "mcp__github__update_pull_request", "tool_input": {"title": "LC-1"},
                              "pr_files": [{"filename": ".github/workflows/deploy.yml", "status": "modified", "patch": "-a\n+b"}]}))
    check("cli: update with connector files is checked", rc == 0 and "SHADOW would-deny" in out, True)
    check("cli: junk input fails open", cli("nope")[0], 1)
    rc, out = cli(json.dumps({"tool_name": "mcp__github__update_pull_request",
                              "tool_input": {"owner": "brand-bridge-media", "repo": "bbm-guardrails", "title": "LC-1"},
                              "pr_files": [{"filename": "review_policy.json", "status": "modified", "patch": "-a\n+b"}]}))
    check("cli: the PR's own repo rules are used", rc == 0 and "SHADOW would-deny" in out, True)
    seen_since = []

    def since_run(argv):
        seen_since.append(argv)
        return (0, "s1\tLC-1 x\n") if argv[1] == "log" else (0, "M\t.github/workflows/deploy.yml\n")
    import contextlib
    import io
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        rc = replay_cli(["x", "--replay"], since_run)
    check("replay cli: defaults to the last 7 days", rc == 0 and "since 7 days ago" in buf.getvalue()
          and "--since=7 days ago" in seen_since[0], True)
    check("replay cli: lists each hit", "would-deny  LC-1 x  <- .github/workflows/deploy.yml" in buf.getvalue(), True)
    with contextlib.redirect_stdout(io.StringIO()):
        replay_cli(["x", "--replay", "--since", "2026-11-17"], since_run)
    check("cli mode: replay wins", cli_mode(["x", "--selftest", "--replay"]), "replay")
    check("cli mode: selftest", cli_mode(["x", "--selftest"]), "selftest")
    check("cli mode: hook by default", cli_mode(["x"]), "hook")
    check("replay cli: --since honoured", "--since=2026-11-17" in seen_since[-2], True)

    passed = sum(ok for _, ok in results)
    print(f"selftest: {passed}/{len(results)} checks passed")
    return 0 if passed == len(results) else 1


# LC-2207 waived: the mutation harness imports the module, so this guard cannot be mutated observably.
if __name__ == "__main__":
    sys.exit({"replay": lambda: replay_cli(sys.argv), "selftest": _selftest, "hook": main}[cli_mode(sys.argv)]())
