#!/usr/bin/env python3
"""Stop guard: a session with open watches may not end its turn without a server-side check-in (LC-2043).

WHAT IT DECIDES. At the end of a turn, one question: "if this session goes idle now, and every
in-process timer stops, what brings it back?" It BLOCKS the turn's end when all hold:

  1. something is open: a fleet child (fleet-tracker row not COMPLETED/ARCHIVED), or an item a
     watcher mod (pr-ci-watch, dispatch-watch, workflow-run-watch) still lists as active;
  2. no SERVER-SIDE check-in will fire within WINDOW_MS (35 min): a `send_later` or `create_trigger`
     this session made, whose fire time is still ahead;
  3. a person is present to answer it (a top-level session; see CHILD below).

It never blocks when nothing is open, when a check-in covers it, or after MAX_BLOCKS refusals in a row.

WHY (LC-2043). On 2026-11-03 the in-process timers (`$.clock.every` -> `$.prompt.submit`) that
fleet-tracker and the three watchers use delivered nothing for ~1h40m while the orchestrator sat
idle; three stale wakes arrived together once the operator typed. A mod cannot schedule a wake on
the server, so the backstop is a session-level rule: a server-side check-in must exist. Only
`send_later` / `create_trigger` count. ScheduleWakeup, CronCreate and Monitor run in the same
process the timers run in, so they die with it.

CHILD. A session another session created gets a NOT CHECKED toast and is never blocked: its
parent's fleet-tracker polls it, and `send_later` raises a permission prompt nobody answers there.

FAIL OPEN. A source that cannot be read, a get_session that does not answer, a crash: allow the turn,
receipt NOT CHECKED, the mod toasts. A bug here must never trap a session.

RECEIPT. Every run prints one line: `PASS|BLOCK|NOT CHECKED: <reason>`. NOT CHECKED is never a pass.

Input (stdin JSON): now_ms, calls[{tool,input,result,at_ms}], children (text|null),
watchers{name: text|null}, session (get_session text|null), blocks (int, refusals in a row).
Output (stdout JSON): {verdict, reason, block}. `block` is the text that stops the turn, or null.

Self-test: python3 idle-backstop-guard.py --selftest
"""
from __future__ import annotations

import json
import re
import sys
from datetime import datetime, timezone

OWN = "[mod:idle-backstop-guard]"
WINDOW_MS = 35 * 60_000   # a check-in must fire inside this to count
DELAY_MIN = 30            # what the block tells the session to schedule (5 min inside the window)
MAX_BLOCKS = 3            # refusals in a row, then the turn may end (toasted): a guard bug cannot trap a session
DONE_BUCKETS = ("COMPLETED", "ARCHIVED")
WATCHERS = ("pr-ci-watch", "dispatch-watch", "workflow-run-watch")


# ---- fire times -------------------------------------------------------------------------------

def parse_ts(s: object) -> int | None:
    """ISO-8601 (Z or offset) or `YYYY-MM-DDTHH:MM:SS[Zone/Name]` -> epoch ms, else None."""
    if not isinstance(s, str) or not s.strip():
        return None
    t = s.strip()
    zone = None
    m = re.fullmatch(r"(.+?)\[([A-Za-z0-9_+\-/]+)\]", t)
    if m:
        t, zone = m.group(1), m.group(2)
    try:
        d = datetime.fromisoformat(t.replace("Z", "+00:00"))
        if d.tzinfo is None:
            # A bare local time with no zone is a guess and is not counted: ZoneInfo(None) raises, so it lands in the except.
            from zoneinfo import ZoneInfo
            d = d.replace(tzinfo=ZoneInfo(zone))  # type: ignore[arg-type]
        return int(d.timestamp() * 1000)
    except Exception:  # noqa: BLE001 - unknown zone, bad date: not a usable fire time
        return None


def _json_in(text: object):
    if not isinstance(text, str):
        return None
    # Outermost braces; with none, or in the wrong order, the slice is not JSON and the except returns None.
    try:
        return json.loads(text[text.find("{"):text.rfind("}") + 1])
    except ValueError:
        return None


def _next_run(result: object) -> int | None:
    """next_run_at / run_once_at from a create_trigger reply (nested anywhere one level down)."""
    v = _json_in(result)
    if not isinstance(v, dict):
        return None
    for src in (v, v.get("trigger") if isinstance(v.get("trigger"), dict) else {}):
        for k in ("next_run_at", "run_once_at"):
            ts = parse_ts(src.get(k))
            if ts is not None:
                return ts
    return None


