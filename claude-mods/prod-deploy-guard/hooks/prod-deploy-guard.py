#!/usr/bin/env python3
"""PreToolUse guard — production changes ship through a merged PR, not a session (LCH-528).

WHAT IT DOES. Refuses the session-side shortcuts to production that CLAUDE.md §4
forbids outside a declared emergency:

  * Supabase MCP `deploy_edge_function`                      -> DENY
  * Bash `wrangler deploy|publish|versions deploy`,
    `supabase functions deploy`, `supabase db push`,
    `npm|pnpm|yarn run deploy`                               -> DENY
  * Supabase MCP `execute_sql` carrying DDL (CREATE, ALTER,
    DROP, GRANT, REVOKE, COMMENT ON, DO blocks)              -> DENY
  * Supabase MCP `apply_migration`                           -> ASK

WHY. "GitHub IS production" (LC-421) and "migrations are forward-only" (LC-428)
were sentences in CLAUDE.md and in Stan's preferences. A sentence is enforced only
when it happens to be remembered. Commits cause deploys; a deploy that skips the PR
has no diff review, no CI gate and no audit row. DDL run through execute_sql is the
worst case: it changes the live schema AND leaves no migration file, so the repo and
production silently disagree from then on.

WHY apply_migration ASKS INSTEAD OF DENYING. It at least records a migration in
Supabase's history, and a declared emergency is the one sanctioned exception. An
ask puts that call in front of Stan; deploy-supabase-migrations.yml remains the
normal path (commit supabase/migrations/<ts>_name.sql, merge, CI applies it).

WHAT IS NOT GATED, DELIBERATELY. `--dry-run` deploys (they change nothing). SET ROLE / SET SESSION AUTHORIZATION: they change
only this connection's privileges for its own lifetime and leave nothing behind in
the schema; the MCP already connects with full rights. DROP of a temp table is still
denied: the guard cannot tell a temp table's name from a real one, and refusing is the
safe direction. REFRESH MATERIALIZED VIEW:
rewrites view data, not shape. Temp tables (CREATE TEMP/TEMPORARY ...) are session-local and
harmless. Text that merely names a command (grep, echo, a commit message) is not a
command: Bash is tokenised and only a command's own argv is judged.

Self-test: python3 prod-deploy-guard.py --selftest
"""
from __future__ import annotations

import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import sql_lexer  # noqa: E402

DDL_VERBS = ("create", "alter", "drop", "grant", "revoke", "comment", "do",
             "security", "reassign", "import")
# `select ... into new_table` is CREATE TABLE AS in disguise; `into temp` is session-local.
SELECT_INTO = re.compile(
    r"into\s+(?P<mods>(?:(?:unlogged|temp|temporary|local|global|table)\s+)*)[\w.]+")
TEMP_CREATE = re.compile(
    r"^create\s+(?:or\s+replace\s+)?(?:(?:global|local)\s+)?(?:temp|temporary)\s+")

# Bash is judged on the argv of each simple command, after a shell-like tokenise:
# quotes keep `echo "a; wrangler deploy"` one word, operators and control keywords
# (; && || | & ( ) { } ! then do else ...) start a new command, and wrappers that run
# their argument (sudo, timeout, env, npx, pnpm exec, bash -c, eval) are unwrapped.
# Regex over raw shell text was tried first and lost to 16 realistic bypasses (LCH-528).
_OPS = (";;", "&&", "||", "|&", "$(", ";", "&", "|", "(", ")", "`", "\n")
_CONTROL = {"if", "then", "do", "else", "elif", "while", "until", "{", "}", "!", "time"}
_PREFIXES = {"sudo", "doas", "time", "env", "nice", "nohup", "command", "exec", "xargs", "corepack", "watch",
             "timeout", "stdbuf", "ionice", "caffeinate", "chronic"}
_VALUE_FLAGS = {"sudo": {"-u", "-g", "-C", "-D"}, "nice": {"-n"}, "watch": {"-n", "--interval"}, "timeout": {"-s", "-k"},
                "env": {"-u", "-C", "-S"}, "ionice": {"-c", "-n"}, "xargs": {"-n", "-I", "-P"}}
