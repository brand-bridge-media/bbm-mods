#!/usr/bin/env python3
"""Stop guard: a session with open watches may not end its turn without a server-side check-in (LC-2043).

WHAT IT DECIDES. At the end of a turn, one question: "if this session goes idle now, and every
in-process timer stops, what brings it back?" It BLOCKS the turn's end when all hold:

  1. something is open: a fleet child (fleet-tracker row not COMPLETED/ARCHIVED), or an item a
     watcher mod (pr-ci-watch, dispatch-watch, workflow-run-watch) still lists as active;
  2. no SERVER-SIDE check-in will fire within WINDOW_MS (35 min): a `send_later` or `create_trigger`
     this session made, whose fire time is still ahead, OR (LC-2061) an enabled scheduled task the server
     lists (`list_triggers`) as firing into this session inside the window;
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
watchers{name: text|null}, session (get_session text|null), blocks (int, refusals in a row),
triggers (list of list_triggers reply texts | null; LC-2061).
Output (stdout JSON): {verdict, reason, block}. `block` is the text that stops the turn, or null.

OWNER RULE (LC-2167, operator decision 2026-11-16: no deliverable goes stale; the only exit is the operator abandoning it in
writing). A second question, asked at the same turn end: "does this session leave an open deliverable without saying who
moves it next?" An open deliverable is an open fleet child, an active watcher item, or a PR this session opened that it has
not seen merged or closed. The turn's final reply must then carry ONE of:
  * a line `Next owner: <who and when>` (e.g. `Next owner: this session, check-in 17:45Z` or `Next owner: the operator,
    bbm-approver on PR #3530`), or
  * the operator's written abandon: a line starting `ABANDONED BY OPERATOR` plus a `> quote` of the operator's words.
The check-in half of the brief is the LC-2043 rule above, unchanged. In-progress Jira tickets are NOT read here (a Jira call
per turn end is too slow for a Stop hook); scripts/ci/stale_stories.py covers them server-side twice a day (LCH-703).

The rule's MODE is data, owner-rule.json beside this file: off | shadow | enforce. It ships in SHADOW (principle 15,
step 4: a new check runs on real sessions and a person reads its receipts before it may block). In shadow, a miss is a
toast `[mod:idle-backstop-guard] SHADOW owner rule would block: ...` (session-close lists it at close-out) and a
receipt line; the turn always ends. Going live is a one-line PR to owner-rule.json after the operator has read them.
Escape paths in enforce: the abandon quote; MAX_BLOCKS refusals in a row release the turn (shared with the check-in rule);
a child session is never blocked; an unreadable reply is NOT CHECKED. So an unattended run is never trapped (LC-1910,
LC-1968: unattended runs hang on anything that waits for a person).

Self-test: python3 idle-backstop-guard.py --selftest
"""
from __future__ import annotations

import json
import os
import re
import sys
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # `python3 -I` does not add the script directory
import transcript_reader as tr  # noqa: E402

OWN = "[mod:idle-backstop-guard]"
WINDOW_MS = 35 * 60_000   # a check-in must fire inside this to count
DELAY_MIN = 30            # what the block tells the session to schedule (5 min inside the window)
MAX_BLOCKS = 3            # refusals in a row, then the turn may end (toasted): a guard bug cannot trap a session
DONE_BUCKETS = ("COMPLETED", "ARCHIVED")
WATCHERS = ("pr-ci-watch", "dispatch-watch", "workflow-run-watch")
MODE_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "owner-rule.json")
MODES = ("off", "shadow", "enforce")


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


def session_id(text: object) -> str | None:
    """This session's id from the get_session (no id) reply, else None."""
    v = _json_in(text)
    ccr = v.get("ccr") if isinstance(v, dict) else None
    sid = ccr.get("id") if isinstance(ccr, dict) else None
    return sid if isinstance(sid, str) and sid else None


def server_check_in(triggers: object, session: object, now_ms: int) -> tuple[int | None, int | None]:
    """(soonest fire inside the window, soonest beyond it) from the server's own list of scheduled tasks (LC-2061).

    The `calls` list only holds check-ins this process saw being made. It lives in session state, so a check-in armed
    before a container restart or a mod reload was invisible and the guard demanded a duplicate (five refusals on
    2026-11-04 with check-ins already pending; again 2026-11-11, LC-2112). The server's list survives both. Only an
    enabled task bound to THIS session (persistent_session_id) counts; one that starts a fresh session does not wake us.
    Unreadable pages or session id: nothing counted from here (the calls list still applies)."""
    sid = session_id(session)
    if sid is None:
        return None, None
    pages = triggers if isinstance(triggers, list) else []
    soon, later = None, None
    for page in pages:
        v = _json_in(page)
        rows = v.get("data") if isinstance(v, dict) else None
        for t in rows if isinstance(rows, list) else []:
            if not isinstance(t, dict) or t.get("enabled") is not True:
                continue
            if t.get("persistent_session_id") != sid or t.get("persist_session") is False:
                continue
            f = parse_ts(t.get("next_run_at"))
            if f is None or f <= now_ms:
                continue
            if f <= now_ms + WINDOW_MS:
                soon = f if soon is None else min(soon, f)
            else:
                later = f if later is None else min(later, f)
    return soon, later


