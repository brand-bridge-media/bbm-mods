#!/usr/bin/env python3
"""Contract test: PY_HELPER (embedded in hooks/logic.ts) against the REAL refresh_conductor.py.

WHY. The mod's TypeScript tests mock `process.run`, so nothing in them executes the Python the mod
hands the conductor. If the conductor renames `evaluate` / `snapshot_row` / `normalise_row` /
`SECTIONS_V2`, or changes the plan JSON, the mod would silently go "plan unreadable" (fail closed,
but useless) with every test green. This runs the helper for real, so that drift turns CI red.

Run: python3 -I claude-mods/run-state/tests/contract_py_helper.py   (needs pydantic>=2)
"""
import ast
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
LOGIC = ROOT / "claude-mods/run-state/hooks/logic.ts"
CONDUCTOR = ROOT / "webflow/bulk-operations/refresh-conductor/refresh_conductor.py"


def helper_source() -> str:
    text = LOGIC.read_text()
    m = re.search(r"export const PY_HELPER = \[\n(.*?)\n\]\.join\('\\n'\)", text, re.S)
    if not m:
        raise SystemExit("FAIL: PY_HELPER block not found in logic.ts (format changed?)")
    lines = [ast.literal_eval(ln.strip().rstrip(",")) for ln in m.group(1).splitlines() if ln.strip()]
    if len(lines) < 10:
        raise SystemExit(f"FAIL: only {len(lines)} helper lines extracted")
    return "\n".join(lines)


def run(src: str, row: dict) -> subprocess.CompletedProcess:
    return subprocess.run([sys.executable, "-I", "-c", src, str(CONDUCTOR)],
                          input=json.dumps(row), capture_output=True, text=True, timeout=60)


def row(version: int) -> dict:
    return {
        "id": "11111111-2222-4333-8444-555555555555",
        "article_slug": "contract-fixture",
        "status": "in_progress",
        "pipeline_version": version,
        "created_at": "2026-10-07T00:00:00+00:00",
        "stages": [{"stage": 0, "status": "done", "at": "2026-10-07T00:00:00+00:00"}],
        "selection_provenance": {"technical_audit": {"pass_a": {"verdict": "PASS", "at": "2026-10-06T00:00:00Z"}}},
    }


def check(cond: bool, msg: str, fails: list) -> None:
    print(("ok   " if cond else "FAIL ") + msg)
    if not cond:
        fails.append(msg)


def main() -> int:
    src = helper_source()
    fails: list = []
    for version, first in ((2, "v2_s0"), (1, "s0")):
        p = run(src, row(version))
        check(p.returncode == 0, f"v{version}: helper exits 0 (stderr: {p.stderr.strip()[-200:]})", fails)
        if p.returncode != 0:
            continue
        out = json.loads(p.stdout)
        plan, table = out["plan"], out["table"]
        states = {s["id"]: s["state"] for s in plan["sections"]}
        check(plan["run_id"] == row(version)["id"] and plan["slug"] == "contract-fixture", f"v{version}: run id + slug carried", fails)
        check(states.get(first) == "DONE", f"v{version}: stage-0 receipt makes {first} DONE", fails)
        check(any(v == "READY" for v in states.values()), f"v{version}: something is READY after stage 0", fails)
        check(any(v == "BLOCKED" for v in states.values()), f"v{version}: something is still BLOCKED", fails)
        ids = {t["id"] for t in table}
        check(ids == set(states), f"v{version}: stage/part table covers exactly the plan's sections", fails)
        check(all(isinstance(t["stage"], (int, float)) for t in table), f"v{version}: every table row has a numeric stage", fails)
        check(out["pass_a"] == {"verdict": "PASS", "at": "2026-10-06T00:00:00Z"}, f"v{version}: Pass A verdict + time read from provenance", fails)
    # Input that is not a row at all must exit non-zero (the mod turns that into "plan unreadable").
    junk = subprocess.run([sys.executable, "-I", "-c", src, str(CONDUCTOR)],
                          input="not json", capture_output=True, text=True, timeout=60)
    check(junk.returncode != 0, "non-JSON input exits non-zero", fails)
    print(f"contract: {'FAILED' if fails else 'passed'} ({len(fails)} failure(s))")
    return 1 if fails else 0


if __name__ == "__main__":
    raise SystemExit(main())
