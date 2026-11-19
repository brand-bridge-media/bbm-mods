#!/usr/bin/env python3
"""Plan-stage half of the LCH-600 review (LCH-744): no build of a CI, deploy or guardrail change without a permit.

WHAT IT DOES. On a session's edit (Write, Edit, MultiEdit, NotebookEdit) of a file that the PR-stage gate would
review (paths.json `gate`, minus the pure-addition and generated-file rules), it holds the edit until the LCH-600
speed desk has approved the session's PLAN. The permit is in this session's own recorded calls:
  * board: a read of `v_track_request_messages` whose newest `ci-speed` response carries verdict `accepted` or
    `ship_after_fixes` (the desk's `respond` payload); `not_yet` / `needs_info` mean revise and follow up;
  * Jira: the session's `[LCH-600 review request]` comment and a `[LCH-600 feedback]` comment read after it;
  * `Skipping LCH-600 review: <reason>` on the ticket (urgent fixes; the reason is on record).
Until then each gated edit is denied with the next step: post the plan, or wait for the answer and read it.

WHY. Operator decision (2026-11-19, LCH-744): "no one starts building without the building permit". The PR-stage gate
(LC-2207) reviews code that already exists, so a design that slows every PR or weakens a gate was found after it was
built. The desk answers plan requests first (target 15 minutes); a plan it approved turns the PR-stage review into
a short "does the diff match the plan" check, so the total review time does not grow.

SCOPE TEST. The same file list as the PR gate, so the two can never disagree about what is speed-sensitive. Files
the PR gate passes as pure additions (a new dispatch-only test workflow, a new risk_tiers row, a selftest block)
and generated files are never asked about here: they are registrations, not designs. Exempt: a branch named
`lch<N>-...` (LCH-600's own work and incidents), the same exemption the PR gate uses.

MODE. paths.json `plan.mode`: `enforce` (shipped, operator decision 2026-11-19: no shadow week) denies the edit;
`shadow` is the kill switch short of disabling the mod: one `SHADOW would-ask-plan` note per session, until
`plan.shadow_until` (the selftest fails after that date while still in shadow).

FAIL OPEN. Unreadable input, a file outside any git checkout, a bad paths.json or any exception allows the edit.
Self-test: python3 plan_stage.py --selftest
"""
from __future__ import annotations

import importlib.util
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location("lch600_review_gate", os.path.join(HERE, "lch600-review-gate.py"))
gate = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(gate)  # type: ignore[union-attr]
sys.path.insert(0, HERE)
import transcript_reader  # noqa: E402

TAG = gate.TAG
EDIT_TOOLS = ("Write", "Edit", "MultiEdit", "NotebookEdit")
DESK_SESSION = "session_01LpqYrCPF63BFU9BJKCpLK7"
RUBRIC = "scripts/ci/lch600_review_desk.md (Plan review rubric)"
ASK_SQL = re.compile(r"ask_track\s*\(\s*'ci-speed'", re.I)
SQL_TOOL = re.compile(r"^mcp__Supabase\w*__execute_sql$")
SEND_TOOL = re.compile(r"^mcp__claude-code-remote__send_message$")
STEP_TIMEOUT = 5


def plan_rules(rules: dict) -> dict:
    p = rules.get("plan")
    if not isinstance(p, dict) or p.get("mode") not in ("shadow", "enforce"):
        raise ValueError("paths.json: plan.mode must be shadow or enforce")
    if not gate._when(str(p.get("shadow_until")) + "T00:00:00+00:00"):
        raise ValueError("paths.json: plan.shadow_until must be YYYY-MM-DD")
    return p


def plan_shadow_ok(p: dict, today: str | None = None) -> bool:
    today = today or datetime.now(timezone.utc).strftime("%Y-%m-%d")
    return p["mode"] != "shadow" or today <= str(p["shadow_until"])