def _earliest(a: int | None, b: int | None) -> int | None:
    return a if b is None else b if a is None else min(a, b)


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


# ---- owner rule (LC-2167) ---------------------------------------------------------------------

_MARKUP = re.compile(r"^[\s>*_`#-]+")
OWNER_LINE = re.compile(r"^next owner\s*[:\-]\s*(.+)$", re.IGNORECASE)
NOT_AN_OWNER = {"none", "nobody", "n/a", "na", "tbd", "unknown", "?", "-", "no one", "noone"}
FAILED = re.compile(r"\berror\b|\bfailed\b|not mergeable|\b40[0-9]\b|\b422\b", re.IGNORECASE)
PR_URL = re.compile(r"github\.com/([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)/pull/(\d+)")
PR_DONE = re.compile(r'"outcome"\s*:\s*"(?:merged|closed)"\s*,\s*"pr"\s*:\s*"([\w.-]+/[\w.-]+)#(\d+)"')


def next_owner(reply: str) -> str | None:
    """The owner named on a `Next owner:` line of the reply, or None. A placeholder (none, TBD, ?) names nobody."""
    for ln in (reply or "").splitlines():
        m = OWNER_LINE.match(_MARKUP.sub("", ln).strip())
        if m:
            who = re.sub(r"[*_`]", "", m.group(1)).strip().rstrip(".")
            if len(who) >= 3 and who.lower() not in NOT_AN_OWNER:
                return who
    return None


THREAD_REPLY_TOOL = "hearthbot__post_message"
SILENT_TOOL = "hearthbot__no_reply_needed"


def final_reply(rows: list[dict]) -> str:
    """The reply the person actually reads at this turn end.

    In a project thread (where mods load since LC-2200) the person never sees plain assistant text: only a
    `mcp__hearthbot__post_message` call reaches them, and a session often adds a trailing text line after it. So when the
    turn holds a post_message, its LAST text is the reply; otherwise the last assistant text is (a terminal session)."""
    last = max((i for i, r in enumerate(rows) if tr._is_prompt(r)), default=-1)
    posted = _posts(rows[last + 1:])
    return posted[-1] if posted else tr.final_reply_text(rows)


def _posts(rows: list[dict]) -> list[str]:
    return [b["input"]["text"] for r in rows
            if r.get("type") == "assistant" and not r.get("isSidechain")
            for b in tr._blocks(r)
            if b.get("type") == "tool_use" and str(b.get("name") or "").endswith(THREAD_REPLY_TOOL)
            and isinstance(b.get("input"), dict) and isinstance(b["input"].get("text"), str)]


def silent_turn(rows: list[dict]) -> bool:
    """This turn ended a thread wake deliberately silent: a hearthbot no_reply_needed call and no post_message."""
    last = max((i for i, r in enumerate(rows) if tr._is_prompt(r)), default=-1)
    names = [str(b.get("name") or "") for r in rows[last + 1:]
             if r.get("type") == "assistant" and not r.get("isSidechain")
             for b in tr._blocks(r) if b.get("type") == "tool_use"]
    return any(n.endswith(SILENT_TOOL) for n in names) and not any(n.endswith(THREAD_REPLY_TOOL) for n in names)


def last_posted(rows: list[dict]) -> str:
    """The last reply the person saw in this thread, from any earlier turn."""
    p = _posts(rows)
    return p[-1] if p else ""


def abandoned(reply: str) -> bool:
    """The operator's written abandon: an `ABANDONED BY OPERATOR` line AND a non-empty `> quote` (same marker as LCH-703)."""
    lines = (reply or "").splitlines()
    head = any(_MARKUP.sub("", ln).strip().upper().startswith("ABANDONED BY OPERATOR") for ln in lines)
    quote = any(ln.lstrip().startswith(">") and len(re.sub(r"[\s>*_`\"]", "", ln)) >= 3 for ln in lines)
    return head and quote


def session_prs(rows: list[dict]) -> list[str]:
    """`pr:<owner>/<repo>#<n>` for every PR this session opened and has not itself merged or closed."""
    opened: list[str] = []
    gone: set[str] = set()
    for name, inp, text in tr.tool_calls_with_results(rows):
        short = name.split("__")[-1]
        if short == "create_pull_request":
            m = PR_URL.search(text or "")
            if m and f"pr:{m.group(1)}#{m.group(2)}" not in opened:
                opened.append(f"pr:{m.group(1)}#{m.group(2)}")
        elif short in ("merge_pull_request", "update_pull_request"):
            if short == "update_pull_request" and str(inp.get("state", "")).lower() != "closed":
                continue
            if FAILED.search(text or ""):
                continue  # a refused merge or close leaves the PR open
            # A call missing owner/repo/number yields a key like `pr:None/r#7` that matches no opened PR: harmless.
            gone.add(f"pr:{inp.get('owner')}/{inp.get('repo')}#{inp.get('pullNumber', inp.get('pull_number'))}")
    # The merge queue merges a PR outside the session; the session learns it from a GitHub event (a ReadNotifications
    # result or a wake), never from its own merge call. Found by replaying a real thread (2026-11-17): without this a PR
    # merged by Mergify stayed "open" for every later turn. A forged line in a PR comment could only relax a reminder.
    texts = [t for _, _, t in tr.tool_calls_with_results(rows)]
    texts += [b.get("text") or "" for r in rows if tr._is_prompt(r) for b in tr._blocks(r) if b.get("type") == "text"]
    for t in texts:
        for m in PR_DONE.finditer(t or ""):
            gone.add(f"pr:{m.group(1)}#{m.group(2)}")
    return [k for k in opened if k not in gone]