def fire_ms(call: dict) -> int | None:
    """When a server-side check-in made by this call will fire, or None when it is not one."""
    tool = str(call.get("tool", ""))
    inp = call.get("input") if isinstance(call.get("input"), dict) else {}
    made = call.get("at_ms")
    if not isinstance(made, (int, float)) or isinstance(made, bool):
        return None
    if tool.endswith("__send_later"):
        if "delay_minutes" in inp:
            n = inp["delay_minutes"]
            if isinstance(n, bool) or not isinstance(n, (int, float)) or n < 1:
                return None
            return int(made + n * 60_000)
        return parse_ts(inp.get("at"))
    if tool.endswith("__create_trigger"):
        # It must fire into THIS session: a fresh session or another session's thread does not wake us.
        if inp.get("create_new_session_on_fire") is True or inp.get("persistent_session_id"):
            return None
        return parse_ts(inp.get("run_once_at")) or _next_run(call.get("result"))
    return None


def check_in(calls: object, now_ms: int) -> tuple[int | None, int | None]:
    """(soonest fire inside the window, soonest fire beyond it). Fires in the past are spent."""
    soon, later = None, None
    for c in calls if isinstance(calls, list) else []:
        if not isinstance(c, dict):
            continue
        f = fire_ms(c)
        if f is None or f <= now_ms:
            continue
        if f <= now_ms + WINDOW_MS:
            soon = f if soon is None else min(soon, f)
        else:
            later = f if later is None else min(later, f)
    return soon, later


# ---- what is open -----------------------------------------------------------------------------

def open_children(text: object) -> list[str] | None:
    """fleet-tracker `open_children` text -> '<ticket> <bucket>' per row not done; None if unreadable."""
    if not isinstance(text, str):
        return None
    lines = text.strip().splitlines()
    if not lines or not re.fullmatch(r"Open fleet children: \d+", lines[0].strip()):
        return None
    out = []
    read = 0
    for ln in lines[1:]:
        if not ln.startswith("- "):
            continue
        parts = ln[2:].split()
        if len(parts) < 3:
            continue  # a row we cannot read as `ticket (label) bucket id`
        read += 1
        bucket = parts[-2]
        if bucket.upper() in DONE_BUCKETS:
            continue
        out.append(f"{parts[0]} {bucket}")
    # The header says how many rows there are. Fewer readable rows than that means we did not examine them all:
    # unreadable (NOT CHECKED), never an empty open set (CI review, LC-2043).
    if read < int(lines[0].split(":")[1]):
        return None
    return out


def active_watches(text: object) -> list[str] | None:
    """A watcher's `watching` reply {active, finished} -> the active keys; None if unreadable."""
    v = _json_in(text)
    if not isinstance(v, dict) or not isinstance(v.get("active"), list):
        return None
    return [str(k) for k in v["active"]]


def signal_of(text: object) -> str:
    """get_session (no id) reply -> 'child' | 'top' | 'unreadable'."""
    v = _json_in(text)
    ccr = v.get("ccr") if isinstance(v, dict) else None
    if not isinstance(ccr, dict) or not isinstance(ccr.get("id"), str) or not ccr["id"]:
        return "unreadable"
    p = ccr.get("parent_session_id")
    if p is None or (isinstance(p, str) and not p.strip()):
        return "top"
    return "child" if isinstance(p, str) else "unreadable"


# ---- the verdict ------------------------------------------------------------------------------

def hhmm(ms: int) -> str:
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).strftime("%H:%MZ")


def block_text(items: list[str], now_ms: int, later: int | None) -> str:
    what = "; ".join(items)
    prompt = (f"Idle backstop (LC-2043). Read the real clock first. Open when this was set: {what}. "
              "For each, read the live state (mcp__fleet-tracker__status, the watchers' `watching` tools, the PR/CI/run itself): "
              "act on anything finished, stuck or stalled. If work is still open, schedule the next check-in before ending the turn.")
    note = (f" Your existing check-in fires at {hhmm(later)} ({round((later - now_ms) / 60_000)} min away): too late to count."
            if later else "")
    return (
        f"{OWN} This session has {len(items)} open watch item(s) and nothing on the server will wake it within "
        f"{WINDOW_MS // 60_000} min. The in-process timers that watch them stop when the session idles "
        f"(LC-2043: they delivered nothing for ~1h40m on 2026-11-03).{note}\n"
        + "\n".join(f"- {i}" for i in items)
        + f"\nBefore ending the turn, call mcp__claude-code-remote__send_later with delay_minutes {DELAY_MIN}, "
          'name "Idle backstop: check fleet and watches", initiation "own_followup", and this message:\n'
        + json.dumps(prompt)
        + "\n(A tracker, ScheduleWakeup, CronCreate or Monitor does not count: they run in the process that idles.)"
    )