def asks_plan(rel: str, r: dict) -> bool:
    """True when a change to `rel` is a design the desk should see: gated, and not a registration-only path."""
    if not gate._match(rel, r["gate"]):
        return False
    return not any(gate._rule_for(rel, r[k]) for k in gate.RULE_KEYS)


def _failed(text: str) -> bool:
    return bool(re.search(r'"?(error|isError)"?\s*[:=]\s*(true|")', text or "", re.I))


VERDICT = re.compile(r'\\?"verdict\\?"\s*:\s*\\?"(accepted|ship_after_fixes|not_yet|needs_info)\\?"')
MESSAGES = re.compile(r"track_request_messages", re.I)


def permit(rows: list[dict]) -> str:
    """'granted' (approved or skipped), 'posted' (plan sent, answer not yet read as approved) or 'none'."""
    state = "none"
    for name, inp, text in transcript_reader.tool_calls_with_results(rows):
        inp = inp if isinstance(inp, dict) else {}
        q = str(inp.get("query") or "")
        if SQL_TOOL.match(name) and ASK_SQL.search(q) and not _failed(text):
            state = "posted" if state == "none" else state
        elif SEND_TOOL.match(name) and str(inp.get("session_id") or "") == DESK_SESSION and "PLAN:" in str(inp.get("message") or ""):
            state = "posted" if state == "none" else state
        elif SQL_TOOL.match(name) and MESSAGES.search(q) and "ci-speed" in text:
            # The newest read decides: a later not_yet after an earlier accept takes the permit back.
            verdicts = VERDICT.findall(text)
            if verdicts:
                state = "granted" if set(verdicts) <= {"accepted", "ship_after_fixes"} else "posted"
    # Jira: the gate's own reader, so a write only counts when Jira returned its comment id, and feedback the
    # session wrote itself never counts.
    for s in gate.evidence(rows).values():
        if s["skipped"]:
            return "granted"
        if s["requests"]:
            first = gate._first(s, s["requests"])
            if first and gate._feedback_after(s, first):
                return "granted"
            state = "posted" if state == "none" else state
    return state


def _run(argv: list) -> tuple[int, str]:
    try:
        r = subprocess.run(argv, capture_output=True, text=True, timeout=STEP_TIMEOUT)
        return r.returncode, r.stdout
    except (OSError, subprocess.SubprocessError):
        return 127, ""


def locate(path: str, run=_run) -> tuple[str, str, str, str] | None:
    """(owner, repo, repo-relative path, branch) of a file, or None outside a GitHub checkout. The file may not exist yet."""
    if not path:
        return None
    d = os.path.dirname(os.path.abspath(path))
    while d and not os.path.isdir(d):
        d = os.path.dirname(d)
    rc, top = run(["git", "-C", d or "/", "rev-parse", "--show-toplevel"])
    top = top.strip()
    if rc != 0 or not top:
        return None
    rc, url = run(["git", "-C", top, "remote", "get-url", "origin"])
    m = re.search(r"[:/]([^/:]+)/([^/]+?)(?:\.git)?/?$", url.strip()) if rc == 0 else None
    if not m:
        return None
    _, branch = run(["git", "-C", top, "rev-parse", "--abbrev-ref", "HEAD"])
    rel = os.path.relpath(os.path.abspath(path), top)
    return m.group(1), m.group(2), rel, branch.strip()


READ_ANSWER = ("execute_sql `select request_id, kind, payload->>'verdict' as verdict, track, body from "
               "public.v_track_request_messages where request_id = <id> and kind = 'response' order by seq desc limit 1;`")


