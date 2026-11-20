#!/usr/bin/env python3
"""PreToolUse gate: a PR that changes how code is tested, merged or deployed needs an LCH-600 review (LC-2207).

WHAT IT DOES. On a GitHub `create_pull_request`, or an `update_pull_request` that takes a PR out of draft,
it reads what the PR changes (the session's local clone: `git diff --name-status` plus `-U0` hunks; for an
update, the PR's own file list and patches from the connector). A change counts when it matches the repo's
`gate` patterns in hooks/paths.json and is not a pure addition the repo allows (`new_ok`: a brand-new file
such as a new `test-*.yml`; `append_ok`: a file that only gains lines, such as a new row in
`risk_tiers.json`). If anything counts, the PR body must carry a review line:

    LCH-600-Review: request <id> closed          (one per board request)
    LCH-600-Review: skipped <reason>             (urgent; the reason is the record, 10 characters or more)

THE REVIEW RUNS ON THE CROSS-TRACK REQUEST BOARD (LC-2257; LC-2265 moved it off Jira comments). The session
asks the `ci-speed` desk with `ask_track`, rings it, and closes the request once it agrees with the answer.
The board keeps the conversation, the clocks and the 3-response cap, and pauses the request for the operator
past the cap, so this gate no longer counts rounds. For a `request <id>` line this session must have READ that
`track_requests` row (an `execute_sql` result) showing track `ci-speed`, status `closed`, and at least one desk
response, or an operator close. A request the asker closed with no answer is a skip, not a review.

WHY. Operator decision (2026-11-17): every change to how code is tested, merged or deployed is reviewed by
the LCH-600 program (Deploy and CI speed) before a session acts on it. The trigger is the files, not the
project. Operator decision (2026-11-19): the review goes through the request board, because Jira comments
lost state (LC-1991: an accepted answer closed the request and the requester never learned it arrived).

MODE. paths.json `mode`: `shadow` (the default while it beds in) only warns, with a note that starts
`[mod:lch600-review-gate] SHADOW would-deny`, which register.ts toasts so session-close counts it;
`enforce` denies. The CI step that makes this authoritative is LC-2209; the mod is the early warning.

EXEMPT. A PR title that STARTS with an LCH key, or a branch named `lch<N>-...` (incidents, LCH-600's work).
Pushing a branch is never gated: sessions push to save work in an ephemeral container.

WHAT IT CANNOT SEE. A PreToolUse hook gets no transcript, so register.ts records the Supabase reads this gate
needs and hands them over as `transcript_rows`. After a container restart, re-read the row: one query is enough.

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
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import transcript_reader  # noqa: E402

TAG = "[mod:lch600-review-gate]"
PATHS_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "paths.json")
EXEMPT_TITLE = re.compile(r"^\s*LCH-\d+\b", re.I)
EXEMPT_BRANCH = re.compile(r"^lch-?\d+", re.I)
# LC-2265: the review is a row on the cross-track request board (LC-2257), so the PR line names that row.
LINE_RE = re.compile(r"^\s*LCH-600-Review:\s*request\s+#?(\d+)\s+closed\b", re.I | re.M)
# A skip carries its reason in the PR body, where anyone reading the PR sees it (it was a Jira comment before).
SKIP_RE = re.compile(r"^\s*LCH-600-Review:\s*skipped\b[\s:,-]*(\S.{9,})$", re.I | re.M)
DESK, REQUEST_TYPE = "ci-speed", "speed-review"  # track_desks.track and its request type
SQL_TOOL = re.compile(r"^mcp__Supabase\w*__execute_sql$")
# One list defines "approved", shared with plan_stage.py (LC-2265 desk item 1).
APPROVED = ("accepted", "ship_after_fixes")
TICKET = re.compile(r"\b([A-Z][A-Z0-9]+)-(\d+)\b")
BRANCH_TICKET = re.compile(r"^([a-z][a-z0-9]*?)-?(\d+)-", re.I)
BOARD_DOC = "scripts/track-requests/README.md (LCH-600 review: .github/MERGE-QUEUE.md)"
STEP_TIMEOUT = 8


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
    """("request", "<id>") per `LCH-600-Review: request <id> closed`, ("skipped", "<reason>") per skip line."""
    body = body or ""
    return ([("request", n) for n in LINE_RE.findall(body)]
            + [("skipped", why.strip()) for why in SKIP_RE.findall(body)])


# ---- board evidence -------------------------------------------------------------------------------------------------

def board_rows(text: str) -> list[dict]:
    """Every JSON object that looks like a track_requests row (has `id` and `status`) in an execute_sql result.

    The Supabase connector wraps the rows as a JSON array inside a `result` string, between untrusted-data tags, so
    this scans for arrays rather than trusting one shape. A result it cannot read gives nothing, never a pass."""
    outer = _json(text)
    if isinstance(outer, dict) and isinstance(outer.get("result"), str):
        text = outer["result"]
    found, dec, i = [], json.JSONDecoder(), 0
    while True:
        i = text.find("[", i)
        if i < 0:
            return found
        try:
            val, end = dec.raw_decode(text, i)
        except ValueError:
            i += 1
            continue
        if isinstance(val, list):
            found += [r for r in val if isinstance(r, dict) and "id" in r and "status" in r]
        i = end


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


def evidence(rows: list[dict]) -> dict[str, dict]:
    """Request id -> the LAST board row this session read for it (later reads win: a request moves on)."""
    seen: dict[str, dict] = {}
    for name, inp, text in transcript_reader.tool_calls_with_results(rows):
        rid = read_id(str((inp if isinstance(inp, dict) else {}).get("query") or ""))
        if not SQL_TOOL.match(name or "") or rid is None:
            continue
        for r in board_rows(text):
            if str(r["id"]) != rid:  # the row must be the one the query asked for (desk item 2a)
                continue
            seen[str(r["id"])] = r
    return seen


def _count(v) -> int:
    try:
        return int(v)
    except (TypeError, ValueError):
        return 0


READ_ROW = ("select r.id, r.track, r.ticket_key, r.status, r.responses, r.closed_by, r.asked_by_session, "
            "m.author_session as answered_by, m.payload->>'verdict' as verdict from public.track_requests r "
            "left join lateral (select author_session, payload from public.track_request_messages where request_id = "
            "r.id and kind = 'response' order by seq desc limit 1) m on true where r.id = {id};")


def _norm(q: str) -> str:
    return re.sub(r"\s+", " ", q).strip().rstrip(";").strip()


READ_ROW_EXACT = re.compile("^" + re.escape(_norm(READ_ROW)).replace(re.escape("{id}"), r"(\d+)") + "$")


def read_id(query: str) -> str | None:
    """The request id when `query` is exactly READ_ROW (whitespace and a trailing `;` aside), else None.

    An allowlist of one text, not a denylist: aliases, casts, functions, comments or a second statement can each make
    a hand-written SELECT print a good-looking row, so any other query is no board read (LC-2265 desk round 2)."""
    m = READ_ROW_EXACT.match(_norm(query))
    return m.group(1) if m else None


def pr_tickets(title, head) -> set[str]:
    """Jira keys the PR names: any KEY-N in its title, and the key a `lc2265-...` branch starts with."""
    keys = {f"{a}-{n}" for a, n in TICKET.findall(str(title or ""))}
    m = BRANCH_TICKET.match(str(head or "").split(":", 1)[-1].strip())
    if m:
        keys.add(f"{m.group(1).upper()}-{m.group(2)}")
    return keys


def missing_evidence(lines: list[tuple[str, str]], rows: list[dict], tickets: set[str] | None = None) -> list[str]:
    seen = evidence(rows)
    gaps = []
    for kind, val in lines:
        if kind == "skipped":
            continue  # the reason in the PR body is the record; review_lines already required one
        row = seen.get(val)
        read = "`" + READ_ROW.format(id=val) + "`"
        if row is None:
            gaps.append(f"request {val}: this session has not read it from the board. Run {read}")
            continue
        if row.get("track") != DESK:
            gaps.append(f"request {val}: it went to the `{row.get('track')}` desk, not `{DESK}` (read it with {read}, "
                        "which returns the track)")
            continue
        status = row.get("status")
        if status == "open":
            gaps.append(f"request {val}: still open, waiting on the desk. Wait for its ring back (the board marks a "
                        "late desk overdue), then re-read the row")
        elif status == "responded":
            gaps.append(f"request {val}: the desk has answered. Read it (`select seq, kind, body, link from "
                        f"public.track_request_messages where request_id = {val} order by seq;`), then "
                        f"`select public.close_request({val}, '<your session id>', '<one-line resolution>');` or "
                        "follow_up, and re-read the row")
        elif status == "paused":
            gaps.append(f"request {val}: paused after the desk's last allowed response, so the operator decides. Post "
                        "the follow_up's tell_operator text as NEEDS YOU; their ruling (rule_on_request) closes or "
                        "re-opens it")
        elif status != "closed":
            gaps.append(f"request {val}: status `{status}` is not closed")
        elif row.get("closed_by") == "operator":
            pass  # the operator's ruling closes it whatever the desk said
        elif _count(row.get("responses")) < 1:
            gaps.append(f"request {val}: closed with no answer from the desk. That is a skip, not a review: use "
                        "`LCH-600-Review: skipped <reason>`")
        elif "verdict" not in row or "answered_by" not in row:
            gaps.append(f"request {val}: the read does not show the desk's verdict and who gave it. Re-read it with {read}")
        elif row.get("verdict") not in APPROVED:
            gaps.append(f"request {val}: the desk's last answer is `{row.get('verdict')}`, not accepted or "
                        "ship_after_fixes. Closing it does not turn that into an approval: fix what it asked, then "
                        f"`follow_up({val}, ...)` for a re-check")
        elif not row.get("answered_by") or row.get("answered_by") == row.get("asked_by_session"):
            gaps.append(f"request {val}: the answer was written by the session that asked. The desk answers, not "
                        "the asker")
        elif tickets is not None and row.get("ticket_key") not in tickets:
            gaps.append(f"request {val}: it was asked for `{row.get('ticket_key')}`, but this PR names "
                        f"{', '.join(sorted(tickets)) or 'no ticket'} in its title or branch. Cite this PR's own "
                        "request, or put its ticket key in the title")
    return gaps


# ---- the decision ---------------------------------------------------------------------------------------------------

def flow_text(files: list[str], ask_seconds: bool = False) -> str:
    shown = ", ".join(files[:6]) + (f" and {len(files) - 6} more" if len(files) > 6 else "")
    return (
        f"This PR changes how code is tested, merged or deployed ({shown}), so the Deploy and CI speed desk "
        f"(LCH-600) reviews it first (operator decision 2026-11-17, LC-2207). Pushing the branch is fine. The review "
        f"runs on the cross-track request board: {BOARD_DOC}.\n"
        f"1. Ask: `select public.ask_track('{DESK}', '{REQUEST_TYPE}', '<what changes and why, the files, the "
        "expected effect on PR wait time, links to the stories and the branch>', '<your session id>', "
        "'<ticket key>', p_asker_track => '<your project desk, e.g. tools-services>');` Your session id: get_session "
        "with no arguments. The project desk is required (LC-2321).\n"
        "2. Ring the desk: send the result's `ring.message` to `ring.session_id` with send_message, then "
        "`select public.mark_delivered(<request_id>, true);` (the track-doorbell mod holds the turn until you do). "
        "Never ask the operator to relay it.\n"
        "3. Wait for the desk's ring back. Set one send_later check-in at the result's `answer_due_at`; no polling.\n"
        "4. Read the answer (`select seq, kind, body, link from public.track_request_messages where request_id = <id> "
        "order by seq;`). Agree: `select public.close_request(<id>, '<your session id>', '<one-line resolution>');`. "
        "Disagree: `select public.follow_up(<id>, '<your session id>', '<your evidence>');` and wait again. The desk "
        "answers at most 3 times; a follow-up after that pauses the request and the board emails the operator: post "
        "its `tell_operator` text as NEEDS YOU.\n"
        f"5. Read the closed row (`{READ_ROW.format(id='<id>')}`), add `LCH-600-Review: request <id> closed` to the "
        "PR body, and repeat this call.\n"
        "A T2 PR: finish this review before the approval request goes out, so the operator approves once. Urgent: "
        "`LCH-600-Review: skipped <reason, 10 characters or more>`. A PR titled with an LCH key is exempt."
        + ("\nThis PR adds or changes a check that runs on every PR: the question must state the seconds it adds "
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
                f"test-runner files it still needs an LCH-600 review (LC-2207). Protocol: {BOARD_DOC}."}}
    # LC-2207 waived: a missing owner/repo falls to the default rules either way ("" or "None"), an equivalent mutant.
    r = payload_rules(payload, rules)
    hit = gated_changes(changes, r)
    if not hit:
        return None
    lines = review_lines(str(inp.get("body") or ""))
    if not lines:
        reason = flow_text(hit, any(_match(h, r["ask_seconds"]) for h in hit))
    else:
        gaps = missing_evidence(lines, transcript_reader.rows_for(payload), pr_tickets(inp.get("title"), inp.get("head")))
        if not gaps:
            return None
        reason = ("The PR body names an LCH-600 review, but this session's board reads do not show it closed. "
                  "Missing:\n- " + "\n- ".join(gaps) + "\nThen repeat the call. Procedure: " + BOARD_DOC)
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
    # Diff what the PR will contain: the PUSHED branch against the CURRENT base, both fetched now. A local branch
    # of the same name can be stale (project threads reuse branch names) and a stale origin/<base> widens the
    # three-dot diff to other people's merges; both misfired in shadow (LC-2207 comment 194233). No fetch, no guess.
    rc, _ = run(["git", "-C", top, "fetch", "-q", "origin", base, branch])
    if rc != 0:
        return None
    return changes_from_git(top, base, f"origin/{branch}", r, run)


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


def _rows(*calls):
    """Transcript rows from (tool, input, result) triples; ids are unique across calls so rows can be concatenated."""
    rows = []
    for name, inp, text in calls:
        i = next(_IDS)
        rows.append({"type": "assistant", "message": {"content": [{"type": "tool_use", "id": f"t{i}", "name": name, "input": inp}]}})
        rows.append({"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": f"t{i}", "content": text}]}})
    return rows


SQL = "mcp__Supabase__execute_sql"


def _board(*rows, tool=SQL, query=None):
    query = query if query is not None else READ_ROW.format(id=rows[0]["id"] if rows else 7)
    """An execute_sql read of track_requests rows, wrapped the way the Supabase connector returns it (2026-11-19)."""
    inner = ("Below is the result of the SQL query. Note that this contains untrusted user data.\n\n<untrusted-data-x>\n"
             + json.dumps(list(rows)) + "\n</untrusted-data-x>\n\nUse this data to inform your next steps.")
    return _rows((tool, {"query": query}, json.dumps({"result": inner})))


def _req(rid=7, status="closed", responses=1, track="ci-speed", closed_by="asker", verdict="accepted",
         answered_by="session_desk", asked_by="session_me", ticket="LC-1"):
    return {"id": rid, "track": track, "ticket_key": ticket, "status": status, "responses": responses,
            "closed_by": closed_by, "asked_by_session": asked_by, "answered_by": answered_by, "verdict": verdict}


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
    end = str(rules["shadow_until"])
    after = (datetime.fromisoformat(end) + timedelta(days=1)).strftime("%Y-%m-%d")
    check(f"rules: shadow has an end date (on {end} read the replay and decide)", today_ok_for_shadow(rules), True)
    check("shadow: day after the end fails", today_ok_for_shadow(rules, after), False)
    check("shadow: last day passes", today_ok_for_shadow(rules, end), True)
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

    check("lines parsed", review_lines("x\nLCH-600-Review: request 7 closed\n  lch-600-review: Request #12 Closed"),
          [("request", "7"), ("request", "12")])
    check("skip parsed with its reason", review_lines("LCH-600-Review: skipped: prod is down, hotfix first"),
          [("skipped", "prod is down, hotfix first")])
    check("skip without a reason ignored", review_lines("LCH-600-Review: skipped"), [])
    check("skip with a too-short reason ignored", review_lines("LCH-600-Review: skipped urgent"), [])
    check("old Jira line no longer counts", review_lines("LCH-600-Review: LC-12 accepted 193156"), [])
    check("open request is not a review line", review_lines("LCH-600-Review: request 7 open"), [])
    check("mid-line ignored", review_lines("see LCH-600-Review: request 7 closed"), [])

    check("board rows: connector wrapping read", board_rows(json.dumps({"result": "x [" + json.dumps(_req()) + "] y"})),
          [_req()])
    check("board rows: plain JSON array", board_rows(json.dumps([_req(), {"other": 1}])), [_req()])
    check("board rows: unreadable gives nothing", board_rows("no rows [not json"), [])
    check("board rows: a nested array inside a row is still one row", len(board_rows(json.dumps(
          {"result": json.dumps([dict(_req(), tags=["a", "b"])])}))), 1)
    check("board rows: a non-array value skipped", board_rows('{"x": [1, 2]} ' + json.dumps([_req()])), [_req()])

    check("closed with an answer: no gap", missing_evidence([("request", "7")], _board(_req())), [])
    check("operator close without an answer: no gap",
          missing_evidence([("request", "7")], _board(_req(responses=0, closed_by="operator"))), [])
    check("clock close after an answer: no gap",
          missing_evidence([("request", "7")], _board(_req(closed_by="clock"))), [])
    check("Supabase_Muni connector counts too",
          missing_evidence([("request", "7")], _board(_req(), tool="mcp__Supabase_Muni__execute_sql")), [])
    check("a row printed by a query not on track_requests is no read (review finding 1)",
          bool(missing_evidence([("request", "7")], _board(_req(), query="select 7 as id, 'ci-speed' as track, 'closed' as status"))), True)
    check("a track_requests query that unions in its own row is no read",
          bool(missing_evidence([("request", "7")], _board(_req(), query="select id, status from public.track_requests where false union select 7, 'closed'"))), True)
    check("the view v_track_requests is not the table",
          bool(missing_evidence([("request", "7")], _board(_req(), query="select * from public.v_track_requests where id = 7"))), True)
    check("any other query on track_requests is no read (desk round 2: exact text only)",
          "not read it" in " ".join(missing_evidence([("request", "7")], _board(_req(), query="select * from track_requests where id = 7"))), True)
    check("an implicit alias forges nothing",
          "not read it" in " ".join(missing_evidence([("request", "7")], _board(_req(), query=READ_ROW.format(id=7).replace("r.status,", "'closed' status,")))), True)
    check("a comment hiding the WHERE forges nothing",
          "not read it" in " ".join(missing_evidence([("request", "7")], _board(_req(), query=READ_ROW.format(id=7)[:-1] + " -- where r.id = 7"))), True)
    check("whitespace and the trailing ; do not matter",
          missing_evidence([("request", "7")], _board(_req(), query="  " + READ_ROW.format(id=7).replace(" ", "\n  ")[:-1] + "  ")), [])
    check("a changed literal is not the read", read_id(READ_ROW.format(id=7).replace("'response'", "'RESPONSE'")), None)
    check("read_id: the id", read_id(READ_ROW.format(id=42)), "42")
    check("read_id: a second statement is not the read", read_id(READ_ROW.format(id=7) + " select 1;"), None)
    check("closed after a not_yet answer: gap (desk item 1)",
          "not_yet" in " ".join(missing_evidence([("request", "7")], _board(_req(verdict="not_yet")))), True)
    check("closed after a needs_info answer: gap",
          "needs_info" in " ".join(missing_evidence([("request", "7")], _board(_req(verdict="needs_info")))), True)
    check("ship_after_fixes passes", missing_evidence([("request", "7")], _board(_req(verdict="ship_after_fixes"))), [])
    check("operator close passes whatever the verdict",
          missing_evidence([("request", "7")], _board(_req(verdict="not_yet", closed_by="operator"))), [])
    check("an answer the asker wrote: gap (desk item 2c)",
          "session that asked" in " ".join(missing_evidence([("request", "7")], _board(_req(answered_by="session_me")))), True)
    check("no answer author: gap",
          "session that asked" in " ".join(missing_evidence([("request", "7")], _board(_req(answered_by=None)))), True)
    check("an old read without the verdict: re-read",
          "Re-read" in " ".join(missing_evidence([("request", "7")], _board({k: v for k, v in _req().items() if k != "verdict"}))), True)
    check("another ticket's request: gap (desk item 2b)",
          "asked for `LC-9`" in " ".join(missing_evidence([("request", "7")], _board(_req(ticket="LC-9")), {"LC-1"})), True)
    check("a PR naming no ticket says so",
          "names no ticket" in " ".join(missing_evidence([("request", "7")], _board(_req()), set())), True)
    check("this PR's ticket: no gap", missing_evidence([("request", "7")], _board(_req()), {"LC-1", "LCH-3"}), [])
    check("a row for another id than the query asked: no read",
          "not read it" in " ".join(missing_evidence([("request", "7")], _board(_req(), query=READ_ROW.format(id=8)))), True)
    check("a numeric alias forges nothing",
          "not read it" in " ".join(missing_evidence([("request", "7")], _board(_req(), query="select 7 as id, * from track_requests where id = 7"))), True)
    check("pr_tickets: title keys", pr_tickets("LC-2265 LCH-600: x", "claude/x"), {"LC-2265", "LCH-600"})
    check("pr_tickets: branch key", pr_tickets("no key", "owner:lc2265-board-review"), {"LC-2265"})
    check("pr_tickets: nothing", pr_tickets("", "claude/project-thread-0qvfcu"), set())
    check("skip needs no board read", missing_evidence([("skipped", "prod is down, hotfix first")], []), [])
    g = " ".join(missing_evidence([("request", "7")], []))
    check("never read: names the query", "not read it" in g and "where r.id = 7" in g, True)
    g = " ".join(missing_evidence([("request", "8")], _board(_req())))
    check("another request's row does not count", "not read it" in g, True)
    g = " ".join(missing_evidence([("request", "7")], _board(_req(track="catalog"))))
    check("wrong desk", "`catalog` desk" in g, True)
    g = " ".join(missing_evidence([("request", "7")], _board(_req(status="open", responses=0))))
    check("open: waiting on the desk", "waiting on the desk" in g, True)
    g = " ".join(missing_evidence([("request", "7")], _board(_req(status="responded"))))
    check("responded: read the answer and close", "close_request(7" in g, True)
    g = " ".join(missing_evidence([("request", "7")], _board(_req(status="paused", responses=3))))
    check("paused: operator decides", "NEEDS YOU" in g, True)
    g = " ".join(missing_evidence([("request", "7")], _board(_req(status="weird"))))
    check("unknown status: not closed", "not closed" in g, True)
    g = " ".join(missing_evidence([("request", "7")], _board(_req(responses=0))))
    check("asker closed with no answer: a skip, not a review", "skipped <reason>" in g, True)
    g = " ".join(missing_evidence([("request", "7")], _board(_req(responses=None))))
    check("unreadable responses count as none", "skipped <reason>" in g, True)
    check("a later read wins (request moved on)",
          missing_evidence([("request", "7")], _board(_req(status="open", responses=0)) + _board(_req())), [])
    check("a later read wins the other way too", len(missing_evidence([("request", "7")],
          _board(_req()) + _board(_req(status="paused", responses=3)))), 1)
    check("a non-Supabase tool does not count", len(missing_evidence([("request", "7")],
          _board(_req(), tool="mcp__Atlassian__getJiraIssue"))), 1)
    check("two requests, one missing: one gap", len(missing_evidence([("request", "7"), ("request", "9")],
          _board(_req()))), 1)

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
    why = d["permissionDecisionReason"]
    check("enforce, no line: deny", d.get("permissionDecision"), "deny")
    check("deny names the mod", why.startswith(TAG), True)
    check("deny asks the ci-speed desk on the board", "ask_track('ci-speed', 'speed-review'" in why, True)
    check("deny: the board names who to ring, no hard-coded desk id",
          "ring.session_id" in why and "session_01" not in why and "paste" not in why, True)
    check("deny: no polling, one check-in at the answer clock", "answer_due_at" in why and "no polling" in why, True)
    check("deny: the board caps rounds and the operator decides", "at most 3 times" in why and "NEEDS YOU" in why
          and "follow_up" in why and "close_request" in why, True)
    check("deny: no Jira comment steps left", "[LCH-600" in why or "Jira" in why, False)
    check("deny points to the board procedure", "scripts/track-requests/README.md" in why, True)
    check("deny names the PR line", "LCH-600-Review: request <id> closed" in why, True)
    check("deny orders it before T2 approval", "T2" in why, True)
    check("plain gate: no seconds question", "seconds" in why, False)
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
    check("closed request read: allow", decide(with_body("LCH-600-Review: request 7 closed", _board(_req())), wf,
                                               enforce), None)
    check("skip with a reason: allow", decide(with_body("LCH-600-Review: skipped prod is down, hotfix first"), wf,
                                              enforce), None)
    d2 = decide(with_body("LCH-600-Review: request 7 closed", _board(_req(status="responded"))), wf,
                enforce)["hookSpecificOutput"]
    check("line without a closed row: deny", d2.get("permissionDecision"), "deny")
    check("line without a closed row: names the gap", "close_request(7" in d2["permissionDecisionReason"], True)
    check("old Jira line: treated as no line", "ask_track" in decide(with_body(
          "LCH-600-Review: LC-12 accepted 193156"), wf, enforce)["hookSpecificOutput"]["permissionDecisionReason"], True)
    lch = with_body("")
    lch["tool_input"]["title"] = "LCH-640 runner fix"
    check("LCH PR exempt", decide(lch, wf, enforce), None)
    check("two lines, one missing: deny", decide(with_body(
        "LCH-600-Review: request 7 closed\nLCH-600-Review: request 9 closed", _board(_req())), wf, enforce) is not None,
        True)
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
          "-U0": (0, "@@ -3 +3,2 @@\n+x\n"), "fetch": (0, "")}
    show = {"origin/main:scripts/ci/risk_tiers.json": (0, '{"tier2": []}'),
            "origin/b:scripts/ci/risk_tiers.json": (0, '{"tier2": ["z"]}')}
    tiers_ok = dict(ok, **{"--name-status": (0, "M\tscripts/ci/risk_tiers.json\n")}, **show)
    run, _ = fake(tiers_ok)
    got = changed_files({"tool_input": {"owner": "o", "repo": "r", "head": "b"}}, infra, run)
    check("git: json_grow reads base and head", (got[0]["base_text"], got[0]["head_text"]), ('{"tier2": []}', '{"tier2": ["z"]}'))
    check("git: json_grow file passes end to end", gated_changes(got, infra), [])
    run, _ = fake(dict(tiers_ok, **{"origin/b:scripts/ci/risk_tiers.json": (128, "")}))
    got = changed_files({"tool_input": {"owner": "o", "repo": "r", "head": "b"}}, infra, run)
    check("git: unreadable head text keeps it gated", gated_changes(got, infra), ["scripts/ci/risk_tiers.json"])
    run, seen = fake(ok)
    got = changed_files({"tool_input": {"owner": "o", "repo": "r", "head": "o:lc1-x", "base": "main"}}, infra, run)
    check("git: statuses read", [(c["path"], c["status"]) for c in got],
          [(".github/workflows/test-a.yml", "A"), ("scripts/run_selftests.sh", "M"), ("old.sh", "D")])
    check("git: modified file's added lines read", got[1]["added"], ["x"])
    check("git: diff of the pushed branch against base", any("origin/main...origin/lc1-x" in a for a in seen), True)
    check("git: base and branch fetched first", ["git", "-C", "/repo", "fetch", "-q", "origin", "main", "lc1-x"] in seen, True)
    run, _ = fake(dict(ok, fetch=(1, "")))
    check("git: failed fetch gives None (no guess from stale refs)",
          changed_files({"tool_input": {"owner": "o", "repo": "r", "head": "b"}}, infra, run), None)
    run, seen = fake(ok)
    changed_files({"tool_input": {"owner": "o", "repo": "r", "head": "b", "base": "dev"}}, infra, run)
    check("git: base honoured", any("origin/dev...origin/b" in a for a in seen), True)
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