_SHELLS = {"bash", "sh", "zsh", "dash", "ksh"}
_RUNNERS = {"npx", "bunx", "pnpx"}
_PM = {"npm", "pnpm", "yarn", "bun"}
_PM_EXEC = {"exec", "dlx", "x"}
_PM_SAFE = {"install", "i", "ci", "add", "remove", "rm", "uninstall", "info", "view", "why",
            "ls", "list", "search", "outdated", "audit", "help"}
_ASSIGN = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=")

PR_PATH = (" Production deploys originate from a merged PR (CLAUDE.md §4, LC-421): "
           "PR -> review diff -> merge to main -> GitHub Actions deploys. Push this to a "
           "branch and open a PR instead. If this is a declared emergency, stop and ask Stan; "
           "he runs it himself.")


def ddl_statements(sql: str) -> list[str]:
    hits = []
    for st in sql_lexer.statements(sql):
        # `( create ... )` and `explain analyze create ...` both execute the inner statement.
        st = re.sub(r"^(?:\(\s*)+", "", st)
        st = re.sub(r"^explain\s+(?:\([^)]*\)\s*|(?:analyze|verbose)\s+)*", "", st)
        verb = (re.match(r"[a-z]+", st) or [""])[0]
        if verb in DDL_VERBS and not TEMP_CREATE.match(st):
            hits.append(st[:80])
        elif verb in ("select", "with"):
            # SELECT ... INTO <table> is CREATE TABLE AS; only TEMP/TEMPORARY is session-local.
            # Only a top-level INTO: one inside a CTE body belongs to that INSERT.
            at = sql_lexer.find_top(st, "into")
            m = SELECT_INTO.match(st, at) if at >= 0 else None
            if m and not re.search(r"\btemp(?:orary)?\b", m.group("mods")):
                hits.append(st[:80])
    return hits


def evaluate(tool_name: str, tool_input: dict) -> tuple[str, str] | None:
    name = tool_name or ""
    low = name.lower()
    if low.startswith("mcp__") and "supabase" in low:
        if low.endswith("__deploy_edge_function"):
            fn = tool_input.get("name") or tool_input.get("slug") or "?"
            return "deny", f"[mod:prod-deploy-guard] REFUSED: deploy_edge_function ({fn}).{PR_PATH}"
        if low.endswith("__apply_migration"):
            mig = tool_input.get("name") or "?"
            return "ask", (
                f"[mod:prod-deploy-guard] apply_migration ({mig}) changes the live schema from a "
                "session. The normal path is a committed supabase/migrations/<ts>_name.sql that "
                "deploy-supabase-migrations.yml applies on merge (LC-428). Approve only for a "
                "declared emergency, and commit the same file right after.")
        if low.endswith("__execute_sql"):
            query = tool_input.get("query") or ""
            if not isinstance(query, str):
                return "deny", ("[mod:prod-deploy-guard] REFUSED: the query is not a string, so the "
                                "guard cannot check it for DDL. Send the SQL as plain text.")
            hits = ddl_statements(query)
            if hits:
                return "deny", (
                    f"[mod:prod-deploy-guard] REFUSED: DDL through execute_sql "
                    f"({'; '.join(hits)}). Schema changes are migrations (CLAUDE.md §4, LC-428): "
                    "write supabase/migrations/$(date -u +%Y%m%d%H%M%S)_name.sql, open a PR, and "
                    "CI applies it on merge. DDL run here would leave production and the repo "
                    "disagreeing. Row INSERT/UPDATE/DELETE is data, not schema, and is not "
                    "blocked by this guard.")
        return None
    if name == "Bash":
        cmd = tool_input.get("command") or ""
        label = bash_deploy(cmd if isinstance(cmd, str) else "")
        if label:
            return "deny", f"[mod:prod-deploy-guard] REFUSED: {label} from a session.{PR_PATH}"
    return None


_HEREDOC = re.compile(r"<<-?\s*(['\"]?)(\w+)\1")
_SHELL_READER = re.compile(r"(?:^|[;&|(]\s*)(?:\S*/)?(?:ba|z|da|k)?sh\b[^<]*$")


