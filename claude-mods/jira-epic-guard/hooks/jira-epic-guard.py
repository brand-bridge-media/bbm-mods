#!/usr/bin/env python3
"""PreToolUse guard: a new Jira issue in project LC must name a parent epic (LC-2140).

WHAT IT DOES. On a createJiraIssue call to any Atlassian MCP server (matched by tool-name suffix),
or the generic runner executeWrite with name=createJiraIssue (fields under `inputs`), DENIES the
call when the project is LC, the issue type is not Epic or Sub-task, and no parent is given. The
deny lists the live epics (key, name, when to file there) and says to re-send with `parent` set.
A parent that is one of the PARKED epics is denied with a one-line reason and the same list.

WHY. Operator decision (2026-11-13): every LC ticket belongs to an epic. 369 were filed without
one, mostly by sessions; the written rule existed and was not enforced.

DATA, NOT CODE. The epic list is hooks/epics.json, because the project grouping is still being
settled. Any parent key not in `parked` is accepted: it may be a child epic or one created later,
and the guard does not check that the key exists.

FAIL OPEN. Unreadable input, a missing or malformed epics.json, or any exception allows the call
and writes one line to stderr with exit 1 (the framework's way of saying "the guard did not run").
Kill switch: `claude plugin disable jira-epic-guard` (claude-mods/README.md).

Self-test: python3 jira-epic-guard.py --selftest
"""
from __future__ import annotations

import json
import os
import sys

PROJECT = "LC"
EXEMPT_TYPES = {"epic", "sub-task", "subtask"}
EPICS_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "epics.json")
TAG = "[mod:jira-epic-guard]"


def _text(v) -> str:
    return v.strip() if isinstance(v, str) else ""


def _fields(tool_name: str, tool_input: dict) -> dict | None:
    """The createJiraIssue arguments, or None when this call is not a Jira create."""
    if tool_name.endswith("createJiraIssue"):
        return tool_input
    # The generic runner hides the operation name in the input; its fields sit under `inputs`.
    if tool_name.startswith("mcp__Atlassian") and tool_name.endswith("__executeWrite"):
        if _text(tool_input.get("name")) == "createJiraIssue":
            inner = tool_input.get("inputs")
            return inner if isinstance(inner, dict) else {}
    return None


def _project(f: dict) -> str:
    for k in ("projectKey", "project"):
        v = f.get(k)
        if isinstance(v, dict):
            v = v.get("key")
        if _text(v):
            return _text(v).upper()
    return ""


def _issue_type(f: dict) -> str:
    for k in ("issueTypeName", "issueType", "issuetype", "issue_type"):
        v = f.get(k)
        if isinstance(v, dict):
            v = v.get("name")
        if _text(v):
            return _text(v).lower()
    return ""


def _extra(f: dict) -> dict:
    a = f.get("additional_fields")
    if isinstance(a, str):  # some callers pass the object as a JSON string
        try:
            a = json.loads(a)
        except ValueError:
            return {}
    return a if isinstance(a, dict) else {}


def _parent_value(v) -> str:
    """The epic key a parent-ish value names, '' when empty. An object with only an id counts as present."""
    if isinstance(v, dict):
        v = v.get("key") or v.get("id")
        if isinstance(v, int) and not isinstance(v, bool):
            v = str(v)
    return _text(v).upper()


def parents_of(f: dict) -> list[str]:
    extra = _extra(f)
    vals = (f.get("parent"), extra.get("parent"), extra.get("customfield_10014"), extra.get("Epic Link"))
    return [p for p in (_parent_value(v) for v in vals) if p]


def _list(epics: dict) -> str:
    lines = ["Epics to choose from (file here when the work is about):"]
    for e in epics["live"]:
        lines.append(f"  {e['key']} {e['name']}: {e['when']}")
        kids = e.get("children") or []
        if kids:
            lines.append("    child epics for narrower work: " + ", ".join(f"{k['key']} ({k['name']})" for k in kids))
    return "\n".join(lines)