def finished_watches(text: object) -> set[str]:
    v = _json_in(text)
    return {str(k) for k in v.get("finished", [])} if isinstance(v, dict) and isinstance(v.get("finished"), list) else set()


def read_mode(path: str = MODE_FILE) -> str | None:
    """off | shadow | enforce, or None when the file is unreadable (the rule is then NOT CHECKED, never enforced)."""
    try:
        with open(path) as fh:
            m = json.load(fh).get("mode")
    except (OSError, ValueError, AttributeError):
        return None
    return m if m in MODES else None


def owner_check(p: dict, items: list[str], mode: str | None) -> dict:
    """{verdict: PASS|MISS|NOT CHECKED|OFF, reason}. MISS is the enforce-mode refusal, or the shadow-mode 'would block'."""
    if mode == "off":
        return {"verdict": "OFF", "reason": "owner rule off"}
    if mode is None:
        return {"verdict": "NOT CHECKED", "reason": "owner-rule.json unreadable"}
    rows = tr.rows_for(p)
    if not rows:
        return {"verdict": "NOT CHECKED", "reason": "no transcript"}
    watchers = p.get("watchers") if isinstance(p.get("watchers"), dict) else {}
    done = finished_watches(watchers.get("pr-ci-watch"))
    listed = set(items)
    prs = [f"open PR {k}" for k in session_prs(rows) if k not in done and f"pr-ci-watch {k}" not in listed]
    open_ = items + prs
    if not open_:
        return {"verdict": "PASS", "reason": "no open deliverable"}
    reply = final_reply(rows)
    if silent_turn(rows):
        # A thread turn that answers a bot event with no reply (no_reply_needed) adds nothing for the person to act on;
        # the owner named in the last reply the person saw still stands. Demanding a new line here would force a
        # reply on every CI or queue notification (2026-11-17 replay: 14 of 21 turn ends were such events).
        reply = last_posted(rows)
    if abandoned(reply):
        return {"verdict": "PASS", "reason": f"{len(open_)} open; abandoned by the operator in writing"}
    who = next_owner(reply)
    if who:
        return {"verdict": "PASS", "reason": f"{len(open_)} open; next owner: {who[:80]}"}
    return {"verdict": "MISS", "reason": f"{len(open_)} open deliverable(s) and the final reply names no next owner",
            "items": open_}


def owner_block_text(items: list[str]) -> str:
    return (f"{OWN} Owner rule (LC-2167): this session leaves {len(items)} open deliverable(s) and the final reply does "
            "not say who moves them next.\n" + "\n".join(f"- {i}" for i in items)
            + "\nRe-send the final reply with a line `Next owner: <who, and when they act>` (this session with its "
              "scheduled check-in, the operator with the one action they take, or a named thread/ticket). Only the "
              "operator can drop it: a line `ABANDONED BY OPERATOR` plus a `> quote` of their words.")


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


def open_items(p: dict) -> tuple[list[str], list[str]]:
    """(open items, unreadable sources) from the fleet tracker and the watchers."""
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
    return items, unreadable


def decide(p: dict, mode: str | None = "__file__") -> dict:
    """Both rules. The LC-2043 check-in verdict is unchanged; the LC-2167 owner rule is added per its mode.

    Returns {verdict, reason, block, owner: {verdict, reason}, shadow?: text}. `shadow` is set only when the owner rule
    would have blocked in shadow mode: the mod toasts it and the turn still ends."""
    v = decide_checkin(p)
    if mode == "__file__":
        mode = read_mode()
    try:
        items, _ = open_items(p)
        o = owner_check(p, items, mode)
    except Exception as e:  # noqa: BLE001 - the new rule must never break the live one
        o = {"verdict": "NOT CHECKED", "reason": f"owner rule crashed: {type(e).__name__}"}
    v["owner"] = {"verdict": o["verdict"], "reason": o["reason"]}
    if o["verdict"] == "MISS" and v["verdict"] != "BLOCK":
        if mode == "shadow":
            v["shadow"] = f"{OWN} SHADOW owner rule would block: {o['reason']}"
        elif mode == "enforce":
            if signal_of(p.get("session")) != "top":  # a child (or an unreadable session) is never blocked
                v["owner"]["verdict"] = "NOT CHECKED"
                v["owner"]["reason"] += "; not a readable top-level session, not blocking"
            elif _blocks(p) >= MAX_BLOCKS:
                v["owner"]["verdict"] = "NOT CHECKED"
                v["owner"]["reason"] += f"; released after {MAX_BLOCKS} refusals"
                v["released"] = True
            else:
                return {**v, "verdict": "BLOCK", "reason": "owner rule: " + o["reason"], "block": owner_block_text(o["items"])}
    return v


