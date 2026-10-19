# claude-mods

Claude Code **mods** for Brand Bridge Media sessions (LC-1711, epic LC-1074).

A mod is a Claude Code plugin made of *function hooks*: a small TypeScript module that
reacts to session events (a tool call, a prompt, a timer) and can draw a pane, a band
above the prompt, a status line or a toast, or register a tool the model can call.
Business analogy: `.claude/hooks/*.py` are door locks that say yes/no; a mod is a
dashboard bolted onto the cockpit.

## Layout

```
.claude-plugin/marketplace.json     <- REPO ROOT. Lists every mod (required at root; see below)
claude-mods/<mod>/
  .claude-plugin/plugin.json        name, version, description, author, "types"
  hooks/hooks.json                  { "modules": ["./register.tsx"] }
  hooks/register.tsx                export const register: Register = (on, options) => { ... }
  types/index.d.ts                  contract for any $.state values (if the mod keeps state)
  tests/*.test.ts                   at least one; CI fails a mod with none
```

Add a mod: create `claude-mods/<mod>/`, then append one entry to
`.claude-plugin/plugins[]` with `"source": "./claude-mods/<mod>"`. CI fails if a mod
dir is not listed.

The marketplace file sits at the **repo root**, not under `claude-mods/`: installing
`owner/repo` looks for `.claude-plugin/marketplace.json` at the root (measured: a
file under `claude-mods/` is not found).

## Mods