def decide(p: dict) -> dict:
    """The whole decision. Returns {verdict, reason, block}; never raises on odd input shapes."""
    now = p.get("now_ms")
    if not isinstance(now, (int, float)) or isinstance(now, bool):
        return {"verdict": "NOT CHECKED", "reason": "no clock", "block": None}
    now = int(now)
    items: list[str] = []
    unreadable: list[str] = []

    kids = open_children(p.get("children"))
    if kids is None:
        unreadable.append("fleet-tracker")
    else:
        items += [f"fleet child {k}" for k in kids]
    watchers = p.get("watchers") if isinstance(p.get("watchers"), dict) else {}
    for w in WATCHERS:
        a = active_watches(watchers.get(w))
        if a is None:
            unreadable.append(w)
        else:
            items += [f"{w} {k}" for k in a]

    if not items:
        if unreadable:
            return {"verdict": "NOT CHECKED", "reason": "could not read " + ", ".join(unreadable) + "; nothing else open", "block": None}
        return {"verdict": "PASS", "reason": "no open fleet children or watches", "block": None}

    soon, later = check_in(p.get("calls"), now)
    if soon is not None:
        return {"verdict": "PASS", "reason": f"{len(items)} open; server-side check-in fires {hhmm(soon)} ({round((soon - now) / 60_000)} min)", "block": None}

    who = signal_of(p.get("session"))
    if who == "unreadable":
        return {"verdict": "NOT CHECKED", "reason": f"{len(items)} open, no check-in; get_session unreadable so not blocking", "block": None}
    if who == "child":
        return {"verdict": "NOT CHECKED", "reason": f"{len(items)} open, no check-in; child session, not enforced (the parent's tracker polls it)", "block": None}
    blocks = p.get("blocks") if isinstance(p.get("blocks"), int) and not isinstance(p.get("blocks"), bool) else 0
    if blocks >= MAX_BLOCKS:
        # released: true tells the mod to re-arm (reset its count) so the next turn end is judged afresh.
        return {"verdict": "NOT CHECKED", "reason": f"{len(items)} open, no check-in; released after {MAX_BLOCKS} refusals", "block": None, "released": True}
    return {"verdict": "BLOCK", "reason": f"{len(items)} open, no server-side check-in within {WINDOW_MS // 60_000} min",
            "block": block_text(items, now, later)}


def main() -> int:
    if "--selftest" in sys.argv:
        return _selftest()
    try:
        raw = sys.stdin.read()
        payload = json.loads(raw)  # empty input is a ValueError too: the mod always sends a payload
        if not isinstance(payload, dict) or "now_ms" not in payload:
            raise ValueError("not a guard payload")  # decide() tolerates odd shapes; the entry point refuses them loudly
        out = decide(payload)
    except Exception as e:  # noqa: BLE001
        sys.stderr.write(f"idle-backstop-guard: could not evaluate ({e}); allowing the turn to end.\n")
        return 1
    json.dump(out, sys.stdout)
    sys.stdout.write("\n")
    return 0