def ask_text(rel: str, state: str = "none") -> str:
    head = (f"BUILDING PERMIT (LCH-744): {rel} changes how code is tested, merged or deployed. No session builds such a "
            "change before LCH-600 (Deploy and CI speed) approves its plan (operator decision 2026-11-19).\n")
    if state == "posted":
        return head + (
            "Your plan is posted; the permit is the desk's answer. Do work that does not touch these files meanwhile "
            f"(the desk's target is 15 minutes). When the desk rings back, read its answer: {READ_ANSWER} "
            "`accepted` or `ship_after_fixes`: build, applying its points. `not_yet` or `needs_info`: revise the plan, "
            "`select public.follow_up(<id>, '<your session id>', 'PLAN v2: <what changed>');`, ring the desk again "
            "and wait. No answer after 60 minutes: give the operator a NEEDS YOU line naming the request id.\n"
            "Urgent fix that cannot wait: comment `Skipping LCH-600 review: <reason>` on the ticket.")
    return head + (
        "1. Post the plan (about a minute): execute_sql `select public.ask_track('ci-speed', 'speed-review', 'PLAN: "
        "<ticket>: <what you will change and why; the files; seconds added per PR and which check it replaces; "
        "anything it loosens; runner label and worst-case runtime; rollout and back-out>', '<your session id>', "
        "'<ticket>');`, then send_message the `ring` it returns and run `mark_delivered`. No execute_sql? "
        f"send_message {DESK_SESSION} a message starting `PLAN:` with the same content.\n"
        f"2. Check your plan against the rubric in {RUBRIC} while you wait; do work that does not touch these files.\n"
        f"3. When the desk rings back, read its answer: {READ_ANSWER} The permit is `accepted` or `ship_after_fixes`.\n"
        "Urgent fix that cannot wait: comment `Skipping LCH-600 review: <reason>` on the ticket. A branch named "
        "lch<N>-... is exempt.")


def decide(payload: dict, rules: dict, run=_run) -> dict | None:
    """The hook answer for one edit, or None to allow silently."""
    inp = payload.get("tool_input") or {}
    where = locate(str(inp.get("file_path") or inp.get("notebook_path") or ""), run)
    if not where:
        return None
    owner, repo, rel, branch = where
    if gate.EXEMPT_BRANCH.match(branch) or not asks_plan(rel, gate.repo_rules(rules, owner, repo)):
        return None
    state = permit(transcript_reader.rows_for(payload))
    if state == "granted":
        return None
    p = plan_rules(rules)
    if p["mode"] == "enforce":
        return {"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny",
                                       "permissionDecisionReason": f"{TAG} {ask_text(rel, state)}\nThe edit was not made."}}
    if payload.get("told"):
        return None
    return {"hookSpecificOutput": {"hookEventName": "PreToolUse", "additionalContext":
            f"{TAG} SHADOW would-ask-plan (shadow mode: the edit goes through): {ask_text(rel, state)}"}}


def main() -> int:
    try:
        payload = json.load(sys.stdin)
        if str(payload.get("tool_name") or "") not in EDIT_TOOLS:
            return 0
        out = decide(payload, gate.load_rules())
        if out:
            print(json.dumps(out))
        return 0
    except Exception as exc:  # fail open: a broken check must never stop an edit
        print(f"{TAG} plan check did not run: {exc}", file=sys.stderr)
        return 1


# ---- selftest -------------------------------------------------------------------------------------------------------

def _row_calls(*calls):
    rows = []
    for i, (name, inp, text) in enumerate(calls):
        rows.append({"type": "assistant", "message": {"content": [{"type": "tool_use", "id": f"p{i}", "name": name, "input": inp}]}})
        rows.append({"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": f"p{i}", "content": text}]}})
    return rows


def _fake_git(top="/w/bbm-infrastructure", url="https://github.com/brand-bridge-media/bbm-infrastructure.git",
              branch="claude/project-thread-x", rc=0):
    def run(argv):
        if argv[-1] == "--show-toplevel":
            return rc, top + "\n"
        if argv[-1] == "origin":
            return 0, url + "\n"
        return 0, branch + "\n"
    return run