def _blocks(p: dict) -> int:
    b = p.get("blocks")
    return b if isinstance(b, int) and not isinstance(b, bool) else 0


def decide_checkin(p: dict) -> dict:
    """The LC-2043 decision. Returns {verdict, reason, block}; never raises on odd input shapes."""
    now = p.get("now_ms")
    if not isinstance(now, (int, float)) or isinstance(now, bool):
        return {"verdict": "NOT CHECKED", "reason": "no clock", "block": None}
    now = int(now)
    items, unreadable = open_items(p)

    if not items:
        if unreadable:
            return {"verdict": "NOT CHECKED", "reason": "could not read " + ", ".join(unreadable) + "; nothing else open", "block": None}
        return {"verdict": "PASS", "reason": "no open fleet children or watches", "block": None}

    soon, later = check_in(p.get("calls"), now)
    s_soon, s_later = server_check_in(p.get("triggers"), p.get("session"), now)
    soon, later = _earliest(soon, s_soon), _earliest(later, s_later)
    if soon is not None:
        return {"verdict": "PASS", "reason": f"{len(items)} open; server-side check-in fires {hhmm(soon)} ({round((soon - now) / 60_000)} min)", "block": None}

    who = signal_of(p.get("session"))
    if who == "unreadable":
        return {"verdict": "NOT CHECKED", "reason": f"{len(items)} open, no check-in; get_session unreadable so not blocking", "block": None}
    if who == "child":
        return {"verdict": "NOT CHECKED", "reason": f"{len(items)} open, no check-in; child session, not enforced (the parent's tracker polls it)", "block": None}
    if _blocks(p) >= MAX_BLOCKS:
        # released: true tells the mod to re-arm (reset its count) so the next turn end is judged afresh.
        return {"verdict": "NOT CHECKED", "reason": f"{len(items)} open, no check-in; released after {MAX_BLOCKS} refusals", "block": None, "released": True}
    return {"verdict": "BLOCK", "reason": f"{len(items)} open, no server-side check-in within {WINDOW_MS // 60_000} min",
            "block": block_text(items, now, later)}


def replay(rows: list[dict]) -> list[str]:
    """The owner rule's receipt at every past turn end of a real transcript (LC-2167: the evidence read before enforce).

    A turn end is the row before each prompt, plus the end. A compaction summary is not a stop (no Stop hook fires
    there), so the turn it cuts is skipped. Fleet children and watchers are not in a transcript, so only PRs count here."""
    ends = [i for i, r in enumerate(rows) if tr._is_prompt(r) and not r.get("isCompactSummary")][1:] + [len(rows)]
    out = []
    for e in ends:
        o = owner_check({"transcript_rows": rows[:e]}, [], "shadow")
        if o["reason"] != "no open deliverable":
            ts = next((str(r["timestamp"]) for r in reversed(rows[:e]) if r.get("timestamp")), "?")
            out.append(f"{ts[:16]}  {o['verdict']}: {o['reason']}")
    return out