| Mod | What | Ticket |
| --- | --- | --- |
| `fleet-tracker` | Dashboard line per cloud session an orchestrator spawns (polls `get_session` every 90 s, wakes the orchestrator on blocked/failed/review_ready/completed, `/fleet` pane). **Auto-tracks** every `create_session` (ticket from the title/brief; `track` relabels). **Stall detection:** a WORKING session with no transcript event for 15 min gets one automatic nudge (`send_message`, priority `next`, no orchestrator tokens); still silent 10 min later, the orchestrator is woken with `STALLED` and Stan gets a toast. Transcript reads happen only when the turn-level `updated_at` is already 15 min old. A wake the host refuses (poll run inside a tool call) is queued and delivered at turn end. **Close-out (LC-1835):** `untrack` now ARCHIVES the child, but only when a fresh, error-free poll shows it COMPLETED or REVIEW_READY (anything else is refused: it may hold unpushed work); an archive error keeps the row with the error, unless the session's own status reads ARCHIVED; `keep_reason` skips the archive and records why), and a row idle in COMPLETED/REVIEW_READY for 60 min gets ONE reminder wake per bucket episode. `open_children` feeds a session-close obligation. Tools: `mcp__fleet-tracker__{track,note,untrack,status,open_children}`. | LC-1711, LC-1834, LC-1835 |
| `draft-session` | v2_s6 Draft guard: contract injected from the refresh-agent file, `/draft-done` runs draft-lint, the Draft receipt is blocked until lint passes. See below. | LC-1714 |
| `refresh-run-guard` | Fail-closed guards for the refresh run: denies `execute_sql` writes to receipt tables, Bash/Webflow publish paths and bad Webflow item payloads (non-go.livingcozy.com `product-link`, Products `main-image`, dropped `lc-deal-pill` spans); tracks Pass A freshness in the status line. | LC-1712 |
| `run-state` | Band above the prompt (run, stage, next READY section, Pass A age, missing receipts) and a write guard: a receipt write (`write_stage_receipt.py`, `article_audit.py --write-receipt`, or SQL on `refresh_runs.stages` / `refresh_run_sections`) for a BLOCKED section is **denied**; a human barrier (WAITING_STAN), a DONE/IN_PROGRESS/unknown section, an unreadable plan, or several active runs with no pin **asks** (and refuses when nobody answers). READY and FAILED (conductor re-run) pass. A write is judged against the run it names (`--run-id`/`--slug`, or the id in the SQL), else the pinned/only active run; with no active run the guard is inert for writes that name no run (a named run is still judged against its own plan). Supabase MCP server defaults to `Supabase` (userConfig `supabaseServer`). Plan = the conductor's own `evaluate()` on a `refresh_runs` row, read via the Supabase MCP, else (cloud build sessions have no MCP) PostgREST with `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`; if neither works it asks, naming every path tried, and refuses when unanswered. An empty active-run list over PostgREST is not trusted as "no active run" (a key that cannot see the table also reads `[]`): it counts as a failed path and asks. Exemptions (see "Receipt guard: plain commands" below) apply only to a plain command. `/run-state <slug\|run_id\|clear>` pins the run. Scope: gates Bash receipt writers and SQL tools only; Edit/Write and other MCP tools are intentionally not gated. Needs the repo checkout as cwd + `python3` with pydantic. | LC-1715 |
| `session-close` | Also lists the `[mod:<name>]` actions it saw (see Callout convention). Learns what a session touched from observed tool calls; `/close-out` (and a wrap-up turn) lists unmet obligations: open fleet children (from fleet-tracker's `open_children`, LC-1835; "not checked" when it is not loaded), knowledge INGEST, Jira comment per served ticket, `refresh_runs` left in_progress, +2/+4wk cannibalization and 30/60/90 GSC scheduled after a publish, Pass A/B verdicts. Nudge only, $0. | LC-1713 |
| `jira-closer` | When a session merges a PR or arms auto-merge, reads the PR's Jira keys (title, else fetched) and tells the session to read each ticket's newest comment, then transition it to Done or post a state comment. Blocks the turn's end **once** per ticket while it is untouched (the second Stop always passes, so it cannot loop). Any transition/comment/edit clears it. Sees only merges made inside a session. | LC-1729 |
| `pillar-brief-guard` | Enforces the pillar-brief rules in ANY session, on RECOGNISED actions only (tool + argv shapes; a heredoc, grep, echo or commit message that merely names a script, table or workflow is untouched). (1) `createJiraIssue` in LCC with label `article-idea` (labels read from every shape; an unreadable one fails closed) is **denied** unless the description has a `Parent article: <slug>` line AND that slug exists in `public.articles`; on allow it injects the next steps. (2) Selection/writing needs the article's approved `pillar_briefs` row (looked up through `public.articles`, Supabase MCP, default server `Supabase`; userConfig `supabaseServer`/`projectId`). Gated: a `run-heading-research.yml` dispatch with `step=shortlist` **and `apply` true** (unset, empty or false is the workflow's selftest; 1/yes/on count as true; any other value is denied), via the GitHub MCP or `gh workflow run ... -f step=shortlist -f apply=true` (numeric workflow ids count when the inputs say step=shortlist); `product_shortlist.py` / `python -m ...product_shortlist` invocations that carry a target (`--run-id`/`--article`/`--article-id`; not `--selftest`/`--dry-run`/`--render`/`--help`; no target = not a selection); `roster_materialize.py apply` (article read from `--plan`); a Write of a NEW `.md` under `bbm-content/**/articles/` whose frontmatter has `slug:` and `title:`; and the same new article via GitHub MCP `create_or_update_file` (no `sha`) / `push_files`. Shell keywords and grouping (`then do else if while ( { ! nohup exec command`) before the command are seen through. No approved brief, or a lookup that cannot run (no Supabase MCP, SQL error, unknown run, unresolvable article): **deny**, naming the step or the fix ("connect the Supabase MCP so the approved pillar brief can be checked; nothing selects products without it"); never an ask, since an unattended session cannot answer. Only a brief older than 365 days (lookup succeeded) **asks** (refused when nobody answers). (3) `pillar_brief.py approve --by`, `run-pillar-brief.yml` / `gh workflow run run-pillar-brief.yml -f mode=approve -f approved_by=`: the approver must be a configured human (userConfig `approvers`, comma-separated, default `Stan`, case-insensitive); blank, `claude`, `x` are **denied**. `run-pillar-brief.yml` defaults `approved_by` to `Stan`, so leaving it out would attribute the approval to Stan without Stan: the guard requires it to be named explicitly. `gh workflow run` of either guarded workflow with `--json` is denied (its inputs are hidden). **Not covered:** adding the `article-idea` label to an existing ticket (`editJiraIssue`); Webflow MCP writes; other selection writers (`write_stage_receipt.py`); `gh api .../dispatches`, `curl` or other HTTP dispatches; a workflow numeric id whose inputs are not step=shortlist/mode=approve; scripts run via variables, `$(...)`, `xargs`, `make` or a wrapper script; `--by "$VAR"` (the literal is judged, not its value); `push_files` cannot tell a new article from an update, so any article file in a push needs an approved brief; article files written by other tools (Bash redirects, `git`, editors outside Claude); a Write whose path has no `bbm-content` segment (the checkout directory is named otherwise); a `--selftest`/`--dry-run`/`--render` flag is trusted not to select or write (verified against `product_shortlist.py`: selftest returns first, render is local, dry-run writes nothing). Argparse prefixes of the target flags (`--run`, `--article-i`) count as targets; ambiguous or odd shell shapes err toward a deny; nested `bash -c`/`eval` payloads are followed up to 8 levels deep (beyond that, or through variables, they are not covered). $0. | LC-1731 |