NEED = (f"{TAG} Every LC ticket needs an epic (operator decision 2026-11-13, LC-2140); "
        "this createJiraIssue call has no parent.")
PARKED = f"{TAG} {{key}} is a parked epic: new work there needs the operator to un-park it; pick a live epic instead."
RESEND = 'Re-send the same call with parent set to the epic key (parent: "LC-nnnn").'


def validate(epics) -> bool:
    try:
        return (isinstance(epics["live"], list) and len(epics["live"]) > 0
                and all(_text(e["key"]) and _text(e["name"]) and _text(e["when"]) for e in epics["live"])
                and isinstance(epics["parked"], list))
    except (KeyError, TypeError):
        return False


def evaluate(tool_name: str, tool_input: dict, epics: dict) -> tuple[str, str] | None:
    f = _fields(tool_name, tool_input)
    if f is None or _project(f) != PROJECT or _issue_type(f) in EXEMPT_TYPES:
        return None
    given = parents_of(f)
    if not given:
        return "deny", f"{NEED}\n{_list(epics)}\n{RESEND}"
    parked = {_text(k).upper() for k in epics["parked"]}
    bad = next((p for p in given if p in parked), None)
    if bad:
        return "deny", f"{PARKED.format(key=bad)}\n{_list(epics)}\n{RESEND}"
    return None


def load_epics(path: str) -> dict | None:
    try:
        with open(path, encoding="utf-8") as fh:
            epics = json.load(fh)
    except (OSError, ValueError):
        return None
    return epics if validate(epics) else None


def emit(decision: str, reason: str) -> None:
    json.dump({"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": decision,
                                      "permissionDecisionReason": reason}}, sys.stdout)
    sys.stdout.write("\n")


