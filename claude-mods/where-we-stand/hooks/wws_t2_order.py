#!/usr/bin/env python3
"""wws_t2_order — ask for a T2 approval only when it is the last thing left (LCH-663, option 1).

ONE JOB: read the reply a session is about to send. When it opens with the NEEDS YOU banner and asks the operator for
the bbm-approver (T2) approval on a pull request, say whether every OTHER required check is already green on that PR's
current head. If one is still running, red, or not reported yet, the reply is held: the approval would be spent on a
head that is likely to change.

Why it exists: the T2 gate counts only an approval on the CURRENT head (by design, so unreviewed content never rides an
old approval). On 2026-11-12 one T2 PR (LC-1934 price loop, PR #3214) cost the operator two approvals and needed a third,
because each approval was asked for while a check was still red and the session's fix push voided it. Operator decision
(2026-11-13): ask only when everything else is green, and have the NEEDS YOU guard refuse an early ask. Letting an
approval survive a push stays rejected.

Inputs (the mod's Stop hook gathers them through the session's own GitHub MCP server, read-only):
  t2_prs  {transcript_rows | transcript_path}                -> {prs: [n, ...]}   which PRs the reply asks approval for
  t2_order {transcript_..., t2_evidence: {"<n>": {...}}, moot_blocks} -> {block?}
     evidence per PR: {"sha": head, "statuses": [{context, state}], "check_runs": [{name, status, conclusion, id}]}
                      or {"error": "..."} when it could not be read.

Receipts: PASS (every other required check green), BLOCK (named checks pending or red), NOT CHECKED (evidence missing or
unreadable). NOT CHECKED is held like a BLOCK; it never reads as green. Bounded by MAX_REPEAT (the same counter as the
other NEEDS YOU guard, wws_needs_you), so a reply is never held forever.

Self-test: python3 wws_t2_order.py --selftest
"""
from __future__ import annotations

import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import transcript_reader as tr  # noqa: E402

BANNER = re.compile(r"^\s*>\s*\*{0,2}NEEDS YOU:?\*{0,2}", re.IGNORECASE)
# An approval ask, not a mention: the banner names the approver role or the tier, AND asks to approve.
T2_CUE = re.compile(r"bbm-approver|\bT2\b|tier:T2", re.IGNORECASE)
APPROVE = re.compile(r"\bapprov(?:e|al|ing)\b", re.IGNORECASE)
PR_REF = re.compile(r"(?:PR\s*#|pull/)(\d{1,6})\b", re.IGNORECASE)
MAX_REPEAT = 3
MAX_PRS = 3
PREFIX = "[mod:where-we-stand] NEEDS YOU guard (T2 order, LCH-663): "

# The main ruleset's required contexts (scripts/quality/expected_required_checks.json) minus the two that cannot be green
# before the approval: t2-human-approval itself, and merge-train (posted by the fast lane or not at all on the queue route).
# The selftest compares this list with that file whenever the repo copy is reachable, so the two cannot drift silently.
EXCLUDED = ("t2-human-approval", "merge-train")
REQUIRED_BEFORE_ASK = (
    "independent-review / Independent re-review posted on head sha",
    "quick",
    "tests",
    "schema-drift-check / Added/renamed columns have a reader and a writer",
    "no oversized source file grows",
    "no PR removes or renames a required check",
    "risk_tiers.json never changes with another gate file",
)
GREEN = {"success", "skipped", "neutral"}
RED = {"failure", "error", "cancelled", "timed_out", "action_required", "stale", "startup_failure"}


def _first_line(reply: str) -> str:
    return next((ln for ln in str(reply or "").split("\n") if ln.strip()), "")


def asked_prs(reply: str) -> list:
    """PR numbers the reply's banner asks the operator to approve as T2. [] when it does not."""
    first = _first_line(reply)
    if not BANNER.match(first):
        return []
    body = BANNER.sub("", first, count=1)
    if not (T2_CUE.search(body) and APPROVE.search(body)):
        return []
    out: list = []
    for m in PR_REF.finditer(body):
        n = int(m.group(1))
        if n not in out:
            out.append(n)
    return out[:MAX_PRS]


def is_t2_ask(reply: str) -> bool:
    first = _first_line(reply)
    if not BANNER.match(first):
        return False
    body = BANNER.sub("", first, count=1)
    return bool(T2_CUE.search(body) and APPROVE.search(body))