### Receipt guard: plain commands (run-state, LC-1711 / LC-1735 / LC-1736)

Receipt code and its tests name the writer scripts constantly, so these are exempt from the guard: a
`--help` / `-h` / `--dry-run` / `--selftest` run of the writer itself, a segment whose first word is `echo`,
`printf`, `cat` or `tee` (it only prints or writes text), and the body of a **quoted-terminator** heredoc
(`<<'EOF'`, `<<"EOF"`) that `cat`/`tee` writes to a file. There is no shell parser to get wrong: **an
exemption applies only when the whole command is plain AND the segment's first word is on that allow-list**
(the writer, or echo / printf / cat / tee; `perl -e ... -- --help` is judged). A command that is not plain is
judged exactly as if no exemption existed, and **plain fails closed on every character the code does not
model.** The text outside a cat/tee quoted-terminator heredoc body is not plain if it contains any of:
`#`, `\`, `${`, `$'`, `$"`, a backtick, `$(`, `>(`, `<(`, a single `|`, a single `&`, an unclosed quote, a heredoc that
was not dropped, `eval` / `source` / `alias` / `function` / `name()` / a leading `.` / a `PATH=` assignment, or
`bash sh zsh python python3 node` with `-c`, `-` or a `<` after it. A command with a comment or a backslash simply
gets no exemption (a few false positives are the price; comment text is judged like any other text). A
`# Title`, a backslash or a backtick INSIDE a dropped body is just data. Redirect targets are not flags
(`W 2> --dry-run` is judged). An unquoted-terminator heredoc body is never dropped (it expands `$(...)`). A real
invocation, however chained with `&&`, `;` or a newline, is always judged.

**All-or-nothing (LC-1736).** Text written to a FILE (a cat/tee heredoc body, an `echo`/`printf` redirect) is data only
if nothing later runs that file, and the ways to run a file (`sh f`, `./f`, `timeout 5 sh f`, `( sh f )`,
`if true; then sh f; fi`, `x="sh f"; $x`, `python3 p.py`) cannot be listed. So the command is exempt only when it is
plain AND **every step** is one of: print-only `echo`/`printf`/`cat` (no `>`, no heredoc); a file write by cat/tee/echo/
printf whose TARGET is not risky (a `.git` path component, `.gitconfig`/`.gitattributes`/`.gitmodules`, `.config/git`, a `$`, or
a glob or quote in the path: a hook or config written there is run by a later `git status`; `.gitignore`, `.gitkeep` and
`.github/` are ordinary files; only the target is checked, never the text written);
the writer's own `--help` / `--dry-run` / `--selftest`; `git add|status|diff`, `ls`, `grep`, `wc`,
`claude plugin test|validate` (mirrors refresh-run-guard), and (LC-1739, cut to the minimum after nine review rounds
showed every extra form of parsing drew a new finding) two EXACT forms:
`git commit -m '<single-quoted text>'` or `-m <one word of [A-Za-z0-9._:-]>`, optionally `-a`/`-am`,
nothing after it (a double-quoted message, `-F`, `--amend` are judged); `mkdir -p <path>` with a path of
`[A-Za-z0-9._/-]` and no `.git` component. `cd` is out: a write after it has an unknown real directory, so a target like
`config` could be `~/.config/git/config`. `git log`, `head`, `tail`, `sed`, `test`, `[`, `chmod`, `mv`, `git push`, `gh`,
`bun`/`npm test` and `make` stay out and ask, as on main: they run or edit files. `--output` / `--chmod` anywhere in a
step, and an unquoted `` $ ` | ; & < > ( ) { } \ `` in a prefix-form step, remove the exemption. A write target named
like any git hook or inside a `hooks` dir is risky (`core.hooksPath` can point anywhere and `git commit` is
allow-listed); a target with `( ) < >` is a process substitution. Any other step and the WHOLE command is judged,
bodies and payloads included. This closes the old known limit (`cat > run.sh <<'EOF' ... EOF` then `bash run.sh`).

refresh-run-guard uses the same test (LC-1734) so a `cat > test.ts <<'EOF'` that only QUOTES the Webflow
publish URL is not denied as a publish. It carries a copy (`refresh-run-guard/hooks/plain.ts`, a mod cannot import
a sibling); `ci_gates.py parity` fails CI if the block between the `PLAIN-COMMAND` markers differs from
run-state's. Only that block is shared: run-state's risky-target rule and step allow-list exist in run-state only. There the dropped body is kept (judged) unless **every other step** of the command is on an allow-list:
a cat/tee quoted-terminator heredoc write, `git add|status|diff`, `ls`, `grep`, `wc`, `claude plugin test|validate`.
The file a heredoc wrote can be run in more ways than any deny-list names (`timeout 5 sh f`, `if true; then sh f; fi`,
`{ sh f; }`, `npm run p`, a hook behind `git commit`), so anything else keeps the bodies judged. A cat/tee target that contains `.git` (a hook, `.git/config`, `.gitattributes`: a later `git status|add|diff` can
run what was written there) or a `$` also keeps the body judged. Without the exemption, refresh-run-guard judges
BOTH the raw command and the command with every heredoc body cut out and denies if either does (an apostrophe in a
body can pair with a later quote and hide a call in the raw view; the cut view has no body to pair with). Its
splitter keeps the outside-quotes backslash skip, so `'don'\\''t'` and `don\\'t` do not open a quote. When a non-plain
command has a `#`, refresh-run-guard judges it twice (as written, and with comments cut off) and denies if either
says publish: the splitter reads the apostrophe in `# it's` as a quote that can hide a later call, while cutting
comments can itself hide code (`` echo `echo a # b`; curl ... ``). Its splitter also understands `$'...'`. Edit / Write /
NotebookEdit never reach refresh-run-guard (it hooks Bash, SQL and the Webflow tools only), so a file whose content
quotes the URL was never denied by it; a test pins that.

### draft-session (LC-1714)

Pin a session to a run: `/draft-start <run_id> <article_id> <slug> [v1|v2|standard]` (first three required), or set the
userConfig fields. The template matters because the lint receipt does not say whether the V2 method rules applied:
an unstated or unknown template is treated as v2, so the receipt stays locked unless those rules ran. Then:

- **Contract:** `stages/v2_s6_draft.md` is read from `contractPath` (default
  `/home/user/bbm-refresh-agent/stages/v2_s6_draft.md`) on every prompt compose. Unreadable = a loud
  "do not draft" section, and `/draft-done` refuses.
- **`/draft-done [plan.json]`:** runs `draft_lint.py` from `$BBM_INFRA_PATH` (else the session root; never the
  cwd) with `--run-id` and `--output`, then reads the lint's own receipt. Exit 0 AND a receipt that says the
  locked-heading rule ran (and, for a V2 plan, the approved-method rules) unlocks the Draft receipt. A PASS that
  skipped a check prints "PARTIAL LINT, receipt stays locked". A plan for another article never unlocks.
  Because `--run-id` is passed, the lint needs Supabase creds; a cloud session without them gets exit 2 and
  stays locked (by design: no creds, no proof).
- **Receipt gate:** blocks `write_stage_receipt.py` for stage 6 (missing or garbled `--stage` counts), and any
  write to `refresh_run_sections` / `refresh_runs` that mentions `status` unless it only carries not-passing
  words. Default-deny, so a findings write that also says "done" is gated too.
- **Re-lock:** a draft writer CLI, a write to an article table, an edit to one of this article's files, or an
  edit to the linted plan file. Scratch and notes edits do not.
- **Pins:** receipts and writer CLIs must name this run (`--run-id`); article-table SQL needs a bound
  `article_id = '<pin>'`; run-table SQL a bound `run_id`; article files (any depth under `bbm-content/` or
  `articles/`) must match the slug exactly, and with no slug every article file is refused.
- **A gate that throws before reaching the tool denies** (after the tool ran, the catch handler reports the real outcome).

Not covered: Webflow MCP CMS writes; shell writes built from variables/globs/`python -c` (the Bash file check is
best-effort: cp/mv/install/rsync/ln/tee/sed -i/redirects naming an article file); the interpreter is `python3` from
PATH (draft_lint_tool.py uses its own `sys.executable`).

## Callout convention (LC-1711)

A mod that **denies, asks, blocks or changes something** must make it visible twice:

1. **Prefix** the reason / message text with `[mod:<name>]`. That text reaches the model in the
   tool result (a `{ deny }` string, a `tool.check` reason, a tool's `result`, a command's `text`),
   so the model can say which mod acted. `CLAUDE.md` §5 (Conventions) tells it to; this section is the rule's owner.
2. **Toast** the same text with `$.ui.toast(...)`, so Stan sees it. A toast alone never reaches the
   model ("it leaves the transcript and the model untouched"), which is why both are needed.

Each mod has one small `say($, reason)` helper (module-level function: the engine follows `$` only into
top-level functions, so it cannot be a closure inside `register`) that does both and returns the
prefixed text. A deny site reads `return { deny: say($, 'why') }`.

Informational surfaces (bands, status lines, panes, the fleet dashboard) need no toast. Routine events
stay silent: a fleet-tracker wake-up turn and a plain `note` are prefixed but not toasted (one toast per
REVIEW_READY or per note would be noise); a `needs_you` flag and a refused note do toast.

Each mod's `tests/callout.test.ts` asserts the prefix **and** the toast on a deny / ask path (and that
an allowed call carries neither). Each was mutation-checked: removing the prefix, or the toast, fails it.