def _drop_data_heredocs(cmd: str) -> str:
    """Remove heredoc bodies fed to a non-shell (python3 - <<EOF is data, bash <<EOF runs)."""
    out, lines, i = [], cmd.split("\n"), 0
    while i < len(lines):
        line = lines[i]
        out.append(line)
        m = _HEREDOC.search(line)
        i += 1
        if m and not _SHELL_READER.search(line[:m.start()]):
            tag = m.group(2)
            while i < len(lines) and lines[i].strip() != tag:
                i += 1
            i += 1
    return "\n".join(out)


def shell_commands(cmd: str) -> list[list[str]]:
    """Split shell text into simple commands (argv lists), quotes and escapes honoured."""
    cmds: list[list[str]] = []
    argv: list[str] = []
    word: list[str] = []
    in_word = False
    i, n = 0, len(cmd)

    def end_word() -> None:
        nonlocal word, in_word
        if in_word:
            argv.append("".join(word))
        word, in_word = [], False

    def end_cmd() -> None:
        nonlocal argv
        end_word()
        while argv and argv[0] in _CONTROL:
            argv = argv[1:]
        if argv:
            cmds.append(argv)
        argv = []

    while i < n:
        c = cmd[i]
        if c == "\\":
            if i + 1 < n and cmd[i + 1] != "\n":
                word.append(cmd[i + 1])
                in_word = True
            i += 2
            continue
        if c == "'":
            j = cmd.find("'", i + 1)
            j = n if j < 0 else j
            word.append(cmd[i + 1:j])
            in_word = True
            i = j + 1
            continue
        if c == '"':
            i += 1
            while i < n and cmd[i] != '"':
                if cmd[i] == "\\" and i + 1 < n:
                    i += 1
                word.append(cmd[i])
                i += 1
            in_word = True
            i += 1
            continue
        if c == "#" and not in_word:
            j = cmd.find("\n", i)
            i = n if j < 0 else j
            continue
        op = next((o for o in _OPS if cmd.startswith(o, i)), None)
        if op:
            end_cmd()
            i += len(op)
            continue
        if c in "<>":
            end_word()
            i += 1
            continue
        if c.isspace():
            end_word()
            i += 1
            continue
        word.append(c)
        in_word = True
        i += 1
    end_cmd()
    return cmds


def _base(w: str) -> str:
    return w.rsplit("/", 1)[-1].split("@", 1)[0]


def _unwrap(argv: list[str]) -> list[str]:
    """Drop env assignments and wrappers that run their argument (sudo, timeout, npx ...)."""
    for _ in range(10):
        while argv and _ASSIGN.match(argv[0]):
            argv = argv[1:]
        if not argv:
            return argv
        head = _base(argv[0])
        if head in _PREFIXES:
            rest, value_flags = argv[1:], _VALUE_FLAGS.get(head, set())
            # `env A=1 cmd`: the assignments after env are stripped by the loop's first step.
            while rest and rest[0].startswith("-"):
                rest = rest[2:] if rest[0] in value_flags else rest[1:]
            if head == "timeout" and rest:
                rest = rest[1:]  # the duration
            argv = rest
            continue
        if head in _RUNNERS or (head in _PM and len(argv) > 1 and _first_positional(argv[1:]) in _PM_EXEC):
            rest = argv[1:]
            if head in _PM:
                rest = rest[rest.index(_first_positional(rest)) + 1:]
            while rest and rest[0].startswith("-"):
                rest = rest[1:]
            argv = rest
            continue
        return argv
    return argv


def _first_positional(words: list[str]) -> str | None:
    return next((w for w in words if not w.startswith("-")), None)