def _selftest() -> int:
    results: list[tuple[str, bool]] = []

    def check(label, got, want):
        results.append((label, got == want))
        if got != want:
            print(f"FAIL {label}: got {got!r}, want {want!r}")

    rules = gate.load_rules()
    p = plan_rules(rules)
    infra = gate.repo_rules(rules, "brand-bridge-media", "bbm-infrastructure")
    check("rules: plan check ships enforcing (operator decision 2026-11-19: no shadow week)", p["mode"], "enforce")
    check("rules: plan mode is in date", plan_shadow_ok(p), True)
    check("shadow: day after the end fails", plan_shadow_ok(dict(p, mode="shadow"), "2026-11-27"), False)
    check("shadow: last day passes", plan_shadow_ok(dict(p, mode="shadow"), "2026-11-26"), True)
    check("enforce: no end date needed", plan_shadow_ok(dict(p, mode="enforce"), "2099-01-01"), True)
    for bad in ({}, {"plan": {"mode": "off", "shadow_until": "2026-11-26"}}, {"plan": {"mode": "shadow", "shadow_until": "soon"}}):
        try:
            plan_rules(bad)
            check(f"rules: bad plan block refused {bad}", "accepted", "refused")
        except ValueError:
            check(f"rules: bad plan block refused {bad}", "refused", "refused")

    # Scope test: same list as the PR gate, registrations and generated files excluded.
    check("scope: a workflow edit asks", asks_plan(".github/workflows/deploy-workers.yml", infra), True)
    check("scope: a CI script asks", asks_plan("scripts/ci/merge_route.py", infra), True)
    check("scope: servers asks", asks_plan("infra/servers.json", infra), True)
    check("scope: Trunk config asks", asks_plan(".trunk/trunk.yaml", infra), True)
    check("scope: an article tool never asks", asks_plan("webflow/bulk-operations/x/run.py", infra), False)
    check("scope: a doc never asks", asks_plan("docs/notes.md", infra), False)
    check("scope: a new dispatch-only test workflow is a registration", asks_plan(".github/workflows/test-foo.yml", infra), False)
    check("scope: a selftest block is a registration", asks_plan("scripts/run_selftests.sh", infra), False)
    check("scope: a risk_tiers row is a registration", asks_plan("scripts/ci/risk_tiers.json", infra), False)
    derived = next(iter(infra["derived"]), None)
    if derived and "*" not in derived:
        check("scope: a generated file never asks", asks_plan(derived, infra), False)

    # register.ts only starts this check for paths its MAYBE_GATED pre-filter passes: every gate pattern must pass it.
    src = open(os.path.join(HERE, "register.ts"), encoding="utf-8").read()
    m = re.search(r"MAYBE_GATED = /(.+)/\n", src)
    pre = re.compile(m.group(1)) if m else None
    pats = [g for r in list((rules.get("repos") or {}).values()) + [rules["default"]] for g in r["gate"]]
    missed = [g for g in pats if not (pre and pre.search("/w/repo/" + g.replace("*", "x/y.yml")))]
    check("pre-filter in register.ts covers every gate pattern", missed, [])
    check("pre-filter skips ordinary files", bool(pre and pre.search("/w/repo/webflow/bulk-operations/a/run.py")), False)

    # Permit: only this session's own calls count, and only an approving answer is a permit.
    sql = "mcp__Supabase__execute_sql"
    ok_sql = {"project_id": "x", "query": "select public.ask_track('ci-speed', 'speed-review', 'PLAN: LC-1: x', 's', 'LC-1');"}
    read_q = {"project_id": "x", "query": "select request_id, kind, payload->>'verdict' as verdict, track from public.v_track_request_messages where request_id = 5"}

    def answer(verdict, track="ci-speed"):
        # As the Supabase MCP returns it: the rows as a JSON string inside the result text.
        return json.dumps({"result": json.dumps([{"request_id": 5, "kind": "response", "payload": {"verdict": verdict}, "track": track}])})

    posted = (sql, ok_sql, '[{"ask_track": {"id": 5}}]')
    check("posted: ask_track to ci-speed is not yet a permit", permit(_row_calls(posted)), "posted")
    check("granted: desk answered accepted", permit(_row_calls(posted, (sql, read_q, answer("accepted")))), "granted")
    check("granted: ship_after_fixes", permit(_row_calls(posted, (sql, read_q, answer("ship_after_fixes")))), "granted")
    check("not granted: not_yet means revise", permit(_row_calls(posted, (sql, read_q, answer("not_yet")))), "posted")
    check("not granted: needs_info", permit(_row_calls(posted, (sql, read_q, answer("needs_info")))), "posted")
    check("newest read decides: not_yet after accepted takes it back",
          permit(_row_calls(posted, (sql, read_q, answer("accepted")), (sql, read_q, answer("not_yet")))), "posted")
    check("newest read decides: accepted after not_yet grants",
          permit(_row_calls(posted, (sql, read_q, answer("not_yet")), (sql, read_q, answer("accepted")))), "granted")
    check("not granted: another desk's accept", permit(_row_calls(posted, (sql, read_q, answer("accepted", "seo")))), "posted")
    check("not granted: a verdict not read from the board",
          permit(_row_calls(posted, (sql, {"query": "select 1"}, answer("accepted")))), "posted")
    check("posted: errored ask_track is nothing", permit(_row_calls((sql, ok_sql, '{"error": "function does not exist"}'))), "none")
    check("nothing: ask_track to another desk", permit(_row_calls(
        (sql, {"query": "select public.ask_track('seo', 'seo-review', 'x', 's', 'LC-1');"}, "[]"))), "none")
    check("nothing: a read that mentions ask_track", permit(_row_calls(
        (sql, {"query": "select * from track_requests where question like '%ask_track(%'"}, "[]"))), "none")
    check("posted: Muni-style Supabase server name too", permit(_row_calls(("mcp__Supabase_Muni__execute_sql", ok_sql, "[]"))), "posted")
    send = "mcp__claude-code-remote__send_message"
    check("posted: PLAN message sent straight to the desk", permit(_row_calls(
        (send, {"session_id": DESK_SESSION, "message": "PLAN: LC-1: change deploy.yml"}, "delivered"))), "posted")
    check("nothing: a message to another session", permit(_row_calls(
        (send, {"session_id": "session_other", "message": "PLAN: x"}, "delivered"))), "none")
    check("nothing: a desk message with no plan", permit(_row_calls(
        (send, {"session_id": DESK_SESSION, "message": "hello"}, "delivered"))), "none")
    add = "mcp__Atlassian__addCommentToJiraIssue"
    get = "mcp__Atlassian__getJiraIssue"
    req = (add, {"issueIdOrKey": "LC-1", "commentBody": "[LCH-600 review request] plan: ..."},
           '{"id": "100", "created": "2026-11-19T10:00:00.000+0000"}')

    def jira_read(body, cid="101", created="2026-11-19T10:10:00.000+0000"):
        issue = {"key": "LC-1", "fields": {"comment": {"comments": [{"id": cid, "body": body, "created": created}]}}}
        return (get, {"issueIdOrKey": "LC-1"}, json.dumps({"issues": {"nodes": [issue]}}))

    check("posted: Jira review request alone", permit(_row_calls(req)), "posted")
    check("granted: Jira request then LCH-600 feedback read", permit(_row_calls(req, jira_read("[LCH-600 feedback] ship it"))), "granted")
    check("not granted: feedback older than the request", permit(_row_calls(
        req, jira_read("[LCH-600 feedback] old", created="2026-11-19T09:00:00.000+0000"))), "posted")
    check("granted: stated skip", permit(_row_calls(
        (add, {"issueIdOrKey": "LC-1", "commentBody": "Skipping LCH-600 review: incident hotfix"}, '{"id": "1"}'))), "granted")
    check("nothing: a comment quoting the marker mid-text", permit(_row_calls(
        (add, {"issueIdOrKey": "LC-1", "commentBody": "will post [LCH-600 review request] later"}, '{"id": "1"}'))), "none")
    check("nothing: nothing recorded", permit([]), "none")

    # Locating the file.
    check("locate: repo, relative path and branch", locate("/w/bbm-infrastructure/.github/workflows/a.yml", _fake_git()),
          ("brand-bridge-media", "bbm-infrastructure", ".github/workflows/a.yml", "claude/project-thread-x"))
    check("locate: ssh remote", locate("/w/bbm-infrastructure/x.py", _fake_git(url="git@github.com:brand-bridge-media/bbm-infrastructure.git"))[:2],
          ("brand-bridge-media", "bbm-infrastructure"))
    check("locate: outside a checkout", locate("/tmp/x.py", _fake_git(rc=128)), None)
    check("locate: empty path", locate("", _fake_git()), None)

    # The decision.
    wf = {"tool_name": "Edit", "tool_input": {"file_path": "/w/bbm-infrastructure/.github/workflows/deploy-workers.yml"}}

    def reason(d):
        return (d or {}).get("hookSpecificOutput", {}).get("permissionDecisionReason", "")

    d = decide(wf, rules, _fake_git())
    r0 = reason(d)
    check("enforce: first gated edit denied", (d or {}).get("hookSpecificOutput", {}).get("permissionDecision"), "deny")
    check("deny: names the board call, the desk, the rubric and how to read the answer",
          all(x in r0 for x in ("ask_track('ci-speed'", DESK_SESSION, RUBRIC, "PLAN:", "v_track_request_messages",
                                 "Skipping LCH-600 review:")), True)
    check("deny: asks for minutes and what it replaces", "seconds added per PR" in r0 and "replaces" in r0, True)
    d = decide(dict(wf, transcript_rows=_row_calls(posted)), rules, _fake_git())
    check("posted, no answer yet: still denied, told to wait for the answer",
          "Your plan is posted" in reason(d) and "follow_up" in reason(d), True)
    check("posted: does not repeat the post-the-plan step", "1. Post the plan" in reason(d), False)
    check("not_yet: still denied", reason(decide(dict(wf, transcript_rows=_row_calls(posted, (sql, read_q, answer("not_yet")))),
                                                rules, _fake_git())) != "", True)
    check("approved: edit goes through", decide(dict(wf, transcript_rows=_row_calls(posted, (sql, read_q, answer("accepted")))),
                                               rules, _fake_git()), None)
    check("enforce: told flag never lifts the hold", reason(decide(dict(wf, told=True), rules, _fake_git())) != "", True)
    sh = dict(rules, plan=dict(p, mode="shadow"))
    d = decide(wf, sh, _fake_git())
    note = (d or {}).get("hookSpecificOutput", {}).get("additionalContext", "")
    check("shadow (kill switch): note, never a decision", note.startswith(f"{TAG} SHADOW would-ask-plan")
          and "permissionDecision" not in d["hookSpecificOutput"], True)
    check("shadow: told once per session", decide(dict(wf, told=True), sh, _fake_git()), None)
    check("exempt: lch branch never asked", decide(wf, rules, _fake_git(branch="lch744-plan-stage")), None)
    check("other repo file: default rules still scope it",
          decide({"tool_input": {"file_path": "/w/x/README.md"}}, rules, _fake_git(top="/w/x", url="https://github.com/o/x")), None)
    check("unrelated file: never asked", decide({"tool_input": {"file_path": "/w/bbm-infrastructure/docs/a.md"}}, rules, _fake_git()), None)
    check("outside git: allowed", decide(wf, rules, _fake_git(rc=128)), None)
    check("notebook path is read", decide({"tool_input": {"notebook_path": "/w/bbm-infrastructure/scripts/ci/a.ipynb"}},
                                          rules, _fake_git()) is not None, True)

    passed = sum(ok for _, ok in results)
    print(f"selftest: {passed}/{len(results)} checks passed")
    return 0 if passed == len(results) else 1


if __name__ == "__main__":
    sys.exit(_selftest() if "--selftest" in sys.argv else main())