def _selftest() -> int:
    checks = fails = 0

    def ck(ok: bool, msg: str) -> None:
        nonlocal checks, fails
        checks += 1
        if not ok:
            fails += 1
            print(f"FAIL: {msg}")

    NOW = parse_ts("2026-11-03T22:00:00Z")
    MIN = 60_000
    SL = "mcp__claude-code-remote__send_later"
    CT = "mcp__claude-code-remote__create_trigger"

    # parse_ts
    ck(parse_ts("2026-11-03T22:00:00Z") == 1793743200000, "Z timestamp")
    ck(parse_ts("2026-11-03T23:00:00+01:00") == 1793743200000, "offset timestamp")
    ck(parse_ts("2026-11-03T14:00:00[America/Los_Angeles]") == 1793743200000, "bracket zone (PST is UTC-8 on 3 Nov)")
    ck(parse_ts("2026-11-03T22:00:00") is None, "bare local time with no zone is not counted")
    ck(parse_ts("2026-11-03T22:00:00[Not/AZone]") is None, "unknown zone is not counted")
    ck(parse_ts("soon") is None and parse_ts(None) is None and parse_ts("") is None and parse_ts(5) is None, "junk timestamps")

    # fire_ms: send_later
    c = lambda tool, inp, res="", at=NOW: {"tool": tool, "input": inp, "result": res, "at_ms": at}
    ck(fire_ms(c(SL, {"delay_minutes": 30})) == NOW + 30 * MIN, "delay is counted from when the call was made")
    ck(fire_ms(c(SL, {"delay_minutes": 30}, at=NOW - 10 * MIN)) == NOW + 20 * MIN, "an earlier call fires earlier")
    ck(fire_ms(c(SL, {"delay_minutes": 0})) is None and fire_ms(c(SL, {"delay_minutes": -5})) is None, "non-positive delay")
    ck(fire_ms(c(SL, {"delay_minutes": True})) is None and fire_ms(c(SL, {"delay_minutes": "30"})) is None, "delay must be a number")
    ck(fire_ms(c(SL, {"at": "2026-11-03T22:20:00Z"})) == NOW + 20 * MIN, "absolute time")
    ck(fire_ms(c(SL, {"message": "x"})) is None, "send_later with no time")
    ck(fire_ms(c(SL, {"delay_minutes": 30}, at=None)) is None and fire_ms(c(SL, {"delay_minutes": 30}, at=True)) is None, "call time unknown")
    # fire_ms: create_trigger
    ck(fire_ms(c(CT, {"run_once_at": "2026-11-03T22:25:00Z"})) == NOW + 25 * MIN, "one-shot trigger")
    ck(fire_ms(c(CT, {"cron_expression": "*/30 * * * *"}, '{"trigger": {"next_run_at": "2026-11-03T22:30:00Z"}}')) == NOW + 30 * MIN, "cron: next_run_at from the reply")
    ck(fire_ms(c(CT, {"cron_expression": "0 * * * *"}, 'created {"next_run_at": "2026-11-03T22:10:00Z"} ok')) == NOW + 10 * MIN, "reply with prose around the JSON")
    ck(fire_ms(c(CT, {"cron_expression": "0 * * * *"}, "created")) is None, "cron with no readable next run")
    ck(fire_ms(c(CT, {"run_once_at": "2026-11-03T22:25:00Z", "create_new_session_on_fire": True})) is None, "a fresh session does not wake this one")
    ck(fire_ms(c(CT, {"run_once_at": "2026-11-03T22:25:00Z", "persistent_session_id": "session_x"})) is None, "another session's trigger does not wake this one")
    ck(fire_ms(c(CT, {"run_once_at": "2026-11-03T22:25:00Z", "create_new_session_on_fire": False})) == NOW + 25 * MIN, "explicit false still counts")
    # in-process timers never count
    for t in ("ScheduleWakeup", "CronCreate", "Monitor", "mcp__x__delete_trigger", "Bash"):
        ck(fire_ms(c(t, {"delay_minutes": 30, "delaySeconds": 1800, "run_once_at": "2026-11-03T22:25:00Z"})) is None, f"{t} is not a server-side check-in")

    # check_in window
    ck(check_in([c(SL, {"delay_minutes": 35})], NOW) == (NOW + 35 * MIN, None), "exactly at the window edge counts")
    ck(check_in([c(SL, {"delay_minutes": 36})], NOW) == (None, NOW + 36 * MIN), "one minute past the edge is too late (reported)")
    ck(check_in([c(SL, {"delay_minutes": 5}, at=NOW - 10 * MIN)], NOW) == (None, None), "a fired check-in is spent")
    ck(check_in([c(SL, {"delay_minutes": 10}, at=NOW - 10 * MIN)], NOW) == (None, None), "firing exactly now is spent")
    ck(check_in([c(SL, {"delay_minutes": 20}), c(SL, {"delay_minutes": 10}), c(SL, {"delay_minutes": 90}), c(SL, {"delay_minutes": 60})], NOW) == (NOW + 10 * MIN, NOW + 60 * MIN), "soonest of each")
    ck(check_in(None, NOW) == (None, None) and check_in(["x", 3, {}], NOW) == (None, None), "junk calls")

    # open_children
    H = "Open fleet children: "
    ck(open_children(H + "0") == [], "no children")
    ck(open_children(H + "2\n- LC-1 (a label) WORKING session_a\n- LC-2 (b) REVIEW_READY session_b") == ["LC-1 WORKING", "LC-2 REVIEW_READY"], "working and review are open")
    ck(open_children(H + "3\n- LC-1 (x) COMPLETED session_a\n- LC-2 (y) ARCHIVED session_b\n- LC-3 (z) completed session_c") == [], "completed/archived (any case) are not open")
    ck(open_children(H + "1\n- LC-9 (p q (r)) pending session_a") == ["LC-9 pending"], "a not-yet-polled row is open; parens in the label")
    ck(open_children(H + "1\nnote: LC-9 (x) WORKING session_a") is None, "a header count with no readable '- ' row is unreadable, not empty")
    ck(open_children(H + "1\n- LC-9 pending") is None, "a row too short to read makes the list unreadable, not empty")
    ck(open_children(H + "2\n- LC-1 (a) WORKING session_a\n- LC-9 pending") is None, "one readable row of two is not the whole list")
    ck(open_children(H + "1\n- LC-1 (a) WORKING session_a\n- LC-2 (b) COMPLETED session_b") == ["LC-1 WORKING"], "more readable rows than the header says is accepted")
    ck(open_children(H + "0\nstray text") == [], "a zero header needs no rows")
    ck(open_children("No sessions tracked.") is None and open_children(None) is None and open_children("") is None, "unreadable children text")
    # active_watches / signal_of
    ck(active_watches('{"active":["pr:o/r#1","run:o/r:x"],"finished":["a"]}') == ["pr:o/r#1", "run:o/r:x"], "active keys")
    ck(active_watches('{"active":[],"finished":[]}') == [], "none active")
    ck(active_watches('{"error":"x"}') is None and active_watches("nope") is None and active_watches(None) is None, "unreadable watching")
    ses = lambda p: json.dumps({"ccr": {"id": "session_1", **({} if p is None else {"parent_session_id": p})}})
    ck(signal_of(ses(None)) == "top" and signal_of(ses("")) == "top", "no parent = top-level")
    ck(signal_of(ses("session_p")) == "child", "parent = child")
    ck(signal_of(ses(7)) == "unreadable" and signal_of("x") == "unreadable" and signal_of(None) == "unreadable", "odd session replies")
    ck(signal_of('<other-session>{"ccr": {"parent_session_id": "p"}}</other-session>') == "unreadable", "no session id = unreadable")

    # decide
    def D(**kw):
        base = {"now_ms": NOW, "calls": [], "children": H + "0", "session": ses(None), "blocks": 0,
                "watchers": {w: '{"active":[],"finished":[]}' for w in WATCHERS}}
        base.update(kw)
        return decide(base)

    r = D()
    ck(r["verdict"] == "PASS" and r["block"] is None and "no open" in r["reason"], "nothing open -> PASS")
    kids = H + "1\n- LC-2015 (track a) NEEDS_INPUT session_a"
    r = D(children=kids)
    ck(r["verdict"] == "BLOCK" and r["block"], "open child, no check-in -> BLOCK")
    ck(OWN in r["block"] and "mcp__claude-code-remote__send_later" in r["block"] and "delay_minutes 30" in r["block"] and "LC-2015 NEEDS_INPUT" in r["block"], "block message names the mod, the call, the delay and the item")
    ck("fires at" not in r["block"], "no 'existing check-in' note when there is none")
    r = D(children=kids, calls=[c(SL, {"delay_minutes": 30})])
    ck(r["verdict"] == "PASS" and "22:30Z" in r["reason"], "check-in inside the window -> PASS")
    r = D(children=kids, calls=[c(SL, {"delay_minutes": 90})])
    ck(r["verdict"] == "BLOCK" and "fires at 23:30Z (90 min away): too late" in r["block"], "late check-in is named, still BLOCK")
    r = D(children=kids, calls=[c(SL, {"delay_minutes": 10}, at=NOW - 20 * MIN)])
    ck(r["verdict"] == "BLOCK", "a spent check-in does not cover")
    w = {"pr-ci-watch": '{"active":["pr:o/r#5"],"finished":[]}', "dispatch-watch": '{"active":[],"finished":[]}', "workflow-run-watch": '{"active":["run:o/r:ci.yml"],"finished":[]}'}
    r = D(watchers=w)
    ck(r["verdict"] == "BLOCK" and "pr-ci-watch pr:o/r#5" in r["block"] and "workflow-run-watch run:o/r:ci.yml" in r["block"] and "2 open watch" in r["block"], "watcher items block and are listed")
    r = D(watchers=w, children=kids)
    ck("3 open watch" in r["block"], "children and watchers add up")
    ck(D(watchers={**w, "pr-ci-watch": '{"active":[],"finished":["pr:o/r#5"]}', "workflow-run-watch": '{"active":[],"finished":[]}'})["verdict"] == "PASS", "finished watches do not block")
    # fail open
    r = D(children=None)
    ck(r["verdict"] == "NOT CHECKED" and "fleet-tracker" in r["reason"] and r["block"] is None, "children unreadable, nothing else open -> NOT CHECKED, never PASS")
    r = D(children=H + "1\n- LC-9 pending")
    ck(r["verdict"] == "NOT CHECKED" and "fleet-tracker" in r["reason"], "a header that counts a row we cannot read is NOT CHECKED, not PASS")
    r = D(children=None, watchers={**w, "dispatch-watch": None})
    ck(r["verdict"] == "BLOCK", "an open item elsewhere still blocks when another source is unreadable")
    r = D(watchers={})
    ck(r["verdict"] == "NOT CHECKED" and "pr-ci-watch, dispatch-watch, workflow-run-watch" in r["reason"], "every watcher unreadable")
    ck(D(children=kids, session=None)["verdict"] == "NOT CHECKED", "get_session unreadable -> allow")
    r = D(children=kids, session=ses("session_parent"))
    ck(r["verdict"] == "NOT CHECKED" and "child session" in r["reason"] and r["block"] is None, "a child session is never blocked")
    ck(D(children=kids, blocks=2)["verdict"] == "BLOCK", "second refusal still blocks")
    r = D(children=kids, blocks=3)
    ck(r["verdict"] == "NOT CHECKED" and "3 refusals" in r["reason"] and r["block"] is None, "released after MAX_BLOCKS")
    ck(r.get("released") is True, "the release is flagged so the mod re-arms")
    ck("released" not in D(children=kids) and "released" not in D(children=kids, blocks=2) and "released" not in D(), "only the release carries the flag")
    ck(D(children=kids, blocks="3")["verdict"] == "BLOCK" and D(children=kids, blocks=True)["verdict"] == "BLOCK", "non-int blocks counts as zero")
    ck(decide({})["verdict"] == "NOT CHECKED" and decide({"now_ms": "x"})["verdict"] == "NOT CHECKED" and decide({"now_ms": True})["verdict"] == "NOT CHECKED", "no clock")
    ck(D(children=kids, calls="junk")["verdict"] == "BLOCK", "junk calls do not cover")
    ck(D(children=kids, watchers="junk")["verdict"] == "BLOCK", "junk watchers field is unreadable, child still blocks")
    ck(hhmm(NOW) == "22:00Z", "hhmm")

    import subprocess
    me = [sys.executable, "-I", __file__]
    payload = {"now_ms": NOW, "calls": [], "children": kids, "session": ses(None), "blocks": 0,
               "watchers": {w_: '{"active":[],"finished":[]}' for w_ in WATCHERS}}
    r = subprocess.run(me, capture_output=True, text=True, input=json.dumps(payload))
    ck(r.returncode == 0 and json.loads(r.stdout)["verdict"] == "BLOCK", "main(): emits BLOCK")
    r = subprocess.run(me, capture_output=True, text=True, input="{x")
    ck(r.returncode == 1 and r.stdout == "", "main(): junk input fails open and visible")
    for bad in ("", "[1]", "{}", '{"calls": []}'):
        r = subprocess.run(me, capture_output=True, text=True, input=bad)
        ck(r.returncode == 1 and r.stdout == "", f"main(): {bad!r} is not a payload: fails open and visible")

    print(f"idle-backstop-guard selftest: {checks - fails}/{checks} checks passed")
    return 1 if fails else 0


# Mutation note (LC-2043): the two survivors on this line cannot be killed from inside, because the selftest itself is
# started by this line; claude-mods.yml reads the selftest count line, so a dead entry point fails CI there.
if __name__ == "__main__":
    raise SystemExit(main())