### Mod actions log (session-close)

`$.store` is private to one plugin, so mods cannot share a log. `session-close` instead derives it from
what it can see: the deny / result / context text of every tool call that reaches its hook, and every
toast any plugin fires (`on('ui.toast')`), matching a string that *starts* with `[mod:<name>] <reason>`
(`[mod:` quoted mid-text in a diff or file is ignored, and only fleet-tracker's own tool results are scanned; for every other tool, including MCP file and
search tools, only the `deny` / `context` a mod attaches counts). A toast cut at 160 characters (`...`) and its full deny line are one entry. `/close-out` and the
wrap-up nudge print `Mod actions this session: [name: reason] ...` (newest last, 30 kept, its own
nudges excluded). It is a floor, not a census: an action that never reaches its hook is not listed.

## Install (opt-in, orchestrator sessions only)

Not enabled repo-wide. In an orchestrator session, run at the prompt:

```
/plugin install fleet-tracker --marketplace mykhaylenkostan/bbm-infrastructure
```

(answer `y` to add the marketplace, choose user scope). Or non-interactively, e.g. as
the first step of an orchestrator session:

```
claude plugin marketplace add mykhaylenkostan/bbm-infrastructure
claude plugin install fleet-tracker@bbm-mods --scope user
```

### How a fresh cloud session loads it (measured 2026-10-07, claude 2.1.292)

