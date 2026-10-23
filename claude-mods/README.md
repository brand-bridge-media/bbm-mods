# claude-mods

Claude Code **mods** for Brand Bridge Media sessions (LC-1711, epic LC-1074).

A mod is a Claude Code plugin made of *function hooks*: a small TypeScript module that
reacts to session events (a tool call, a prompt, a timer) and can draw a pane, a band
above the prompt, a status line or a toast, or register a tool the model can call.
Business analogy: `.claude/hooks/*.py` are door locks that say yes/no; a mod is a
dashboard bolted onto the cockpit.

## Where a rule lives (LCH-528)

Read this before writing any guard, nudge or policy. `.claude/hooks/policy-placement-nudge.py`
repeats it when a session writes a hook, `settings.json` or a mod manifest here.

1. **A rule about a tool** usable from any repo (MCP, Bash, Skill, Write/Edit) is a **mod** in
   `claude-mods/`, installed at user scope from the `bbm-mods` mirror. This is the default.
2. **A rule about this repo's own files or pipeline** (a path that exists only here) stays a
   **project hook** in `.claude/hooks/`, wired in `.claude/settings.json`.
3. **One mod, one job.** No bundles: each mod is disabled alone (`claude plugin disable <name>`),
   versioned alone and tested alone. A hook fires only on its own matcher, so many small mods
   cost nothing at rest.
4. **Logic may be stdlib Python** in `hooks/<name>.py` with a `--selftest` count line; the mod's
   `register.ts` stays thin through `hooks/py.ts`. Shared files (`py.ts`, `sql_lexer.py`,
   `transcript_reader.py`, `supabase_rules.py`, also under `supabase/tools/`) are byte-identical copies; `claude-mods.yml` fails on drift.
5. **Every mod** prefixes what it says with `[mod:<name>]`, fails open on its own errors, carries a
   `*.test.ts`, and is listed in `.claude-plugin/marketplace.json`.
6. **Merged is not shipped.** See "Shipping a mod".

### Transition fallback (LCH-528, removed 2026-10-20)

While the LCH-528/LCH-531 mods were being installed, `.claude/settings.json` also ran their Python
checks and kept the old `permissions.ask` list. It was removed once `~/.bbm-mods-setup.log` in a
fresh session showed `rc_<mod>=0` for all 11. Mods now reach sessions only through the environment
lines below; a project hook that re-runs a mod's check would fire it twice.

### Shipping a mod

A mod reaches sessions in other repos only after the operator adds two things to the cloud environment
(claude.ai → environment → Edit). Put both in the PR body; the nudge prints them for the mod's name.

- **Setup script**, inside the `{ ... }` block: `claude plugin install <mod>@bbm-mods --scope user; echo "rc_<mod>=$?"`
- **`CLAUDE_CODE_PLUGIN_DIRS`**: append `:/home/user/bbm-infrastructure/claude-mods/<mod>` (this repo's
  sessions then load the live checkout copy).