def _latest(items: list, key: str, name: str):
    """Newest entry for one context/check name: check runs by id, statuses by updated_at (GitHub lists newest first)."""
    mine = [i for i in items if isinstance(i, dict) and i.get(key) == name]
    if not mine:
        return None
    if key == "name":
        return max(mine, key=lambda i: int(i.get("id") or 0))
    return max(mine, key=lambda i: str(i.get("updated_at") or i.get("created_at") or ""))


def check_state(ev: dict, name: str) -> str:
    """'green', 'red' or 'pending' for one required context on the head."""
    st = _latest(ev.get("statuses") or [], "context", name)
    if st is not None:
        s = str(st.get("state") or "").lower()
        return "green" if s == "success" else "red" if s in RED else "pending"
    cr = _latest(ev.get("check_runs") or [], "name", name)
    if cr is None:
        return "pending"  # not reported yet: the job has not started, or was never triggered
    if str(cr.get("status") or "").lower() != "completed":
        return "pending"
    c = str(cr.get("conclusion") or "").lower()
    return "green" if c in GREEN else "red" if c in RED else "pending"


def verdict(ev) -> tuple:
    """(receipt, detail) for one PR: PASS, BLOCK (with the named checks) or NOT CHECKED (with why)."""
    if not isinstance(ev, dict) or ev.get("error") or not ev.get("sha"):
        why = ev.get("error") if isinstance(ev, dict) and ev.get("error") else "the head and its checks were not read"
        return "NOT CHECKED", str(why)[:160]
    if not isinstance(ev.get("check_runs"), list) or not isinstance(ev.get("statuses"), list):
        return "NOT CHECKED", "check runs or statuses missing from the read"
    bad = {"red": [], "pending": []}
    for name in REQUIRED_BEFORE_ASK:
        s = check_state(ev, name)
        if s != "green":
            bad[s].append(name)
    if not bad["red"] and not bad["pending"]:
        return "PASS", f"head {str(ev['sha'])[:8]}: every other required check is green"
    parts = []
    if bad["red"]:
        parts.append("red: " + ", ".join(bad["red"]))
    if bad["pending"]:
        parts.append("not finished: " + ", ".join(bad["pending"]))
    return "BLOCK", f"head {str(ev['sha'])[:8]} " + "; ".join(parts)


def reply_of(payload: dict) -> str:
    return tr.final_reply_text(tr.rows_for(payload))


def evaluate(payload: dict):
    """Block reason, or None to let the turn end."""
    reply = reply_of(payload)
    if not is_t2_ask(reply):
        return None
    try:
        repeats = int(payload.get("moot_blocks") or 0)
    except (TypeError, ValueError):
        repeats = 0  # unreadable count keeps the guard on
    if repeats >= MAX_REPEAT:
        return None
    prs = asked_prs(reply)
    if not prs:
        return (PREFIX + "this reply asks the operator for a T2 (bbm-approver) approval but names no PR in the banner, so its checks "
                "cannot be read. Name it as `<ticket> (<short name>) · PR #<n>` in the banner line and re-send.")
    evidence = payload.get("t2_evidence") or {}
    held = []
    for n in prs:
        rec, detail = verdict(evidence.get(str(n), evidence.get(n)) if isinstance(evidence, dict) else None)
        if rec != "PASS":
            held.append(f"PR #{n} {rec} ({detail})")
    if not held:
        return None
    return (PREFIX + "this reply asks for the bbm-approver approval before every other required check is green: " + " | ".join(held)
            + ". An approval counts only on the head it was given on, so a fix push would void it. Wait for those checks (or fix them), "
            "then ask; until then, report progress without the NEEDS YOU banner. NOT CHECKED means the checks were not read: read them "
            "with pull_request_read get_status and get_check_runs.")