| Approach | Result |
| --- | --- |
| `enabledPlugins` + `extraKnownMarketplaces` in a project `.claude/settings.json`, fresh headless session | **Did not load.** Debug log: `Skipping orphaned enabledPlugins entry ...: marketplace not registered`. Declarative settings do not register the marketplace in a headless run. (Interactive trust-prompt path not tested.) |
| `claude plugin marketplace add <owner>/<repo>[@ref]` + `claude plugin install <mod>@bbm-mods --scope user`, then start a session | **Loaded.** Hooks module `fleet-tracker@bbm-mods` loaded, `/fleet` registered. Whole add+install took ~5 s; re-running is idempotent ("already installed"). |
| `claude plugin install ... --scope project` | Works, but **edits the committed `.claude/settings.json`** (`enabledPlugins`). Do not run this in the repo; it would enable the mod for every session. |

So the opt-in is the two-command install above (a SessionStart hook could run it, but
that is deliberately not wired: enable per orchestrator session, not for everyone).
The marketplace must exist on the ref you add: until this lands on `main`, use
`mykhaylenkostan/bbm-infrastructure@<branch>`. The install applies to the next session
start; an interactive session also activates it immediately with no reload.

### Enabling the mods in cloud sessions (LC-1711, measured 2026-10-08, claude 2.1.294)