Order: merge, wait for `mirror-claude-mods.yml` to publish, then save the environment. An install
before the mirror has the mod fails (the setup log, `~/.bbm-mods-setup.log`, shows `rc_<mod>=1`).

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
| `fleet-tracker` | Dashboard line per cloud session an orchestrator spawns (polls `get_session` every 90 s, wakes the orchestrator on blocked/failed/review_ready/completed, `/fleet` pane). **Auto-tracks** every `create_session` (ticket from the title/brief; `track` relabels). **Stall detection:** a WORKING session with no transcript event for 15 min gets one automatic nudge (`send_message`, priority `next`, no orchestrator tokens); still silent 10 min later, the orchestrator is woken with `STALLED` and the operator gets a toast. Transcript reads happen only when the turn-level `updated_at` is already 15 min old. A wake the host refuses (poll run inside a tool call) is queued and delivered at turn end. **Close-out (LC-1835):** `untrack` now ARCHIVES the child, but only when a fresh, error-free poll shows it COMPLETED or REVIEW_READY (anything else is refused: it may hold unpushed work); an archive error keeps the row with the error, unless the session's own status reads ARCHIVED; `keep_reason` skips the archive and records why), and a row idle in COMPLETED/REVIEW_READY for 60 min gets ONE reminder wake per bucket episode. `open_children` feeds a session-close obligation. **Waiting reminder (LC-1881):** a child in NEEDS_INPUT or BLOCKED is woken again every 20 min until its bucket changes (UNKNOWN does not reset the clock), with the wait time and its `needs_action`; if `needs_action`/`status_detail` names the operator or a human the line leads with `NEEDS STAN:` and tells the orchestrator to tell the operator in chat with the session link and set `needs_you=true` (no PushNotification). Tools: `mcp__fleet-tracker__{track,note,untrack,status,open_children}`. | LC-1711, LC-1834, LC-1835, LC-1881 |
| `ci-preflight` | Before a `git push` leaves the session, runs `scripts/ci/preflight.sh` (schema-drift replica, portal selftests, migration lints, workflow pins) and DENIES the push on a failure; refuses `update_pull_request_branch` while a check is failing or unfinished; warns on a second push to a branch within 10 minutes. See below. | LC-1846 |
| `draft-session` | v2_s6 Draft guard: contract injected from the refresh-agent file, `/draft-done` runs draft-lint, the Draft receipt is blocked until lint passes. Cloud sessions: `draft_pin` tool, and with no service role the lint is dispatched to CI (`stage-6-draft` gate). See below. | LC-1714, LC-1869 |
| `refresh-run-guard` | Fail-closed guards for the refresh run: denies `execute_sql` writes to receipt tables, Bash/Webflow publish paths and bad Webflow item payloads (non-go.livingcozy.com `product-link`, Products `main-image`, dropped `lc-deal-pill` spans); tracks Pass A freshness in the status line. | LC-1712 |
| `run-state` | Band above the prompt (run, stage, next READY section, Pass A age, missing receipts) and a write guard: a receipt write (`write_stage_receipt.py`, `article_audit.py --write-receipt`, or SQL on `refresh_runs.stages` / `refresh_run_sections`) for a BLOCKED section is **denied**; a human barrier (WAITING_STAN), a DONE/IN_PROGRESS/unknown section, an unreadable plan, or several active runs with no pin **asks** (and refuses when nobody answers). READY and FAILED (conductor re-run) pass. A write is judged against the run it names (`--run-id`/`--slug`, or the id in the SQL), else the pinned/only active run; with no active run the guard is inert for writes that name no run (a named run is still judged against its own plan). Supabase MCP server defaults to `Supabase` (userConfig `supabaseServer`). Plan = the conductor's own `evaluate()` on a `refresh_runs` row, read via the Supabase MCP, else (cloud build sessions have no MCP) PostgREST with `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`; if neither works it asks, naming every path tried, and refuses when unanswered. An empty active-run list over PostgREST is not trusted as "no active run" (a key that cannot see the table also reads `[]`): it counts as a failed path and asks. Exemptions (see "Receipt guard: plain commands" below) apply only to a plain command. `/run-state <slug\|run_id\|clear>` pins the run. Scope: gates Bash receipt writers and SQL tools only; Edit/Write and other MCP tools are intentionally not gated. Needs the repo checkout as cwd + `python3` with pydantic. | LC-1715 |
| `session-close` | Also lists the `[mod:<name>]` actions it saw (see Callout convention). Learns what a session touched from observed tool calls; `/close-out` (and a wrap-up turn) lists unmet obligations: open fleet children (from fleet-tracker's `open_children`, LC-1835; "not checked" when it is not loaded), knowledge INGEST, Jira comment per served ticket, `refresh_runs` left in_progress, +2/+4wk cannibalization and 30/60/90 GSC scheduled after a publish, Pass A/B verdicts. Nudge only, $0. | LC-1713 |
| `jira-closer` | When a session merges a PR or arms auto-merge, reads the PR's Jira keys (title, else fetched) and tells the session to read each ticket's newest comment, then transition it to Done or post a state comment. Blocks the turn's end **once** per ticket while it is untouched (the second Stop always passes, so it cannot loop). Any transition/comment/edit clears it. Sees only merges made inside a session. | LC-1729 |
| `pillar-brief-guard` | Enforces the pillar-brief rules in ANY session, on RECOGNISED actions only (tool + argv shapes; a heredoc, grep, echo or commit message that merely names a script, table or workflow is untouched). (1) `createJiraIssue` in LCC with label `article-idea` (labels read from every shape; an unreadable one fails closed) is **denied** unless the description has a `Parent article: <slug>` line AND that slug exists in `public.articles`; on allow it injects the next steps. (2) Selection/writing needs the article's approved `pillar_briefs` row (looked up through `public.articles`, Supabase MCP, default server `Supabase`; userConfig `supabaseServer`/`projectId`). Gated: a `run-heading-research.yml` dispatch with `step=shortlist` **and `apply` true** (unset, empty or false is the workflow's selftest; 1/yes/on count as true; any other value is denied), via the GitHub MCP or `gh workflow run ... -f step=shortlist -f apply=true` (numeric workflow ids count when the inputs say step=shortlist); `product_shortlist.py` / `python -m ...product_shortlist` invocations that carry a target (`--run-id`/`--article`/`--article-id`; not `--selftest`/`--dry-run`/`--render`/`--help`; no target = not a selection); `roster_materialize.py apply` (article read from `--plan`); a Write of a NEW `.md` under `bbm-content/**/articles/` whose frontmatter has `slug:` and `title:`; and the same new article via GitHub MCP `create_or_update_file` (no `sha`) / `push_files`. Shell keywords and grouping (`then do else if while ( { ! nohup exec command`) before the command are seen through. No approved brief, or a lookup that cannot run (no Supabase MCP, SQL error, unknown run, unresolvable article): **deny**, naming the step or the fix ("connect the Supabase MCP so the approved pillar brief can be checked; nothing selects products without it"); never an ask, since an unattended session cannot answer. Only a brief older than 365 days (lookup succeeded) **asks** (refused when nobody answers). (3) `pillar_brief.py approve --by`, `run-pillar-brief.yml` / `gh workflow run run-pillar-brief.yml -f mode=approve -f approved_by=`: the approver must be a configured human (userConfig `approvers`, comma-separated, default `the operator`, case-insensitive); blank, `claude`, `x` are **denied**. `run-pillar-brief.yml` defaults `approved_by` to `The operator`, so leaving it out would attribute the approval to the operator without their say-so: the guard requires it to be named explicitly. `gh workflow run` of either guarded workflow with `--json` is denied (its inputs are hidden). **Not covered:** adding the `article-idea` label to an existing ticket (`editJiraIssue`); Webflow MCP writes; other selection writers (`write_stage_receipt.py`); `gh api .../dispatches`, `curl` or other HTTP dispatches; a workflow numeric id whose inputs are not step=shortlist/mode=approve; scripts run via variables, `$(...)`, `xargs`, `make` or a wrapper script; `--by "$VAR"` (the literal is judged, not its value); `push_files` cannot tell a new article from an update, so any article file in a push needs an approved brief; article files written by other tools (Bash redirects, `git`, editors outside Claude); a Write whose path has no `bbm-content` segment (the checkout directory is named otherwise); a `--selftest`/`--dry-run`/`--render` flag is trusted not to select or write (verified against `product_shortlist.py`: selftest returns first, render is local, dry-run writes nothing). Argparse prefixes of the target flags (`--run`, `--article-i`) count as targets; ambiguous or odd shell shapes err toward a deny; nested `bash -c`/`eval` payloads are followed up to 8 levels deep (beyond that, or through variables, they are not covered). $0. | LC-1731 |
| `prod-deploy-guard` | Denies production deploys and DDL from a session: MCP `deploy_edge_function`, `wrangler`/`supabase` CLI deploys (a shell tokenizer judges each command's argv: wrappers such as `sudo`, `timeout`, `npx`, `bash -c` are unwrapped; `--dry-run` passes), DDL through `execute_sql` (incl. `SELECT INTO`, `explain analyze`). `apply_migration` asks. | LCH-528, LC-421, LC-428 |
| `bulk-write-guard` | Denies `execute_sql` writes that do not bound themselves to 5 rows or fewer in their own text (the statement's own top-level WHERE on an id key of the TARGET table, or ≤5 VALUES rows); larger writes go through `data-changes/`. | LCH-528, LC-1683 |
| `spend-delete-ask` | Asks before tools that move money or delete what a session cannot restore (explicit list in `hooks/logic.ts`; every `mcp__Stripe__*`). | LCH-528 |
| `no-browser-as-me` | Denies the chrome-browser / computer-use skills and any Chrome or computer-use MCP server (judged on the server segment, any casing). | LCH-528 |
| `recurring-successor-guard` | Denies a Done-category transition of a recurring ticket (`recurring` label or a "next due" line) until the session created a successor (createJiraIssue / scheduled task) naming it. Records the Jira calls it needs itself (PreToolUse carries no transcript). | LCH-528 |
| `reply-footer-check` | Blocks the turn's end once when the reply's last line is not `Noted separately: <keys>` / `Nothing`, or names a key no Jira call touched. | LCH-528 |
| `knowledge-superseded-check` | After a read of `knowledge_memories`/`knowledge_articles`, names superseded rows and their replacements; nudges a query that skips `is_active`/`superseded_by`. Nudge only. | LCH-528 |
| `session-title-nudge` | Session-start reminder of the `<TICKET> — <summary>` naming rule; rename reminder when `createJiraIssue` mints a key. Nudge only. | LCH-528 |
| `skill-copy-guard` | Denies Write/Edit under `.claude/skills/` (byte copies of claude-skills). | LCH-528 |
| `dispatch-watch` | After a dispatch through the `github-dispatch` bridge (the session has no GitHub access to the target repo), sends the bridge's read-only `status` request every minute and wakes the session when the run finishes, never registers (6 min) or runs past 90 min; a finish under 2 min carries the did-nothing warning (memory 1440431b). Replaces "schedule a check-in and wait". | LCH-528, LC-1879 |
| `mod-freshness` | Mods load once, when a container starts; a session left open across mod merges keeps the old code (2026-10-22: a pre-#1979 fleet-tracker with no auto-track and the old phone-push wording). At session start it fingerprints every loaded bbm mod (installed `@bbm-mods` copies; a `CLAUDE_CODE_PLUGIN_DIRS` checkout copy wins), then hourly fetches the mirror (`--depth 1`, into its own `~/.cache/mod-freshness`, never the plugin manager's clone) and compares each mod file by file. A mod that changed upstream wakes the session **once**, naming the mod and the mirror head, and tells it to give the operator the NEEDS YOU banner: start a fresh session. A mirror it cannot read is one NOT CHECKED toast, never "fresh". Does not reload anything (a bad release would reach every open session at once). Logic and selftest: `hooks/mod-freshness.py`. | LC-1711 |
| `supabase-guard` | Supabase exposure rules before SQL runs or a migration is written (`execute_sql`, `apply_migration`, Write/Edit/MultiEdit of `supabase/migrations/*.sql`, judged on the file after the edit). Blocks **R1** table without RLS, **R2** view without `security_invoker` (OR REPLACE without it resets it), **R3** `SECURITY DEFINER` without `SET search_path` or `REVOKE ... FROM public, anon, authenticated`, **R4** `GRANT` to anon/authenticated without `-- supabase-guard: allow-grant <object> -- <reason>`. Warns **R5** function without `search_path`. Each rule reports PASS / BLOCK / WARN / NOT CHECKED with a reason; the rule list is data (`supabase_rules.RULES`). Logic is `supabase/tools/supabase_rules.py` (byte-identical copy), which the `lint-supabase-rules.yml` PR gate also runs. | LCH-531, LCH-530, LCH-104 |
| `pr-ci-watch` | A session must not depend on GitHub's PR events alone to learn its CI finished (2026-10-22: #2041's required review failed at 17:33Z; the events never arrived, the check-in was 50 min out, the session sat idle). After a successful `git push` (the branch's open PR, found through `list_pull_requests`), a `create_pull_request`, or the `watch_pr` tool, it reads the PR's head and check runs every 2 min through the GitHub MCP. It wakes the session **once** when every check on the pushed head has finished and the same picture is seen twice (late-registering runs), naming failures; also when nothing registers in 15 min, CI runs past 60 min (once), the PR merges or closes, or 5 reads in a row fail. The previous head is not mistaken for the push for 10 min. A second wake when GitHub events also arrive is expected and cheap. | LC-1896 |
| `image-weight-guard` | Catches an oversized image BEFORE it is loaded into Webflow. On `data_cms_tool` `create_collection_items` / `update_collection_items` (image objects with a `url`, image-extension or image-named URL strings, `<img src>` in rich text) and `asset_tool` `upload_image_by_url` (any MCP server name exposing them), probes each image's headers (HEAD, falling back to a `Range: bytes=0-0` GET) and **blocks** when Content-Length > 400 KB or the type is not `image/webp`, `image/avif`, `image/svg+xml`. **Asks** (NOT CHECKED, never a silent pass) when size or type cannot be determined, a URL is relative or non-http(s), more than 40 images are in one call, or a probe runs out of time. The block message names the fix: route the image through `generated-image-intake` (`article_hero`, `product_card`, `bpd_slot`) or compress to WebP under 400 KB. Not covered: images referenced only by `fileId`, Designer-API image tools, `data_assets_tool`, headers that lie. Logic and selftest (stubbed probes, no network): `hooks/image-weight-guard.py`. | LC-1883 |
| `where-we-stand` | Delivers prior art at the moment it matters (LC-1893). On a RECOGNISED shape only: a Jira issue read (about to state a ticket's status), a SELECT on `pipeline_health_log` / `cron.job*` / `net._http_response` naming a job or error class (diagnosing a recurring problem), or a SELECT on `refresh_runs` / `articles` naming a slug or run id (stating an article's status), it looks the topic up read-only and injects ONE card: **know** (active memories and articles, supersession chains walked to the terminal node) / **state as of the date** (each ticket's status, last update and NEWEST comment with its date) / **verified, not verified or conflict** (cited PRs merged into main, the article's last-published date, the newest `refresh_runs.status`, `schema_migrations`, deployed function version), every disagreement named ("ticket says Done, PR #n not merged"). Four single-job checks, each with its own PASS / BLOCK / NOT CHECKED receipt; NOT CHECKED never reads as verified. Limits: once per topic and three cards per session, and nothing for a topic the session already read in the knowledge tables. Read-only: SELECTs, `pg_net` GETs to Jira whose credential is built inside the database from the vault and never selected, `list_edge_functions`, `pull_request_read`. Uses the session's own Supabase and GitHub MCP servers, so it needs no new credential, Edge Function or cron. **Built by code, not written by a model:** every line is a raw read (a comment quoted verbatim with author and date, `merged=true sha=...`, the last-published timestamp, the cron schedule); every fact carries its date and is flagged `STALE` past 14 days; a conflict lists both sides with dates and says "production wins ties (CLAUDE.md section 6)", never picking one. Three more ways in: the session's own ticket (from its branch name) at session start, the `lookup` tool on demand (`mcp__where-we-stand__lookup`), and the **backstop**: a `Stop` hook (`wws_gate.py`, modelled on reply-footer-check) that sends a reply back ONCE when it states a ticket's status, or says something is published / merged / deployed / live, with no card for that subject in the session (a sentence that says "not checked" is not a claim). Fails open. The three historical cases are a permanent CI regression test (`hooks/wws_regression.py`, fixtures in `tests/fixtures/`). | LC-1893 |

### where-we-stand (LC-1893)

Why: the knowledge existed three times and nothing delivered it at the moment a session was diagnosing or stating a status
(2026-08-10 `cron_http_failure`; 2026-09-14 LC-1345 quoted from its title; 2026-10-20 an article called "not published" from a stale
ticket and a stale task list). CLAUDE.md section 1 says to read first; this reads for the session and checks the reply.

Home, and why: **stdlib Python inside the mod directory, run through the session's own Supabase and GitHub MCP servers.** An Edge Function
would need a deploy (forbidden outside a merged PR), a service-role key a cloud session does not have, and a cron to be useful;
an existing script has no way to reach the Jira credential. The Jira read is a `pg_net` GET built in SQL from the vault secret, so the
credential never leaves the database and a session never holds it. Cost per card: 5 `execute_sql` (knowledge, production, Jira fire,
`pg_sleep`, Jira collect), at most one `list_edge_functions` and five `pull_request_read`; zero model calls; the card is about 1.8K tokens
(7 KB), re-read on later turns like any context.

| File | One job |
| --- | --- |
| `wws_trigger.py` | WHEN: a Jira issue read, a SELECT on an alert/cron surface naming a job or error class, a SELECT on `refresh_runs`/`articles` naming a slug or run id. A knowledge read is the opposite signal (prior art already being read) |
| `wws_checks.py` | four sources, four receipts: `knowledge`, `jira`, `github`, `production`, each PASS / BLOCK / NOT CHECKED. NOT CHECKED never reads as verified |
| `wws_card.py` | tickets and PRs worth a second look; hard CONFLICTS (both sides, with dates); NOTES (soft signals that never change the verdict); the verdict; the text |
| `wws_gate.py` | the backstop: a reply that states a ticket status, or says something is published / merged / deployed / live, with no card for that subject in the session, is sent back once |
| `where-we-stand.py` | the joint: builds the read-only SQL, parses MCP replies into evidence, dispatches commands |
| `wws_moot.py` | is a decision the newest comment still calls open about something production says is over? The ONE function behind the card's `decision_moot` receipt, the status generator's "Waiting on the operator" block and the NEEDS YOU guard (LC-1907) |
| `wws_needs_you.py` | the NEEDS YOU guard (LC-1907): a reply that opens with `> **NEEDS YOU:**` and puts a ticket to the operator as a pending decision needs a card from this turn; if that card's `decision_moot` BLOCKed the ticket, the reply is blocked with the evidence |
| `wws_regression.py` | replays the three historical cases from `tests/fixtures/` (real evidence, captured 2026-10-22) and fails if the card stops saying what each case needs |

`decision_moot` (LC-1907). Why: a ruling raised 2026-10-10 on LC-1755 was put to the operator as open on 2026-10-23 although the article had been
live since 2026-10-21; the card read the newest comment right and nothing compared the decision with the production state it was about. The
test: an open-decision sentence in the newest comment (`wws_moot.OPEN`, and not also `SETTLED`); RAISED = the oldest comment carrying the same
quoted subject (a STATE comment that copies the item forward must not reset the clock); the runs and slugs named there or in the opening comment,
plus every run whose `jira_keys` holds the ticket; MOOT when one of those runs is done / abandoned, or its article was published, after RAISED.
Cost: one more `execute_sql` per card, and only when some newest comment holds an open decision (the Jira GET now reads a page of 100 comments,
reduced to a small profile inside the database; a longer thread may hide the opening comment, and then the clock starts at the newest). The
receipt is PASS (nothing moot; OPEN items listed), BLOCK (the card prints a CONFLICT) or NOT CHECKED (production unread). The NEEDS YOU guard
lives in this mod, not in a mod of its own, because the card ledger it reads is private to this plugin's store; it blocks a moot ask again on
the re-send, at most 3 times a session.

Ways in: a recognised trigger (once per topic, three per session, nothing for a topic the session already read in the knowledge tables);
the session's own ticket from its branch name at session start; the `lookup` tool (`mcp__where-we-stand__lookup`), on demand and not capped;
the gate's block message names that tool and the exact arguments.

What a card never does: summarise (every line is a raw read: a comment quoted verbatim with gaps marked `[...]`, `merged=true head_sha=...`,
the last-published timestamp, a cron schedule), pick a side in a conflict (production wins ties, CLAUDE.md section 6, and the card says so),
or call something verified from a document. Every fact carries its date and is flagged `STALE` past 14 days.

Known limits (measured on the three real cases, not guessed):
- The GitHub connector's `pull_request_read` returns `head.sha` and no `merge_commit_sha`, so a PR line shows `head_sha=` (labelled), not the merge commit.
- Branch protection (the live required-check set) is not readable through any connector the lookup uses, so a "required check" question stays NOT CHECKED on production.
- Relevance is lexical: a ticket that is the `source_id` of a high-scoring memory, or a PR cited near a topic term, can be tangential (LC-1659 on case c, PR #1126 on case b). It is shown with its title and date so a reader can discard it; it is never counted as proof of the claim.
- A memory that contradicts production in words the date patterns do not cover is not detected as a conflict (it still appears under KNOW, dated and flagged STALE).
- The gate reads sentences, not meaning: a status claim phrased without a ticket key, `#n` or a three-word slug is not seen.

### ci-preflight (LC-1846)

Why: CI runs ~19 checks per push on a CPU-bound VPS; on 2026-10-19 schema-drift-check failed twice (#1833, #1834)
and each failure cost a full round, though the check takes seconds locally.

- **`scripts/ci/preflight.sh [repo_root] [base_ref]`** also runs by hand. It diffs HEAD against the merge base and runs only the
  checks the changed files call for: **schema-drift** (added/renamed migrations; the exact guardrails G4 `extract` / grep / `judge`
  logic, using `scripts/ci/vendor/schema_drift.py` from bbm-guardrails `1b01cd8`, which must be re-copied when guardrails changes it),
  **operations-portal** (`lib/data/*.selftest.mjs`; `tsc --noEmit` only when `node_modules` exists), **migrations**
  (`lint_function_grants`, `lint_table_domains`), **workflows** (`bump_action_pins --check`, `runner_lane --check`).
  Exit `0` all pass, `1` any FAIL, `2` nothing failed but something is NOT CHECKED (never counted as a pass).
  Known differences from CI: PR-body "by design" overrides are not seen unless `PREFLIGHT_PR_BODY_FILE` is set; CI checks the PR
  merge ref and this reads HEAD (a branch behind main can fail here and pass there). Parity measured at `abee088f`
  (LC-1836 actions tab): the same 13 columns fail locally as in CI run 39309354157.
- **Push hook** (`tool.call` on Bash): a `git push` (also `git -C dir push`, `cd dir && git push`, inside `bash -c`) runs the script
  in that repo (180 s time-box). Exit 1 denies the push with the failing summary (about 40 lines) and the bypass; exit 2 allows with a
  NOT CHECKED warning; a timeout or crash allows with a NOT CHECKED warning; 0 allows quietly. `--dry-run`, `--delete` and
  `git push origin :branch` are not pushes. Matching is on parsed commands, so `echo "git push"` and a commit message naming a push
  do not match; `$(...)`, aliases and scripts that push are not seen (fails open). A repo without `scripts/ci/preflight.sh` is left alone.
  **Bypass for a real emergency:** put `PREFLIGHT_SKIP=1` in the command; the push is allowed with a note.
- **Update-branch guard** (`update_pull_request_branch` on the `github` and `GitHub_Custom` servers): reads the PR's check runs and
  denies while any is failing or still queued/in progress (CLAUDE.md section 5: update once, when otherwise green). Advisory-strength:
  if the check runs cannot be read (or none exist yet) it ALLOWS with a warning.
- **Batching nudge:** a second successful push to the same branch within 10 minutes adds a warning. Warning only.

Tests: `claude plugin test claude-mods/ci-preflight` (decision logic and hooks) and `bash scripts/ci/preflight.selftest.sh` (the script,
against a throwaway git repo; wired into `claude-mods.yml`).

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
  cwd) with `--run-id`, `--pre-receipt` (LC-1869: skips ONLY the "v2_s6 status is not done" finding, since that status is the outcome this lint decides; recorded as `counts.checks_scoped`, and the mod refuses a receipt whose `checks_scoped` is anything but exactly `["draft_receipt_complete.status"]`) and `--output`, then reads the lint's own receipt. Exit 0 AND a receipt that says the
  locked-heading rule ran (and, for a V2 plan, the approved-method rules) unlocks the Draft receipt. A PASS that
  skipped a check prints "PARTIAL LINT, receipt stays locked". A plan for another article never unlocks.
  Because `--run-id` is passed, the lint needs Supabase creds; a cloud session without them gets exit 2 and
  stays locked (by design: no creds, no proof). **Since LC-1869 such a session is not run locally at all:** with no
  `SUPABASE_SERVICE_ROLE_KEY`, `/draft-done` runs nothing and prints the CI dispatch (below).
- **Receipt gate:** blocks `write_stage_receipt.py` for stage 6 (missing or garbled `--stage` counts), and any
  write to `refresh_run_sections` / `refresh_runs` that mentions `status` unless it only carries not-passing
  words. Default-deny, so a findings write that also says "done" is gated too.
- **Re-lock:** a draft writer CLI, a write to an article table, an edit to one of this article's files, or an
  edit to the linted plan file. Scratch and notes edits do not.
- **Pins:** receipts and writer CLIs must name this run (`--run-id`); article-table SQL needs a bound
  `article_id = '<pin>'`; run-table SQL a bound `run_id`; article files (any depth under `bbm-content/` or
  `articles/`) must match the slug exactly, and with no slug every article file is refused.
- **A gate that throws before reaching the tool denies** (after the tool ran, the catch handler reports the real outcome).

#### Cloud drafting path (LC-1869)

A session an orchestrator spawns cannot type `/draft-start` and never holds the service role. Two additions, neither of which
lets a session produce a passing stage-6 receipt:

- **`draft_pin {run_id, article_id, slug?}`** (tool `mcp__draft-session__draft_pin`): validates uuid shapes and sets the same
  state `/draft-start` sets. A pin only ADDS restrictions (an unpinned session is not gated), so setting one is safe. The same
  run again is a no-op (it does not re-lock a lint pass); a different run, or the same run with a different article/slug, is
  **refused**; a slug may be added to a pin that has none. There is no unpin and no template argument (the template is only
  ever read from userConfig, so a model cannot ask for the looser v1 reading). Optional: set `BBM_DRAFT_RUN_ID` and
  `BBM_DRAFT_ARTICLE_ID` in the session environment and the pin is taken at session start (both must be uuids, else nothing is
  pinned and a toast says so). While pinned, a `run-refresh-stage-gate.yml` dispatch must name the pinned `run_id`.
- **No service role = CI lint.** `/draft-done`, and the tool **`draft_lint_request`**, do not run the lint when
  `SUPABASE_SERVICE_ROLE_KEY` is absent. They return the exact dispatch (`mcp__github__actions_run_trigger`,
  `run_workflow`, `run-refresh-stage-gate.yml`, `inputs {run_id, gate: stage-6-draft, dry_run: "false"}`) and change nothing:
  the receipt stays blocked, and `draft_lint_request` re-locks any earlier pass. The `stage-6-draft` gate
  (`webflow/bulk-operations/refresh-stage-gate/gate_runner.py`) runs `draft_lint.py --article-id --run-id` with credentials and
  writes the stage-6 receipt from the real result.

Hardening (LC-1869 security review):

- **Orchestrated sessions MUST set `BBM_DRAFT_RUN_ID` and `BBM_DRAFT_ARTICLE_ID`.** A tool pin lives in memory and is lost when the
  mod reloads; the env pin is not. While the env var is set, `draft_pin` refuses any other run/article even with no in-memory pin.
- **Once pinned, every `actions_run_trigger` call is held to one shape:** method `run_workflow`, owner/repo exactly
  `brand-bridge-media/bbm-infrastructure`, `ref` exactly `main`, `workflow_id` exactly `run-refresh-stage-gate.yml` (a numeric id or any
  other workflow is denied), `inputs.gate` exactly `stage-6-draft`, `inputs.run_id` the pinned run. The ref rule matters: the workflow
  runs with the service role, so a branch's edited `draft_lint.py` / `gate_runner.py` would run with it. Other methods (rerun, cancel)
  are denied too.
- **Shell routes are denied too.** While pinned, Bash is refused for `gh workflow ...`, `gh run ...`, `gh api ...` (leading flags,
  quoting and extra whitespace tolerated, case-insensitive; `GH_TOKEN=x gh ...` and `bash -c "gh ..."` wrappers included) and for any
  `curl` / `wget` / `http` call to `api.github.com` whose path reaches `dispatches`, `actions/workflows` or `actions/runs`. Not seen: a
  script or another HTTP client that builds the request elsewhere.
- **The dispatch and shell guards fall back to the env pin** when the in-memory pin is null, so a mod reload does not lift them
  (both env vars must be uuids).
- **These mod guards are defence in depth.** A mod only governs the session it is loaded in. The structural control is LC-1874 (the
  service-role key held in a GitHub Environment restricted to `main`), which makes a branch's copy of the lint unable to read the key
  whatever a session does.
- A findings-race loss (the `v2_s6` findings kept changing while CI built the merge) exits 1 and writes nothing; the recovery is to
  re-dispatch once the session has stopped writing.
- The local lint receipt is written under a directory `mktemp -d` creates for that call (no predictable `/tmp` name); no directory = no
  lint. In CI, `gate_runner` deletes the previous lint receipt file before running the lint.
- `gate_runner` re-reads the `v2_s6` findings right before writing and rebuilds if they changed (the writer replaces the whole column);
  if they never settle it writes nothing and fails.
- **`findings.draft_lint_ci` is advisory evidence only.** The session can write that key (it can write any `v2_s6` finding), so it must
  NEVER be used as a gate input. The authoritative record is the stage-6 entry in `refresh_runs.stages` that CI writes. `lint_sha` is a
  hash of the lint RESULT (used only to recognise a repeat), not a signature; gate 6.5 re-lints from scratch and does not read it.

Who writes what: the **session** posts its findings to `refresh_run_sections` (`v2_s6`: `article_content`, `product_copy`, ...)
through the Supabase MCP, BEFORE dispatching (the lint reads them). **CI** writes the stage-6 `refresh_runs.stages` entry and
the `v2_s6` section status (`done` only on exit 0 AND a lint receipt that says passed, heading rule ran and, where the run
needs it, the V2 method rules ran; `fail` with the lint's reasons on exit 1; nothing at all, exit 1, when the lint could not
examine the draft), and adds one key, `findings.draft_lint_ci`, to the findings the session posted (the others are carried
over and read back). Re-running on an unchanged result writes nothing (`lint_sha` in the receipt note). `dry_run` defaults to
true. The session then reads the receipt back (read only).

Not covered: a stage-gate dispatch by numeric workflow id (the `run_id` pin is judged only when `workflow_id` names `run-refresh-stage-gate`); Webflow MCP CMS writes; shell writes built from variables/globs/`python -c` (the Bash file check is
best-effort: cp/mv/install/rsync/ln/tee/sed -i/redirects naming an article file); the interpreter is `python3` from
PATH (draft_lint_tool.py uses its own `sys.executable`).

## Callout convention (LC-1711)

A mod that **denies, asks, blocks or changes something** must make it visible twice:

1. **Prefix** the reason / message text with `[mod:<name>]`. That text reaches the model in the
   tool result (a `{ deny }` string, a `tool.check` reason, a tool's `result`, a command's `text`),
   so the model can say which mod acted. `CLAUDE.md` §5 (Conventions) tells it to; this section is the rule's owner.
2. **Toast** the same text with `$.ui.toast(...)`, so the operator sees it. A toast alone never reaches the
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
/plugin install fleet-tracker --marketplace brand-bridge-media/bbm-infrastructure
```

(answer `y` to add the marketplace, choose user scope). Or non-interactively, e.g. as
the first step of an orchestrator session:

```
claude plugin marketplace add brand-bridge-media/bbm-infrastructure
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
`brand-bridge-media/bbm-infrastructure@<branch>`. The install applies to the next session
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
{
  claude plugin marketplace add brand-bridge-media/bbm-mods; echo "rc_marketplace_add=$?"
  claude plugin install jira-closer@bbm-mods --scope user; echo "rc_jira_closer=$?"
  claude plugin install fleet-tracker@bbm-mods --scope user; echo "rc_fleet_tracker=$?"
  claude plugin list
} >> "$HOME/.bbm-mods-setup.log" 2>&1 || true
```

**Install from the public mirror, never from this repo (LC-1729, measured 2026-10-19).** The
setup script runs before the session has GitHub credentials, so cloning this private repo fails
(`could not read Username for 'https://github.com'`), with or without the repo attached to the
session. `brand-bridge-media/bbm-mods` is a public snapshot of `.claude-plugin/` + `claude-mods/`
that `.github/workflows/mirror-claude-mods.yml` overwrites on every merge touching a mod (tracked
files only, no history, secret-scanned by `.github/scripts/build_bbm_mods_mirror.sh`, fails closed).
Edit mods HERE; edits in the mirror are lost on the next sync. A PR on the mirror from anyone but
the owner is closed automatically and @mentions the operator (`.github/mirror/bbm-mods/`). The log file is
how a session checks the install ran: `cat ~/.bbm-mods-setup.log`.

fleet-tracker belongs on that list (LC-1834): orchestrators run from other repos too, and a
child session the mod is not loaded in is never watched. The setup script is per cloud
environment, so every repo that environment serves gets the mods; a second environment
needs the same lines. Installed mods track the mirror's `main` (this repo's `main` as of the last sync) at container start.

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