def _judge(argv: list[str], depth: int) -> str | None:
    argv = _unwrap(argv)
    if not argv:
        return None
    head, rest = _base(argv[0]), argv[1:]
    words = [w for w in rest if not w.startswith("-")]
    dry = "--dry-run" in rest
    if head in _SHELLS and depth < 3:
        for k, w in enumerate(rest):
            if w.startswith("-") and not w.startswith("--") and "c" in w and k + 1 < len(rest):
                return bash_deploy(rest[k + 1], depth + 1)
        return None
    if head == "eval" and depth < 3:
        return bash_deploy(" ".join(rest), depth + 1)
    if head == "wrangler":
        if not dry and any(w in ("deploy", "publish") for w in words):
            return "wrangler deploy"
        return None
    if head == "supabase":
        pairs = set(zip(words, words[1:]))
        if not dry and ("functions", "deploy") in pairs:
            return "supabase functions deploy"
        if not dry and ("db", "push") in pairs:
            return "supabase db push"
        return None
    # `deploy` or a namespaced `deploy:prod` script; install/view/... of a package is not.
    if head in _PM and any(w == "deploy" or w.startswith("deploy:") for w in words) \
            and _first_positional(rest) not in _PM_SAFE:
        return "npm run deploy"
    return None


def bash_deploy(cmd: str, depth: int = 0) -> str | None:
    """Label of the first production deploy this shell text would run, else None."""
    for argv in shell_commands(_drop_data_heredocs(cmd)):
        label = _judge(argv, depth)
        if label:
            return label
    return None


def emit(decision: str, reason: str) -> None:
    json.dump({"hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": decision,
        "permissionDecisionReason": reason,
    }}, sys.stdout)
    sys.stdout.write("\n")