A committed `enabledPlugins` / project `env` does **not** load the mods in a fresh headless or cloud
session (project settings wait for a trust dialog a cloud session never shows; headless run logged
`Ignoring ... permissions.allow entries ... workspace has not been trusted`). What loads them is an
**environment variable set on the cloud environment** (environment settings, not the repo):

```
CLAUDE_CODE_PLUGIN_DIRS=/home/user/bbm-infrastructure/claude-mods/fleet-tracker:/home/user/bbm-infrastructure/claude-mods/draft-session:/home/user/bbm-infrastructure/claude-mods/run-state:/home/user/bbm-infrastructure/claude-mods/session-close:/home/user/bbm-infrastructure/claude-mods/refresh-run-guard:/home/user/bbm-infrastructure/claude-mods/jira-closer:/home/user/bbm-infrastructure/claude-mods/pillar-brief-guard
```

- Absolute paths only: relative paths and `$CLAUDE_PROJECT_DIR` are not expanded (0 mods loaded).
- A session only gets the mods when **bbm-infrastructure is one of its repos** (the path must exist).
  A missing directory is skipped: the CLI starts, loads the rest, and writes one `WARN ... Plugin path
  does not exist ... skipping` to the debug log only. Nothing is shown to the user, so a session
  without the checkout simply runs with no mod guards (run-state's receipt guard included).
- With this variable AND the marketplace install both present nothing loads twice: the debug log says
  `Plugin "<mod>" from --plugin-dir overrides installed version`. The declarative marketplace entries
  stay useful for interactive sessions only.

### Sessions in OTHER repos (LC-1729)

`CLAUDE_CODE_PLUGIN_DIRS` only reaches sessions that have bbm-infrastructure checked out. For a mod
every BBM session should run whatever its repo (jira-closer), install it at user scope from the
environment's **setup script**, the path measured to load above:

```
claude plugin marketplace add mykhaylenkostan/bbm-infrastructure && claude plugin install jira-closer@bbm-mods --scope user || echo "WARN jira-closer install FAILED: sessions run without it" >&2
claude plugin install fleet-tracker@bbm-mods --scope user || echo "WARN fleet-tracker install FAILED: orchestrators run without stall detection" >&2
```

fleet-tracker belongs on that list (LC-1834): orchestrators run from other repos too, and a
child session the mod is not loaded in is never watched. The setup script is per cloud
environment, so every repo that environment serves gets the mods; a second environment
needs the same lines. Installed mods track `main` of this repo as of the container's start.

With both present nothing loads twice (the plugin-dir copy overrides the installed one).

## Test

```
claude plugin validate .                     # marketplace manifest
claude plugin validate claude-mods/<mod>     # manifest + what the hooks module calls
claude plugin test claude-mods/<mod>         # runs tests/*.test.ts against the engine
```

CI (`.github/workflows/claude-mods.yml`, path-filtered to `claude-mods/**` and
`.claude-plugin/**`) installs the CLI from npm (pinned, ~20 s) and runs all three for
every mod. It fails on zero mods, an unlisted mod, a mod with no test, or a test run
that reports no passes. `validate` warns "gating hook without .catch" on
fleet-tracker's tool handlers; they only serve the mod's own tools, so it is left as is.