def main() -> int:
    if "--selftest" in sys.argv:
        return _selftest()
    if len(sys.argv) == 3 and sys.argv[1] == "--replay":
        lines = replay(tr.rows_for({"transcript_path": sys.argv[2]}))
        print("\n".join(lines) if lines else "no turn end left an open deliverable")
        print(f"turn ends with an open deliverable: {len(lines)}; would block: {sum(' MISS:' in ln for ln in lines)}")
        return 0
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

    # ---- owner rule (LC-2167) ----
    ck(next_owner("done\n\nNext owner: the operator, bbm-approver on PR #3530") == "the operator, bbm-approver on PR #3530", "owner line read")
    ck(next_owner("**Next owner:** this session, check-in 17:45Z.") == "this session, check-in 17:45Z", "markup and trailing dot stripped")
    ck(next_owner("- next owner - LC-2141 thread") == "LC-2141 thread", "dash separator and list bullet")
    for bad in ("Next owner: none", "Next owner: TBD", "Next owner: ?", "Next owner: ab", "next owner", "The next owner is me", ""):
        ck(next_owner(bad) is None, f"no owner in {bad!r}")
    ck(abandoned("ABANDONED BY OPERATOR (2026-11-16)\n> drop it, not worth it"), "abandon heading + quote")
    ck(abandoned("**Abandoned by operator**\n\n>   kill it"), "case and markup tolerated")
    ck(not abandoned("ABANDONED BY OPERATOR"), "heading without the quote is not an abandon")
    ck(not abandoned("> drop it"), "quote without the heading is not an abandon")
    ck(not abandoned("ABANDONED BY OPERATOR\n>  "), "empty quote is not an abandon")

    def row_use(tid, name, inp):
        return {"type": "assistant", "message": {"content": [{"type": "tool_use", "id": tid, "name": name, "input": inp}]}}

    def row_res(tid, text):
        return {"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": tid, "content": text}]}}

    def row_prompt(t="go"):
        return {"type": "user", "message": {"content": t}}

    def row_reply(t):
        return {"type": "assistant", "message": {"content": [{"type": "text", "text": t}]}}

    CPR, MPR, UPR = "mcp__github__create_pull_request", "mcp__github__merge_pull_request", "mcp__github__update_pull_request"
    pr_rows = [row_prompt(), row_use("a", CPR, {"title": "x"}), row_res("a", '{"html_url":"https://github.com/o/r/pull/7"}'),
               row_use("b", CPR, {}), row_res("b", "created https://github.com/o/r/pull/8 ok"),
               row_use("c", CPR, {}), row_res("c", "error: validation failed"),
               row_use("d", MPR, {"owner": "o", "repo": "r", "pullNumber": 8}), row_res("d", '{"merged":true}'),
               row_use("f", MPR, {"owner": "o", "repo": "r", "pullNumber": 7}), row_res("f", "Error: 405 Pull Request is not mergeable")]
    ck(session_prs(pr_rows) == ["pr:o/r#7"], "opened PRs minus the one merged; a failed create opens nothing")
    ck(session_prs(pr_rows + [row_use("e", UPR, {"owner": "o", "repo": "r", "pullNumber": 7, "state": "closed"}), row_res("e", "{}")]) == [], "closed in session")
    ck(session_prs(pr_rows + [row_use("e", UPR, {"owner": "o", "repo": "r", "pullNumber": 7, "title": "t"}), row_res("e", "{}")]) == ["pr:o/r#7"], "an edit is not a close")
    ck(session_prs(pr_rows + [row_use("e", UPR, {"owner": "o", "repo": "r", "pull_number": 7, "state": "CLOSED"}), row_res("e", "{}")]) == [], "pull_number spelling, any case")
    ck(session_prs(pr_rows + [row_use("g", CPR, {}), row_res("g", "https://github.com/o/r/pull/7 again")]) == ["pr:o/r#7"], "a PR listed once")
    ck(session_prs([row_use("h", CPR, {}), row_res("h", "no url here")]) == [], "a create with no PR url opens nothing")
    ck(finished_watches('{"active":[],"finished":["pr:o/r#7"]}') == {"pr:o/r#7"} and finished_watches(None) == set(), "finished watches")
    with __import__("tempfile").TemporaryDirectory() as d:
        mp = os.path.join(d, "m.json")
        for body, want in (('{"mode":"enforce"}', "enforce"), ('{"mode":"shadow"}', "shadow"), ('{"mode":"off"}', "off"),
                           ('{"mode":"live"}', None), ("{x", None), ("[]", None)):
            with open(mp, "w") as fh:
                fh.write(body)
            ck(read_mode(mp) == want, f"mode file {body!r}")
        ck(read_mode(os.path.join(d, "missing.json")) is None, "missing mode file")
    ck(read_mode() == "enforce", "the shipped mode is enforce (operator decision 2026-11-17, LC-2167)")

    def O(mode, reply, extra=(), **kw):
        rows = [row_prompt(), *pr_rows[1:3], *extra, row_reply(reply)]
        base = {"now_ms": NOW, "calls": [], "children": H + "0", "session": ses(None), "blocks": 0,
                "watchers": {w_: '{"active":[],"finished":[]}' for w_ in WATCHERS}, "transcript_rows": rows}
        base.update(kw)
        return decide(base, mode)

    r = O("enforce", "done")
    ck(r["verdict"] == "BLOCK" and "Owner rule (LC-2167)" in r["block"] and "open PR pr:o/r#7" in r["block"], "enforce: open PR, no owner -> BLOCK")
    ck(r["block"].startswith(OWN), "owner block starts with the mod's name")
    ck(O("enforce", "done\nNext owner: the operator, merge approval")["verdict"] == "PASS", "enforce: owner named -> PASS")
    ck(O("enforce", "ABANDONED BY OPERATOR\n> stop this one")["verdict"] == "PASS", "enforce: written abandon -> PASS")
    ck(O("enforce", "done", session=ses("session_p"))["verdict"] == "PASS", "enforce: child never blocked")
    ck(O("enforce", "done", session=ses("session_p"))["owner"]["verdict"] == "NOT CHECKED", "enforce: child owner verdict NOT CHECKED")
    r = O("enforce", "done", blocks=3)
    ck(r["verdict"] != "BLOCK" and r.get("released") is True and "released" in r["owner"]["reason"], "enforce: released after MAX_BLOCKS")
    ck(O("enforce", "done", blocks=2)["verdict"] == "BLOCK", "enforce: second refusal still blocks")
    r = O("shadow", "done")
    ck(r["verdict"] == "PASS" and r["block"] is None and r["shadow"].startswith(f"{OWN} SHADOW owner rule would block"), "shadow: never blocks, says it would")
    ck(r["owner"]["verdict"] == "MISS", "shadow: receipt records the miss")
    ck("shadow" not in O("shadow", "Next owner: this session, check-in 18:05Z"), "shadow: no toast when an owner is named")
    r = O("off", "done")
    ck(r["verdict"] == "PASS" and r["owner"]["verdict"] == "OFF" and "shadow" not in r, "off: nothing")
    r = O(None, "done")
    ck(r["verdict"] == "PASS" and r["owner"]["verdict"] == "NOT CHECKED", "unreadable mode: NOT CHECKED, never blocks")
    r = O("enforce", "done", extra=[row_use("m", MPR, {"owner": "o", "repo": "r", "pullNumber": 7}), row_res("m", '{"merged":true}')])
    ck(r["verdict"] == "PASS" and r["owner"]["reason"] == "no open deliverable", "enforce: merged in session -> nothing open")
    r = O("enforce", "done", watchers={**{w_: '{"active":[],"finished":[]}' for w_ in WATCHERS}, "pr-ci-watch": '{"active":[],"finished":["pr:o/r#7"]}'})
    ck(r["verdict"] == "PASS", "enforce: pr-ci-watch saw it finish -> not open")
    r = O("enforce", "done", watchers={**{w_: '{"active":[],"finished":[]}' for w_ in WATCHERS}, "pr-ci-watch": '{"active":["pr:o/r#7"],"finished":[]}'},
          calls=[c(SL, {"delay_minutes": 30})])
    ck(r["verdict"] == "BLOCK" and r["block"].count("pr:o/r#7") == 1, "enforce: a watched PR is listed once; check-in alone is not an owner")
    r = O("enforce", "done", children=kids)
    ck(r["verdict"] == "BLOCK" and "Idle backstop" in r["block"] and "owner" in r, "the live check-in rule still blocks first")
    r = decide({"now_ms": NOW, "calls": [], "children": H + "0", "session": ses(None), "blocks": 0,
                "watchers": {w_: '{"active":[],"finished":[]}' for w_ in WATCHERS}}, "enforce")
    ck(r["verdict"] == "PASS" and r["owner"]["verdict"] == "NOT CHECKED", "no transcript: owner NOT CHECKED, live PASS kept")
    r = decide({"now_ms": NOW, "calls": [], "children": H + "0", "session": ses(None), "blocks": 0, "transcript_rows": [row_prompt(), row_reply("hi")],
                "watchers": {w_: '{"active":[],"finished":[]}' for w_ in WATCHERS}}, "enforce")
    ck(r["owner"]["verdict"] == "PASS" and r["owner"]["reason"] == "no open deliverable", "nothing open, no owner needed")
    r = decide({"now_ms": NOW, "calls": [], "children": H + "0", "session": ses(None), "blocks": 0,
                "transcript_rows": [row_prompt(), *pr_rows[1:3], row_reply("done")],
                "watchers": {w_: '{"active":[],"finished":[]}' for w_ in WATCHERS}})
    ck(r["verdict"] == "BLOCK" and "Owner rule (LC-2167)" in r["block"], "default mode comes from the shipped file (enforce)")
    ck(owner_check({"transcript_rows": "junk"}, [], "enforce")["verdict"] == "NOT CHECKED", "junk rows: NOT CHECKED")
    # Project threads (LC-2200): the person reads only the post_message text, never a trailing assistant line.
    PM = "mcp__hearthbot__post_message"
    post = lambda i, t: row_use(i, PM, {"text": t})  # noqa: E731
    r = O("enforce", "Posted.", extra=[post("p1", "Merged.\n\nNext owner: the operator, enforce decision"), row_res("p1", "{}")])
    ck(r["verdict"] == "PASS" and "the operator" in r["owner"]["reason"], "thread: owner line in post_message counts, trailing text ignored")
    r = O("enforce", "Next owner: this session", extra=[post("p1", "Merged."), row_res("p1", "{}")])
    ck(r["verdict"] == "BLOCK", "thread: an owner only in the unseen trailing text does not count")
    r = O("enforce", "x", extra=[post("p1", "Next owner: me, 17:00"), row_res("p1", "{}"), post("p2", "Merged."), row_res("p2", "{}")])
    ck(r["verdict"] == "BLOCK", "thread: the LAST post_message is the reply")
    r = O("enforce", "x", extra=[post("p1", "ABANDONED BY OPERATOR\n> drop it"), row_res("p1", "{}")])
    ck(r["verdict"] == "PASS", "thread: written abandon in post_message")
    old = [row_prompt(), row_use("q", PM, {"text": "Next owner: stale turn"}), row_res("q", "{}"), row_prompt(), row_reply("plain")]
    ck(final_reply(old) == "plain", "a post_message from an earlier turn is not this turn's reply")
    ck(final_reply([row_prompt(), row_use("q", PM, {"text": 5}), row_reply("plain")]) == "plain", "non-text post_message input ignored")
    ck(final_reply([row_prompt(), row_use("q", "mcp__other__post", {"text": "no"}), row_reply("plain")]) == "plain", "only the thread reply tool counts")
    # A PR the merge queue merged outside the session (2026-11-17 replay of a real thread).
    note = '{"outcome":"merged","pr":"o/r#7"}'
    ck(session_prs(pr_rows + [row_use("n", "ReadNotifications", {}), row_res("n", "event " + note)]) == [], "queue merge seen in a notification")
    ck(session_prs(pr_rows + [{"type": "user", "message": {"content": "wake " + note}}]) == [], "queue merge seen in a wake")
    ck(session_prs(pr_rows + [row_use("n", "ReadNotifications", {}), row_res("n", '{"outcome": "closed", "pr": "o/r#7"}')]) == [], "closed, spaced JSON")
    ck(session_prs(pr_rows + [row_use("n", "ReadNotifications", {}), row_res("n", '{"outcome":"merged","pr":"o/r#77"}')]) == ["pr:o/r#7"], "another PR's merge leaves this one open")
    ck(session_prs(pr_rows + [row_use("n", "ReadNotifications", {}), row_res("n", '{"outcome":"opened","pr":"o/r#7"}')]) == ["pr:o/r#7"], "only merged/closed end a PR")
    # A deliberately silent thread turn keeps the owner from the last reply the person saw.
    NR = "mcp__hearthbot__no_reply_needed"
    said = [post("p1", "Queued.\nNext owner: this thread, watching the queue"), row_res("p1", "{}")]
    quiet = [row_prompt(), row_use("z", NR, {}), row_res("z", "ok"), row_reply("nothing to do")]
    r = O("enforce", "x", extra=said + quiet)
    ck(r["verdict"] == "PASS" and "watching the queue" in r["owner"]["reason"], "silent turn: last reply's owner stands")
    ck(O("enforce", "x", extra=quiet)["verdict"] == "BLOCK", "silent turn with no earlier owner still blocks")
    r = O("enforce", "x", extra=said + [row_prompt(), row_use("z", NR, {}), row_res("z", "ok"), post("p2", "Merged."), row_res("p2", "{}")])
    ck(r["verdict"] == "BLOCK", "a turn that posts is not silent: its own reply must name the owner")
    ck(not silent_turn([row_prompt(), row_reply("hi")]), "a plain terminal turn is not silent")
    ck(not silent_turn([row_use("z", NR, {}), row_prompt(), row_reply("hi")]), "an earlier turn's no_reply_needed does not count")
    ck(not silent_turn([row_prompt(), {**row_use("z", NR, {}), "isSidechain": True}]), "a subagent's no_reply_needed does not count")
    ck(last_posted([row_prompt(), row_reply("x")]) == "", "no post: empty")
    # --replay: one receipt per real turn end that left something open.
    t = lambda ts: {"timestamp": ts}  # noqa: E731
    rp = [{**row_prompt(), **t("2026-11-17T10:00:00Z")}, *pr_rows[1:3], {**row_reply("done"), **t("2026-11-17T10:01:00Z")},
          {**row_prompt(), **t("2026-11-17T10:02:00Z")}, {**row_reply("cut by compaction"), **t("2026-11-17T10:03:00Z")},
          {**row_prompt(), "isCompactSummary": True}, {**row_reply("Next owner: the operator"), **t("2026-11-17T10:05:00Z")},
          row_prompt(), row_reply("hi")]
    got = replay(rp)
    ck(len(got) == 3, "replay: three real turn ends with the PR open")
    ck(got[0] == "2026-11-17T10:01  MISS: 1 open deliverable(s) and the final reply names no next owner", "replay: first end MISS with time")
    ck(got[1].startswith("2026-11-17T10:05  PASS: 1 open; next owner: the operator"), "replay: the turn cut by compaction is skipped")
    ck(replay([row_prompt(), row_reply("hi"), row_prompt(), row_reply("x")]) == [], "replay: nothing open, no lines")
    ck(replay([row_prompt(), *pr_rows[1:3], row_reply("x")])[0].startswith("?  MISS"), "replay: no timestamp shows ?")
    side = {**row_use("s", PM, {"text": "Next owner: a subagent"}), "isSidechain": True}
    ck(final_reply([row_prompt(), side, row_reply("plain")]) == "plain", "a subagent's post_message is not the reply")

    import subprocess
    me = [sys.executable, "-I", __file__]
    payload = {"now_ms": NOW, "calls": [], "children": kids, "session": ses(None), "blocks": 0,
               "watchers": {w_: '{"active":[],"finished":[]}' for w_ in WATCHERS}}
    r = subprocess.run(me, capture_output=True, text=True, input=json.dumps(payload))
    ck(r.returncode == 0 and json.loads(r.stdout)["verdict"] == "BLOCK", "main(): emits BLOCK")
    r = subprocess.run(me, capture_output=True, text=True, input="{x")
    ck(r.returncode == 1 and r.stdout == "", "main(): junk input fails open and visible")
    with __import__("tempfile").TemporaryDirectory() as d:
        tp = os.path.join(d, "t.jsonl")
        with open(tp, "w") as fh:
            fh.write("\n".join(json.dumps(x) for x in rp))
        r = subprocess.run(me + ["--replay", tp], capture_output=True, text=True)
        ck(r.returncode == 0 and r.stdout.rstrip().endswith("turn ends with an open deliverable: 3; would block: 2")
           and "10:05  PASS" in r.stdout, "main(): --replay prints receipts and the tally")
        with open(tp, "w") as fh:
            fh.write(json.dumps(row_prompt()) + "\n" + json.dumps(row_reply("hi")))
        r = subprocess.run(me + ["--replay", tp], capture_output=True, text=True)
        ck(r.stdout.startswith("no turn end left an open deliverable") and "would block: 0" in r.stdout, "main(): --replay, nothing open")
    for bad in ("", "[1]", "{}", '{"calls": []}'):
        r = subprocess.run(me, capture_output=True, text=True, input=bad)
        ck(r.returncode == 1 and r.stdout == "", f"main(): {bad!r} is not a payload: fails open and visible")

    # LC-2061: check-ins the SERVER lists for this session count, even when this process never saw them made
    iso = lambda ms: datetime.fromtimestamp(ms / 1000, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    trig = lambda mins, **kw: {"id": "trig_x", "enabled": True, "persist_session": True, "persistent_session_id": "session_1",
                               "next_run_at": iso(NOW + mins * MIN), **kw}
    page = lambda *rows: json.dumps({"data": list(rows), "has_more": False})
    ck(session_id(ses(None)) == "session_1" and session_id("x") is None and session_id(None) is None, "session id read from get_session")
    ck(server_check_in([page(trig(20))], ses(None), NOW) == (NOW + 20 * MIN, None), "a pending task bound to this session counts")
    ck(server_check_in([page(trig(90))], ses(None), NOW) == (None, NOW + 90 * MIN), "a task beyond the window is reported as late")
    ck(server_check_in([page(trig(20, persistent_session_id="session_other"))], ses(None), NOW) == (None, None), "another session's task does not count")
    ck(server_check_in([page(trig(20, enabled=False))], ses(None), NOW) == (None, None), "a disabled task does not count")
    ck(server_check_in([page(trig(20, persist_session=False))], ses(None), NOW) == (None, None), "a task that starts a fresh session does not count")
    ck(server_check_in([page(trig(-5))], ses(None), NOW) == (None, None) and server_check_in([page(trig(0))], ses(None), NOW) == (None, None), "a task due now or past is spent")
    ck(server_check_in([page(trig(35))], ses(None), NOW) == (NOW + 35 * MIN, None), "exactly at the window edge counts")
    ck(server_check_in([page(trig(50), trig(30)), page(trig(10), trig(70))], ses(None), NOW) == (NOW + 10 * MIN, NOW + 50 * MIN), "soonest of each, across pages")
    ck(server_check_in([page(trig(20))], "unreadable", NOW) == (None, None), "no session id: nothing counted")
    ck(session_id(json.dumps({"ccr": {"id": ""}})) is None and session_id(json.dumps({"ccr": {"id": 7}})) is None, "an empty or non-string id is no id")
    ck(server_check_in([page(trig(20, persistent_session_id=None))], "unreadable", NOW) == (None, None), "no session id never matches an unbound task")
    ck(server_check_in(None, ses(None), NOW) == (None, None) and server_check_in(["junk", 3, '{"data": "x"}', page("x", 4)], ses(None), NOW) == (None, None), "junk pages")
    r = D(children=kids, triggers=[page(trig(25))])
    ck(r["verdict"] == "PASS" and "22:25Z" in r["reason"], "a server-listed check-in armed in an earlier turn -> PASS (LC-2061)")
    r = D(children=kids, triggers=[page(trig(25, persistent_session_id="session_other"))])
    ck(r["verdict"] == "BLOCK", "another session's check-in still BLOCKs")
    r = D(children=kids, calls=[c(SL, {"delay_minutes": 30})], triggers=[page(trig(12))])
    ck(r["verdict"] == "PASS" and "22:12Z" in r["reason"], "the soonest of recorded calls and server tasks is named")
    r = D(children=kids, triggers=[page(trig(80))], calls=[c(SL, {"delay_minutes": 90})])
    ck(r["verdict"] == "BLOCK" and "fires at 23:20Z (80 min away)" in r["block"], "the soonest late check-in from either source is named")

    print(f"idle-backstop-guard selftest: {checks - fails}/{checks} checks passed")
    return 1 if fails else 0


# Mutation note (LC-2043): the two survivors on this line cannot be killed from inside, because the selftest itself is
# started by this line; claude-mods.yml reads the selftest count line, so a dead entry point fails CI there.
if __name__ == "__main__":
    raise SystemExit(main())