def _selftest() -> int:
    checks = fails = 0

    def ck(cond: bool, label: str) -> None:
        nonlocal checks, fails
        checks += 1
        if not cond:
            fails += 1
            sys.stderr.write(f"  FAIL: {label}\n")

    def d(tool: str, **inp) -> str | None:
        r = evaluate(tool, inp)
        return r[0] if r else None

    SQL = "mcp__Supabase__execute_sql"
    ck(d("mcp__Supabase__deploy_edge_function", name="x") == "deny", "MCP edge deploy denied")
    ck(d("mcp__Supabase__apply_migration", name="m", query="alter table t add c int") == "ask",
       "apply_migration asks")
    for q in ("alter table products add column x int",
              "CREATE INDEX i ON t(c)", "drop view v", "grant select on t to anon",
              "comment on table t is 'x'", "do $$ begin perform 1; end $$",
              "create or replace function f() returns int language sql as $$ select 1 $$",
              "select 1; drop table t", "select * into new_products from products",
              "SELECT a INTO TABLE public.x FROM t", "with s as (select 1) select * into x from s",
              "select * into unlogged new_products from products",
              "select now() as ts into audit_snapshot", "select 1 as x into public.snap",
              "insert into t(a) values (E'it\\'s'); drop table z",
              "insert into t(a) values (E'it\\'s'); create table z(a int)",
              "explain analyze create table z as select 1", "explain (analyze, buffers) drop table z",
              "select 1; DO$$ begin drop table z; end $$", "( select 1 ) ; (create table z(a int))",
              "with s as (select 1) select * into unlogged table x from s"):
        ck(d(SQL, query=q) == "deny", f"DDL denied: {q[:40]}")
    for q in ("select * from products where name ilike '%drop table%'",
              "insert into knowledge_memories(content) values ('ALTER TABLE x; DROP y')",
              "update t set a = 1 where id = 'x'",
              "create temp table scratch as select 1", "create temporary table s (a int)",
              "explain select 1", "-- drop table t\nselect 1", "with x as (select 1) select * from x",
              "select * into temp scratch from products", "select * into temporary table s from t",
              "select * into local temp s from t",
              "create or replace temp view v as select 1",
              "with i as (insert into t select 1 returning *) select * from i", "insert into t select * from s",
              "refresh materialized view mv"):
        ck(d(SQL, query=q) is None, f"not DDL: {q[:40]}")
    for c in ("wrangler deploy", "npx wrangler deploy --env production",
              "cd cloudflare-workers/link-redirect && npx wrangler@3 deploy",
              "CLOUDFLARE_API_TOKEN=x wrangler versions deploy", "supabase functions deploy foo",
              "npx supabase db push", "npm run deploy", "(cd w; pnpm dlx wrangler publish)",
              "./node_modules/.bin/wrangler deploy", 'bash -c "wrangler deploy"',
              "sh -lc 'cd w && npx supabase db push'", 'zsh -c "npm run deploy"',
              "wrangler \\\ndeploy", "supabase functions \\\n  deploy foo",
              "eval 'wrangler deploy'", "sudo wrangler deploy", "time wrangler deploy",
              "env wrangler deploy", "nice -n 5 npx wrangler deploy", "sudo -E supabase db push",
              "nohup npm run deploy &", "X=1 env Y=2 wrangler deploy",
              "if [ -f wrangler.toml ]; then wrangler deploy; fi", "for d in a b; do wrangler deploy; done",
              "{ wrangler deploy; }", "! wrangler deploy", "pnpm wrangler deploy", "npm exec wrangler deploy",
              "npm exec -- wrangler deploy", "pnpx wrangler deploy",
              "npm --prefix cloudflare-workers/link-redirect run deploy", "pnpm --filter link-redirect run deploy",
              "pnpm --filter link-redirect deploy", "npm run -s deploy", "npm run-script deploy",
              "yarn workspace w run deploy", "npm run deploy:prod", "corepack npm run deploy", "watch -n 5 wrangler deploy",
              "pnpm run deploy:production", "yarn run deploy:workers", "pnpm deploy:prod", "timeout 120 npx wrangler deploy", "/usr/bin/env wrangler deploy",
              "supabase --debug functions deploy foo", "supabase --workdir . db push",
              "sudo -u ci wrangler deploy", "out=$(wrangler deploy)", "echo x && `wrangler deploy`", "bash -c \"sh -c 'wrangler deploy'\"",
              "bash <<'EOF'\nwrangler deploy\nEOF", "cat x | sh <<EOF\nnpm run deploy\nEOF",
              "python3 - <<EOF\nwrangler deploy\nEOF\nwrangler deploy"):
        ck(d("Bash", command=c) == "deny", f"bash deploy denied: {c}")
    for c in ("grep -rn 'wrangler deploy' .", "echo supabase functions deploy",
              "git commit -m 'stop running wrangler deploy by hand'", "wrangler dev",
              "wrangler tail link-redirect", "npx wrangler deployments list",
              "supabase functions serve", "cat deploy.sh", 'bash -c "echo wrangler deploy"',
              "grep -c 'wrangler deploy' notes.md", "ls \\\n  -la",
              "npx wrangler deploy --dry-run --outdir dist", "supabase db push --dry-run",
              'git commit -m "fix; wrangler deploy docs"', 'echo "done && npm run deploy"',
              'gh pr create --body "Steps:\nnpm run deploy was NOT run\n"', "npm install deploy-tools",
              "npm view deploy", "npm run deployment-notes", "npm run predeploy-check", "# wrangler deploy\nls", "wrangler deployments list --name x",
              "printf '%s' 'a | wrangler deploy'",
              "python3 - <<'EOF'\n./node_modules/.bin/wrangler deploy\nEOF\nls",
              "cat > notes.md <<EOF\nwrangler deploy\nEOF",
              "python3 - <<'EOF'\nx = 1\ny = 2\nwrangler deploy\nEOF\nls",
              'echo "./node_modules/.bin/wrangler deploy"'):
        ck(d("Bash", command=c) is None, f"bash allowed: {c}")
    ck(d("mcp__Supabase__list_tables") is None, "read-only Supabase untouched")
    ck(d(SQL, query={"raw": "drop table t"}) == "deny", "non-string query fails closed")
    ck(d(SQL, query="set role service_role") is None, "SET ROLE is a documented non-goal")
    # The tokenizer itself: quotes, escapes, comments, redirections.
    for text, want in (("", []), ("   ", []), ("# only a comment", []), ("# x\nls", [["ls"]]),
                       ("echo a#b # c", [["echo", "a#b"]]), ("echo a\\ b", [["echo", "a b"]]),
                       ("echo \\\n x", [["echo", "x"]]), ("echo a\\", [["echo", "a"]]), ("echo \\x", [["echo", "x"]]),
                       ('echo "a\\"b"', [["echo", 'a"b']]), ("echo 'a\\'", [["echo", "a\\"]]),
                       ('echo ""', [["echo", ""]]), ("wrangler deploy>log", [["wrangler", "deploy", "log"]]),
                       ("cat<in", [["cat", "in"]]), ("a; b && c | d", [["a"], ["b"], ["c"], ["d"]]),
                       ("if x; then y; fi", [["x"], ["y"], ["fi"]]), ('echo "x', [["echo", "x"]])):
        ck(shell_commands(text) == want, f"shell_commands({text!r}) == {want}")
    import time as _t
    t0 = _t.monotonic()
    for adversarial in ("a=" * 4000 + "x", "sudo -" * 3000, "env " * 3000 + "ls", "a=b " * 3000):
        evaluate("Bash", {"command": adversarial})
    ck(_t.monotonic() - t0 < 2.0, "adversarial prefixes evaluate in under 2s (no backtracking blow-up)")
    ck(d("mcp__Webflow__data_cms_tool", query="drop table") is None, "non-Supabase MCP untouched")
    ck(d("Bash") is None and d(SQL) is None, "missing inputs do not crash")
    ck(d("mcp__Other__execute_sql", query="drop table t") is None,
       "an execute_sql on a non-Supabase server is not this guard's")
    ck(d("SupabaseNotes", query="drop table t") is None, "a non-MCP tool naming supabase is untouched")
    ck("(foo)" in evaluate("mcp__Supabase__deploy_edge_function", {"name": "foo"})[1],
       "deploy reason names the function")
    ck("(bar)" in evaluate("mcp__Supabase__deploy_edge_function", {"slug": "bar"})[1],
       "deploy reason falls back to slug")
    ck("(m1)" in evaluate("mcp__Supabase__apply_migration", {"name": "m1"})[1],
       "migration ask names the migration")
    r = evaluate(SQL, {"query": "drop table t"})
    ck("[mod:prod-deploy-guard]" in r[1] and "migrations" in r[1],
       "reason carries the mod callout and the migration path")

    # main(): the stdin -> JSON contract Claude Code actually calls.
    import subprocess
    def run(stdin: str) -> tuple[int, str, str]:
        r = subprocess.run([sys.executable, os.path.abspath(__file__)], input=stdin,
                           capture_output=True, text=True)
        return r.returncode, r.stdout, r.stderr
    rc, out, _ = run(json.dumps({'tool_name': 'Bash', 'tool_input': {'command': 'wrangler deploy'}}))
    ck(rc == 0 and json.loads(out)["hookSpecificOutput"]["permissionDecision"] == "deny",
       "main(): a bad call emits a deny")
    rc, out, _ = run(json.dumps({'tool_name': 'Bash', 'tool_input': {'command': 'ls'}}))
    ck(rc == 0 and out == "", "main(): a fine call emits nothing")
    rc, out, err = run("{not json")
    ck(rc == 1 and out == "" and "allowing" in err, "main(): junk input fails open and visible")
    rc, out, _ = run(json.dumps({"tool_name": 'Bash', "tool_input": "str"}))
    ck(rc == 0 and out == "", "main(): a non-dict tool_input is treated as empty")
    rc, out, _ = run("")
    ck(rc == 0 and out == "", "main(): empty stdin is silent")

    print(f"prod-deploy-guard selftest: {checks - fails}/{checks} checks passed")
    return 1 if fails else 0


def main() -> int:
    if "--selftest" in sys.argv:
        return _selftest()
    raw = sys.stdin.read()
    try:
        payload = json.loads(raw) if raw.strip() else {}
        tool_input = payload.get("tool_input") or {}
        if not isinstance(tool_input, dict):
            tool_input = {}
        verdict = evaluate(payload.get("tool_name") or "", tool_input)
    except Exception as e:  # noqa: BLE001
        # Fail OPEN and visible, matching the sibling guards: a guard that fails shut
        # blocks every Supabase call and gets deleted.
        sys.stderr.write(f"prod-deploy-guard: could not evaluate ({e}); allowing the call. "
                         "The guard is not protecting this one.\n")
        return 1
    if verdict:
        emit(*verdict)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