def _selftest() -> int:
    import subprocess
    import tempfile

    checks = fails = 0

    def ck(cond: bool, label: str) -> None:
        nonlocal checks, fails
        checks += 1
        if not cond:
            fails += 1
            sys.stderr.write(f"  FAIL: {label}\n")

    here = os.path.dirname(os.path.abspath(__file__))
    epics = load_epics(EPICS_FILE)
    ck(epics is not None, "shipped epics.json loads and validates")
    if epics is None:
        print(f"jira-epic-guard selftest: 0/{checks} checks passed")
        return 1

    CJ = "mcp__Atlassian__createJiraIssue"
    CJ2 = "mcp__Atlassian_MCP__createJiraIssue"
    EW = "mcp__Atlassian_MCP__executeWrite"

    def d(tool, inp):
        r = evaluate(tool, inp, epics)
        return r[1] if r else None

    base = {"cloudId": "c", "projectKey": "LC", "issueTypeName": "Task", "summary": "s"}
    msg = d(CJ, base)
    ck(msg is not None, "LC, no parent: denied")
    ck(msg.startswith(TAG), "deny starts with the callout")
    ck("operator decision 2026-11-13" in msg and "LC-2140" in msg, "deny states the rule")
    for e in epics["live"]:
        ck(e["key"] in msg and e["name"] in msg and e["when"] in msg, f"deny lists {e['key']}")
    for e in epics["live"]:
        for kid in e.get("children") or []:
            ck(kid["key"] in msg, f"deny lists child epic {kid['key']}")
    # Order is read from the file, never pinned to today's keys: the list is data the operator
    # changes, and a data edit must not turn this selftest red (LC-2140).
    at = [msg.index(f"  {e['key']} ") for e in epics["live"]]
    ck(at == sorted(at), "live epics in the data-file order")
    ck("parent" in msg.splitlines()[-1] and "Re-send" in msg.splitlines()[-1], "last line says re-send with parent")
    ck(len(msg.splitlines()) <= 25, "deny is at most 25 lines")
    ck(all(f"  {k} " not in msg for k in epics["parked"]), "parked epics are not offered")
    ck(d(CJ2, base) == msg, "the other Atlassian server name matches the same way")

    # Everything above ran on the SHIPPED epics.json, which proves the real file renders. The logic
    # checks below run on a fixture, so un-parking an epic or closing a track (a data edit) cannot
    # break them.
    epics = {"live": [{"key": "LC-1074", "name": "Refresh Engine", "when": "refresh work"}],
             "parked": ["LC-159", "LC-161", "LC-164", "LC-166", "LC-172", "LC-293", "LC-1965"]}
    shipped_msg, msg = msg, d(CJ, base)  # main() below still reads the shipped file
    ck(d("mcp__Renamed__createJiraIssue", base) == msg, "any server matches by suffix")

    for label, extra in (
        ("parent", {"parent": "LC-1074"}),
        ("parent object", {"parent": {"key": "LC-1074"}}),
        ("parent object with id only", {"parent": {"id": "10001"}}),
        ("parent object with a numeric id", {"parent": {"id": 10001}}),
        ("additional_fields.parent", {"additional_fields": {"parent": "LC-429"}}),
        ("additional_fields.parent object", {"additional_fields": {"parent": {"key": "LC-429"}}}),
        ("customfield_10014", {"additional_fields": {"customfield_10014": "LC-258"}}),
        ("Epic Link", {"additional_fields": {"Epic Link": "LC-258"}}),
        ("additional_fields as a JSON string", {"additional_fields": '{"customfield_10014": "LC-258"}'}),
        ("a child epic key", {"parent": "LC-1757"}),
        ("an epic created later", {"parent": "LC-9999"}),
    ):
        ck(d(CJ, {**base, **extra}) is None, f"parent via {label}: allowed")

    for label, extra in (
        ("empty string", {"parent": ""}),
        ("whitespace", {"parent": "   "}),
        ("null", {"parent": None}),
        ("empty object", {"parent": {}}),
        ("empty key", {"parent": {"key": ""}}),
        ("empty additional_fields", {"additional_fields": {}}),
        ("blank customfield", {"additional_fields": {"customfield_10014": ""}}),
        ("non-object additional_fields", {"additional_fields": 5}),
        ("junk JSON string additional_fields", {"additional_fields": "{not json"}),
        ("unrelated additional_fields", {"additional_fields": {"labels": ["x"]}}),
        ("a non-string parent", {"parent": 7}),
        ("a boolean id", {"parent": {"id": True}}),
    ):
        ck(d(CJ, {**base, **extra}) == msg, f"no real parent ({label}): denied")

    for p in ("LC-159", "LC-161", "LC-164", "LC-166", "LC-172", "LC-293", "LC-1965", "lc-159", " LC-159 "):
        r = d(CJ, {**base, "parent": p})
        ck(r is not None and r.startswith(TAG) and p.strip().upper() in r.splitlines()[0]
           and "parked" in r.splitlines()[0] and "LC-1074" in r, f"parked parent {p!r}: denied, named")
    ck(d(CJ, {**base, "parent": {"key": "LC-159"}}) is not None, "parked parent as object: denied")
    ck(d(CJ, {**base, "additional_fields": {"customfield_10014": "LC-161"}}) is not None, "parked via customfield")
    ck(d(CJ, {**base, "parent": "LC-1074", "additional_fields": {"Epic Link": "LC-164"}}) is not None,
       "a parked key anywhere is denied")
    ck(len(d(CJ, {**base, "parent": "LC-159"}).splitlines()) <= 25, "parked deny is at most 25 lines")

    for t in ("Epic", "epic", "EPIC", "Sub-task", "sub-task", "Subtask", "SUBTASK"):
        ck(d(CJ, {**base, "issueTypeName": t}) is None, f"issue type {t}: exempt")
    nt = {k: v for k, v in base.items() if k != "issueTypeName"}
    ck(d(CJ, {**nt, "issueType": {"name": "Epic"}}) is None, "issueType object: exempt")
    ck(d(CJ, {**base, "issueTypeName": " Epic "}) is None, "padded issue type: exempt")
    for t in ("Task", "Bug", "Story", "Subtask-ish", ""):
        ck(d(CJ, {**base, "issueTypeName": t}) == msg, f"issue type {t!r}: not exempt")
    ck(d(CJ, nt) == msg, "no issue type: not exempt")

    for proj in ("LCH", "LCC", "BBM", "", "L", "LC2"):
        ck(d(CJ, {**base, "projectKey": proj}) is None, f"project {proj!r}: untouched")
    ck(d(CJ, {k: v for k, v in base.items() if k != "projectKey"}) is None, "no project: untouched")
    ck(d(CJ, {**base, "projectKey": "lc"}) == msg, "lowercase lc is LC")
    ck(d(CJ, {**base, "projectKey": " LC "}) == msg, "padded LC is LC")
    pb = {k: v for k, v in base.items() if k != "projectKey"}
    ck(d(CJ, {**pb, "project": "LC"}) == msg, "project string LC")
    ck(d(CJ, {**pb, "project": {"key": "LC"}}) == msg, "project.key LC")
    ck(d(CJ, {**pb, "project": {"key": "LCH"}}) is None, "project.key LCH untouched")

    w = {"name": "createJiraIssue", "cloudId": "c", "inputs": dict(base)}
    ck(d(EW, w) == msg, "executeWrite createJiraIssue, no parent: denied")
    ck(d("mcp__Atlassian__executeWrite", w) == msg, "executeWrite on the other server: denied")
    ck(d(EW, {**w, "inputs": {**base, "parent": "LC-429"}}) is None, "executeWrite with parent: allowed")
    ck(d(EW, {**w, "inputs": {**base, "projectKey": "LCH"}}) is None, "executeWrite in LCH: untouched")
    ck(d(EW, {**w, "inputs": {**base, "issueTypeName": "Epic"}}) is None, "executeWrite Epic: exempt")
    ck(d(EW, {**w, "inputs": {**base, "parent": "LC-159"}}) is not None, "executeWrite parked parent: denied")
    ck(d(EW, {**w, "name": "editJiraIssue"}) is None, "executeWrite with another name: allowed")
    ck(d(EW, {**w, "name": ""}) is None, "executeWrite with no name: allowed")
    ck(d(EW, {"name": "createJiraIssue", "inputs": "junk"}) is None, "executeWrite with junk inputs: no project, allowed")
    ck(d(EW, {"name": "createJiraIssue"}) is None, "executeWrite with no inputs: allowed")
    ck(d("mcp__Other__executeWrite", w) is None, "executeWrite on a non-Atlassian server: ignored")

    for t in ("Bash", "mcp__Atlassian__editJiraIssue", "mcp__Atlassian_MCP__executeRead",
              "mcp__Atlassian__searchJiraIssuesUsingJql", "createJiraIssueX"):
        ck(d(t, base) is None, f"unrelated tool {t}: allowed")

    ck(load_epics(os.path.join(here, "no-such-epics.json")) is None, "missing data file loads as None")
    with tempfile.TemporaryDirectory() as td:
        for label, body in (("junk", "{nope"), ("empty live", '{"live": [], "parked": []}'),
                            ("no parked", '{"live": [{"key":"LC-1","name":"n","when":"w"}]}'),
                            ("blank when", '{"live": [{"key":"LC-1","name":"n","when":""}], "parked": []}'),
                            ("list", "[]"), ("null", "null")):
            p = os.path.join(td, "e.json")
            with open(p, "w", encoding="utf-8") as fh:
                fh.write(body)
            ck(load_epics(p) is None, f"malformed data file ({label}) loads as None")
        with open(os.path.join(td, "ok.json"), "w", encoding="utf-8") as fh:
            fh.write('{"live": [{"key":"LC-1","name":"n","when":"w"}], "parked": []}')
        ck(load_epics(os.path.join(td, "ok.json")) is not None, "minimal valid data file loads")

    # End to end through main(): stdin in, JSON out.
    script = os.path.abspath(__file__)

    def run(stdin, path=script):
        return subprocess.run([sys.executable, "-I", path], input=stdin, capture_output=True, text=True)

    p = run(json.dumps({"tool_name": CJ, "tool_input": base}))
    out = json.loads(p.stdout) if p.stdout else {}
    h = out.get("hookSpecificOutput", {})
    ck(p.returncode == 0 and h.get("permissionDecision") == "deny" and h.get("hookEventName") == "PreToolUse"
       and h.get("permissionDecisionReason") == shipped_msg, "main(): emits the deny")
    p = run(json.dumps({"tool_name": CJ, "tool_input": {**base, "parent": "LC-429"}}))
    ck(p.returncode == 0 and p.stdout == "", "main(): a parent is silent")
    p = run(json.dumps({"tool_name": "Bash", "tool_input": {"command": "ls"}}))
    ck(p.returncode == 0 and p.stdout == "", "main(): an unrelated tool is silent")
    p = run(json.dumps({"tool_name": CJ, "tool_input": None}))
    ck(p.returncode == 0 and p.stdout == "", "main(): null input is silent")
    p = run(json.dumps({"tool_name": CJ, "tool_input": [1]}))
    ck(p.returncode == 0 and p.stdout == "", "main(): list input is silent")
    p = run("")
    ck(p.returncode == 0 and p.stdout == "", "main(): empty stdin is silent")
    p = run("{x")
    ck(p.returncode == 1 and p.stdout == "" and "allowing" in p.stderr, "main(): junk fails open and visible")
    p = run(json.dumps(["not", "a", "dict"]))
    ck(p.returncode == 1 and p.stdout == "", "main(): a non-object payload fails open and visible")
    with tempfile.TemporaryDirectory() as td:
        lone = os.path.join(td, "jira-epic-guard.py")  # no epics.json beside it
        with open(script, encoding="utf-8") as src, open(lone, "w", encoding="utf-8") as dst:
            dst.write(src.read())
        p = run(json.dumps({"tool_name": CJ, "tool_input": base}), lone)
        ck(p.returncode == 1 and p.stdout == "" and "epics.json" in p.stderr, "main(): missing data file fails open and visible")
        with open(os.path.join(td, "epics.json"), "w", encoding="utf-8") as fh:
            fh.write("{broken")
        p = run(json.dumps({"tool_name": CJ, "tool_input": base}), lone)
        ck(p.returncode == 1 and p.stdout == "", "main(): malformed data file fails open and visible")
        p = run(json.dumps({"tool_name": "Bash", "tool_input": {}}), lone)
        ck(p.returncode == 0 and p.stdout == "", "main(): an unrelated tool needs no data file")

    print(f"jira-epic-guard selftest: {checks - fails}/{checks} checks passed")
    return 1 if fails else 0


def main() -> int:
    if "--selftest" in sys.argv:
        return _selftest()
    try:
        raw = sys.stdin.read()
        payload = json.loads(raw) if raw.strip() else {}
        tool_name = str(payload.get("tool_name") or "")  # a non-object payload raises here: fail open
        tool_input = payload.get("tool_input")
        if not isinstance(tool_input, dict) or _fields(tool_name, tool_input) is None:
            return 0  # not a Jira create: nothing to judge, and no need for the data file
        epics = load_epics(EPICS_FILE)
        if epics is None:
            raise ValueError("epics.json is missing or malformed")
        verdict = evaluate(tool_name, tool_input, epics)
    except Exception as e:  # noqa: BLE001
        # Fail OPEN and visible, like the sibling guards.
        sys.stderr.write(f"jira-epic-guard: could not evaluate ({e}); allowing the call. "
                         "The guard is not protecting this one.\n")
        return 1
    if verdict:
        emit(*verdict)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