def _selftest() -> int:
    fails: list = []
    total = [0]

    def ck(cond, msg):
        total[0] += 1
        if not cond:
            fails.append(msg)

    ask = "> **NEEDS YOU:** LC-1934 (price loop) · PR #3214 needs your bbm-approver approval — approve the current head."
    ck(asked_prs(ask) == [3214], "a T2 approval ask names its PR")
    ck(asked_prs("> **NEEDS YOU:** T2 approval for LCH-1 · PR #12 and LCH-2 · PR #13.") == [12, 13], "two PRs in one ask")
    ck(asked_prs("> **NEEDS YOU:** LC-1 — pick a heading for PR #12.") == [], "a banner that is not an approval ask")
    ck(asked_prs("> **NEEDS YOU:** LC-1 — the T2 rule shipped in PR #12.") == [], "T2 without an approval verb is not an ask")
    ck(asked_prs("Please approve PR #12 as bbm-approver.") == [], "no banner: not this guard's business")
    ck(asked_prs("Intro\n> **NEEDS YOU:** approve PR #12 (T2).") == [], "the banner must be the first line")
    ck(asked_prs("> **NEEDS YOU:** approve https://github.com/o/r/pull/77 as bbm-approver") == [77], "a pull/ URL counts")
    ck(asked_prs("> NEEDS YOU: approve PR #1, PR #2, PR #3, PR #4 (T2)") == [1, 2, 3], "at most MAX_PRS reads")
    ck(is_t2_ask("> **NEEDS YOU:** T2 approval needed.") and asked_prs("> **NEEDS YOU:** T2 approval needed.") == [], "a T2 ask with no PR")

    sha = "f0526c4aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    green_st = [{"context": c, "state": "success", "updated_at": "2026-11-12T22:00:00Z"} for c in REQUIRED_BEFORE_ASK[:1] + REQUIRED_BEFORE_ASK[4:]]
    green_cr = [{"name": c, "status": "completed", "conclusion": "success", "id": 10} for c in REQUIRED_BEFORE_ASK[1:4]]
    ok = {"sha": sha, "statuses": green_st, "check_runs": green_cr}
    ck(verdict(ok)[0] == "PASS", "everything green: PASS")
    ck(verdict({**ok, "statuses": green_st + [{"context": "t2-human-approval", "state": "failure"}]})[0] == "PASS", "t2-human-approval itself is not waited on")
    ck(verdict({**ok, "check_runs": green_cr + [{"name": "merge-train", "status": "in_progress", "id": 99}]})[0] == "PASS", "merge-train is not waited on")
    r = verdict({**ok, "check_runs": [c if c["name"] != "tests" else {**c, "conclusion": "failure"} for c in green_cr]})
    ck(r[0] == "BLOCK" and "red: tests" in r[1] and sha[:8] in r[1], "a red required check blocks and is named")
    r = verdict({**ok, "check_runs": [c if c["name"] != "quick" else {**c, "status": "in_progress", "conclusion": None} for c in green_cr]})
    ck(r[0] == "BLOCK" and "not finished: quick" in r[1], "a running check blocks")
    r = verdict({**ok, "statuses": green_st[1:]})
    ck(r[0] == "BLOCK" and "independent-review" in r[1], "a required check not reported yet blocks (missing is not green)")
    ck(verdict({**ok, "statuses": [s if not s["context"].startswith("independent") else {**s, "state": "pending"} for s in green_st]})[0] == "BLOCK", "a pending status blocks")
    rerun = green_cr + [{"name": "tests", "status": "completed", "conclusion": "failure", "id": 5}]
    ck(verdict({**ok, "check_runs": rerun})[0] == "PASS", "an older failed run of a check that later passed does not block (newest id wins)")
    rerun2 = green_cr + [{"name": "tests", "status": "completed", "conclusion": "failure", "id": 50}]
    ck(verdict({**ok, "check_runs": rerun2})[0] == "BLOCK", "a newer failed re-run blocks")
    ck(verdict({**ok, "check_runs": [c if c["name"] != "tests" else {**c, "conclusion": "skipped"} for c in green_cr]})[0] == "PASS", "skipped counts as green, as GitHub counts it")
    ck(verdict({"error": "pull_request_read returned an error"})[0] == "NOT CHECKED", "an unreadable PR is NOT CHECKED")
    ck(verdict(None)[0] == "NOT CHECKED" and verdict({})[0] == "NOT CHECKED", "no evidence is NOT CHECKED")
    ck(verdict({"sha": sha, "statuses": []})[0] == "NOT CHECKED", "a read with no check runs is NOT CHECKED, not green")

    def pay(reply, ev, **kw):
        rows = [{"type": "user", "message": {"role": "user", "content": "go"}},
                {"type": "assistant", "message": {"role": "assistant", "content": [{"type": "text", "text": reply}]}}]
        return {"transcript_rows": rows, "t2_evidence": ev, **kw}

    red = {"sha": sha, "statuses": green_st, "check_runs": [c if c["name"] != "tests" else {**c, "conclusion": "failure"} for c in green_cr]}
    w = evaluate(pay(ask, {"3214": red}))
    ck(w is not None and w.startswith(PREFIX) and "PR #3214 BLOCK" in w and "red: tests" in w, "LC-1934 case: an approval asked while tests is red is held, with the check named")
    ck(evaluate(pay(ask, {"3214": ok})) is None, "negative: the same ask with every other check green goes out")
    ck(evaluate(pay(ask, {3214: ok})) is None, "evidence keyed by int also works")
    ck("NOT CHECKED" in (evaluate(pay(ask, {})) or ""), "no read for the PR: held as NOT CHECKED")
    ck(evaluate(pay(ask, {}, moot_blocks=2)) is not None and evaluate(pay(ask, {}, moot_blocks=3)) is None, "bounded by MAX_REPEAT")
    ck(evaluate(pay(ask, {}, moot_blocks="x")) is not None, "an unreadable count keeps the guard on")
    ck("names no PR" in (evaluate(pay("> **NEEDS YOU:** T2 approval needed on the price loop.", {})) or ""), "a T2 ask with no PR is held and told how to name it")
    ck(evaluate(pay("Done. Merged.", {})) is None, "a reply with no banner passes")
    ck(evaluate(pay("> **NEEDS YOU:** LC-1 — pick A or B.", {})) is None, "a banner that is not a T2 approval ask passes")
    two = "> **NEEDS YOU:** bbm-approver approval on LCH-1 · PR #12 and LCH-2 · PR #13."
    w = evaluate(pay(two, {"12": ok, "13": red}))
    ck(w is not None and "PR #13" in w and "PR #12" not in w, "only the PR that is not ready is named")
    ck(evaluate({"transcript_rows": []}) is None, "no reply, nothing to check")
    ck(evaluate(pay("Please approve PR #12 as bbm-approver (T2).", {})) is None, "an approval request with no banner is not held")
    ck(evaluate(pay("> **NEEDS YOU:** LC-1 — approve the new heading copy.", {})) is None, "a banner approval that is not T2 is not held")
    ck(evaluate(pay("> **NEEDS YOU:** LC-1 — the T2 gate for PR #12 is live.", {})) is None, "a banner naming T2 without asking to approve is not held")
    dup = [{"context": REQUIRED_BEFORE_ASK[0], "state": "failure", "created_at": "2026-11-12T21:00:00Z"},
           {"context": REQUIRED_BEFORE_ASK[0], "state": "success", "created_at": "2026-11-12T22:00:00Z"}]
    ck(verdict({**ok, "statuses": dup + green_st[1:]})[0] == "PASS", "statuses with only created_at: the newest one wins")
    ck("red: " + REQUIRED_BEFORE_ASK[0] in verdict({**ok, "statuses": [{**green_st[0], "state": "error"}] + green_st[1:]})[1], "an error status is red, not pending")
    early = [c if c["name"] != "tests" else {**c, "status": "in_progress", "conclusion": "success"} for c in green_cr]
    ck("not finished: tests" in verdict({**ok, "check_runs": early})[1], "a run not completed is pending even if a conclusion is filled in")

    # Drift: the embedded list must equal the repo's required contexts minus the two excluded ones.
    here = os.path.dirname(os.path.abspath(__file__))
    path = os.path.normpath(os.path.join(here, "..", "..", "..", "scripts", "quality", "expected_required_checks.json"))
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            ctx = json.load(f).get("contexts") or []
        ck(sorted(c for c in ctx if c not in EXCLUDED) == sorted(REQUIRED_BEFORE_ASK), "REQUIRED_BEFORE_ASK matches expected_required_checks.json minus " + ", ".join(EXCLUDED))
        ck(all(e in ctx for e in EXCLUDED), "both excluded contexts are still required (else the exclusion is stale)")
    for f_ in fails:
        print("FAIL:", f_)
    print(f"wws_t2_order selftest: {total[0] - len(fails)}/{total[0]} checks passed")
    return 1 if fails else 0


# The entry point is waived from the mutation floor: breaking it makes the selftest command itself print nothing, which CI
# already fails on (the count line is required), so a case here would test the harness, not this module (LCH-663).
if __name__ == "__main__":
    if "--selftest" in sys.argv:
        sys.exit(_selftest())
    print(__doc__)
