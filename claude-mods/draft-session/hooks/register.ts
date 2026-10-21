import type { Register } from 'claude-code'

import {
  bashFileWriteViolation,
  bashPinViolation,
  bashTouchesArticleFile,
  classifyReceiptCommand,
  filePinViolation,
  isArticlePath,
  methodRulesApply,
  isDraftReceiptSql,
  looksLikeFileWrite,
  runsDraftWriter,
  sqlPinViolation,
  writesArticleTable,
  type Run,
} from './gate'

// Draft session guard (LC-1714, epic LC-1074).
// Why it exists: v2_s6 Draft must run in a subscription Claude session, and its
// rules are prose. On 2026-08-09 (modular-sofas) 12 of 14 entries said "our tester"
// although the skill had been read. This mod (1) puts the contract in front of the
// model, read from the refresh-agent file at load time so it cannot drift, (2) makes
// /draft-done run draft-lint, and (3) refuses the Draft receipt until lint passes,
// and refuses writes to any other article. Business analogy: the contract is the
// recipe card pinned above the stove; draft-lint is the health inspector; the receipt
// is the "kitchen passed" sticker the inspector must sign before it goes on the door.

// Callout convention (LC-1711): every deny / block / refusal / changed-state message starts with
// `[mod:draft-session]` (that text reaches the model in the tool result, so it can say who acted) and fires a
// toast naming the mod and the reason (so Stan sees it too). One helper keeps the two together.
const MOD = 'draft-session'
function say($: any, reason: string, timeoutMs?: number): string {
  const text = `[mod:${MOD}] ${reason.replace(/^draft-session: /, '')}`
  try {
    const shown = text.length > 160 ? `${text.slice(0, 157)}...` : text
    // A blocked contract must stay on screen long enough to be read (timeoutMs), the rest use the default.
    if (timeoutMs === undefined) $.ui.toast(shown)
    else $.ui.toast(shown, { timeoutMs })
  } catch { /* a toast must never be the reason a guard fails */ }
  return text
}

const refuse = ($: any, what: string) => ({
  deny: say($, `${what}. Run \`/draft-done\` (draft-lint must PASS) before the Draft receipt; fix the draft, never the ledger.`),
})

// Says a re-lock only when one happened (dirty returns '' otherwise).
const relock = ($: any, note: string) => {
  if (note) say($, note)
}

// ---- cloud drafting (LC-1869) -------------------------------------------------------------------
// A cloud drafting session has no service role, so it can neither run `draft_lint.py --run-id` nor be trusted to
// write its own passing stage-6 receipt. Two additions, both one-directional:
//  * `draft_pin` lets the MODEL pin the session (the user-typed /draft-start is a command, which a model cannot
//    call). A pin only ADDS restrictions, so setting one is safe; changing or clearing one stays human-only.
//  * with no key, /draft-done and `draft_lint_request` do not run the lint: they hand the session the exact
//    dispatch of the credentialed `stage-6-draft` gate (run-refresh-stage-gate.yml), which runs draft-lint in CI and
//    writes the stage-6 receipt from the real result. Nothing here ever sets `lintPassed` on the model's say-so.
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SLUG_SHAPE = /^[a-z0-9][a-z0-9-]{0,120}$/
const GATE_WORKFLOW = 'run-refresh-stage-gate.yml'
const DISPATCH_TOOL = /^mcp__(github|GitHub_Custom)__actions_run_trigger$/

// $.env.get needs a LITERAL name (the engine lists the variables a module reads), so one tiny reader per variable.
const clean = (v: unknown): string => String(v ?? '').trim()
async function envRunId($: any): Promise<string> {
  try {
    return clean(await $.env.get('BBM_DRAFT_RUN_ID'))
  } catch {
    return ''
  }
}
async function envArticleId($: any): Promise<string> {
  try {
    return clean(await $.env.get('BBM_DRAFT_ARTICLE_ID'))
  } catch {
    return ''
  }
}
async function hasServiceKey($: any): Promise<boolean> {
  try {
    return clean(await $.env.get('SUPABASE_SERVICE_ROLE_KEY')) !== ''
  } catch {
    return false
  }
}

function ciDispatchText(run: Run): string {
  const call = {
    method: 'run_workflow',
    owner: 'brand-bridge-media',
    repo: 'bbm-infrastructure',
    workflow_id: GATE_WORKFLOW,
    ref: 'main',
    inputs: { run_id: run.runId, gate: 'stage-6-draft', dry_run: 'false' },
  }
  return (
    `Dispatch the credentialed Draft lint with mcp__github__actions_run_trigger: ${JSON.stringify(call)}\n` +
    `That workflow runs draft-lint WITH credentials on run ${run.runId} and writes the stage-6 Draft receipt itself ` +
    `(done only on a complete PASS; a failing lint writes a failing receipt with its reasons). ` +
    `Post your v2_s6 findings (article_content, product_copy) through the Supabase MCP FIRST: the lint reads them. ` +
    `Do not write the stage-6 receipt yourself; it stays blocked here. Wait for the run (mcp__github__actions_get / actions_list), ` +
    `then READ the result back (Supabase MCP, read only): the newest stage-6 entry in refresh_runs.stages for this run must be status done ` +
    `with a note carrying lint_sha=. If the run fails, fix the draft, re-post findings, dispatch again.`
  )
}

// Once pinned, EVERY run of a workflow by this session is held to one exact shape (LC-1869 security review):
// the service role is injected into run-refresh-stage-gate.yml, so a dispatch of a pushed branch's copy of
// draft_lint.py / gate_runner.py would run attacker-chosen code with it. Therefore: this repo, ref exactly main,
// workflow exactly run-refresh-stage-gate.yml (a numeric id or any other workflow is refused outright), gate exactly
// stage-6-draft, run_id the pinned run. Any other method of the tool (rerun, cancel ...) is refused too: a rerun
// would execute a run's own ref.
const GATE_OWNER = 'brand-bridge-media'
const GATE_REPO = 'bbm-infrastructure'
const GATE_REF = 'main'
const GATE_NAME = 'stage-6-draft'
function dispatchViolation(e: any, run: Run): string | undefined {
  const method = String(e.method ?? '')
  if (method !== 'run_workflow')
    return `while pinned only method run_workflow of this tool is allowed (got ${JSON.stringify(method)})`
  if (e.owner !== GATE_OWNER || e.repo !== GATE_REPO)
    return `dispatch targets ${JSON.stringify(`${e.owner}/${e.repo}`)}, only ${GATE_OWNER}/${GATE_REPO} is allowed`
  if (e.workflow_id !== GATE_WORKFLOW)
    return `workflow_id ${JSON.stringify(e.workflow_id)} is not allowed, only the exact name ${GATE_WORKFLOW} (a numeric id or another workflow is refused)`
  if (e.ref !== GATE_REF) return `ref ${JSON.stringify(e.ref)} is not allowed, only ${GATE_REF} (a branch would run its own copy of the lint with the service role)`
  let inputs: any = e.inputs
  if (typeof inputs === 'string') {
    try {
      inputs = JSON.parse(inputs)
    } catch {
      return `could not read the workflow inputs; this session drafts run ${run.runId}`
    }
  }
  if (inputs?.gate !== GATE_NAME) return `gate ${JSON.stringify(inputs?.gate)} is not allowed, only ${GATE_NAME}`
  if (typeof inputs?.run_id !== 'string') return `${GATE_WORKFLOW} dispatch names run (none), this session drafts run ${run.runId}`
  const rid = inputs.run_id.toLowerCase()
  if (rid !== run.runId.toLowerCase()) return `${GATE_WORKFLOW} dispatch names run ${rid || '(none)'}, this session drafts run ${run.runId}`
  return undefined
}

// The pin the guards use: the in-memory one, else the env pin. A mod reload wipes the in-memory pin; the env pin is
// not wiped, so the dispatch guards must not lift with it.
async function effectivePin($: any, run: Run | null): Promise<Run | null> {
  if (run) return run
  const r = (await envRunId($)).toLowerCase()
  const a = (await envArticleId($)).toLowerCase()
  if (UUID_SHAPE.test(r) && UUID_SHAPE.test(a)) return { runId: r, articleId: a, slug: '', variant: '' }
  return null
}

// Workflow dispatch through the shell: the gh CLI (workflow / run / api, with or without leading flags) and any
// curl / wget / http call to api.github.com whose path reaches dispatches, actions/workflows or actions/runs. Quoting and
// backslashes are stripped and whitespace collapsed first, case-insensitive. Best effort (a script that builds the
// request elsewhere is not seen); defence in depth, see README.
function shellDispatchViolation(command: string): string | undefined {
  const c = command.replace(/['"`\\]/g, '').replace(/\s+/g, ' ')
  if (/\bgh\s+(?:-[-\w]+(?:[ =]\S+)?\s+)*(?:workflow|run|api)\b/i.test(c))
    return 'the gh CLI (workflow / run / api) is not available to a pinned drafting session; use the mcp__github__actions_run_trigger dispatch from draft_lint_request'
  if (/\b(?:curl|wget|https?|xh)\b/i.test(c) && /api\.github\.com/i.test(c) && /(?:dispatches|actions\/workflows|actions\/runs)/i.test(c))
    return 'a direct GitHub API call to dispatches / actions/workflows / actions/runs is not available to a pinned drafting session; use the mcp__github__actions_run_trigger dispatch from draft_lint_request'
  return undefined
}

const CONTRACT_FALLBACKS = [
  '/home/user/bbm-refresh-agent/stages/v2_s6_draft.md',
  '../bbm-refresh-agent/stages/v2_s6_draft.md',
]

// A gate that throws before it reached next() denies. After next() was reached the tool already ran, and in a
// .catch handler `next` is replay-safe (it resolves to what the last call settled to, nothing beneath runs
// again), so returning next(e) there reports the real outcome instead of a deny for a write that happened.
const failClosed = ($: any, e: any, next: any) =>
  next.called ? next(e) : { deny: say($, 'its guard failed; refusing.') }

type Contract = { ok: true; path: string; text: string } | { ok: false; tried: string[]; err: string }

async function loadContract($: any, configured: string): Promise<Contract> {
  const tried = configured ? [configured] : CONTRACT_FALLBACKS
  let err = ''
  for (const p of tried) {
    try {
      const text: string = await $.fs.read(p)
      if (text.trim().length > 0) return { ok: true, path: p, text }
      err = `${p} is empty`
    } catch (e) {
      err = `${p}: ${(e as Error)?.message ?? String(e)}`
    }
  }
  return { ok: false, tried, err }
}

// draft_lint.PRE_RECEIPT_SCOPE, copied (a mod cannot import the lint).
const PRE_RECEIPT_SCOPE = 'draft_receipt_complete.status'
const LINT_REL = 'webflow/bulk-operations/draft-lint/draft_lint.py'

// Same discipline as draft_lint_tool.py: BBM_INFRA_PATH first, never the cwd. When it is unset the
// session root (the checkout this session runs in) is the fallback. Neither found = a loud error.
async function resolveLintScript($: any): Promise<{ ok: true; path: string } | { ok: false; err: string }> {
  const fromEnv = await $.env.get('BBM_INFRA_PATH')
  const root = fromEnv || (await $.session.root())
  if (!root) return { ok: false, err: 'BBM_INFRA_PATH is unset and the session has no root; refusing to guess a checkout' }
  const path = `${String(root).replace(/\/$/, '')}/${LINT_REL}`
  try {
    await $.fs.stat(path)
    return { ok: true, path }
  } catch {
    return { ok: false, err: `no draft_lint.py at ${path} (set BBM_INFRA_PATH to a bbm-infrastructure checkout)` }
  }
}

// What the lint's own receipt says it examined. A PASS that skipped a check is a partial lint.
type Verdict = { unlock: boolean; lines: string[] }
function readReceipt(raw: string, planArticleId: string | undefined, run: Run, planVariant: string | undefined): Verdict {
  // A plan that names no article is not evidence about THIS article: explicit refusal, not an empty-string mismatch.
  if (planArticleId === '') return { unlock: false, lines: ['plan.json carries no article_id; receipt stays locked'] }
  const lines: string[] = []
  let result: any
  try {
    result = JSON.parse(raw)?.result
  } catch {
    return { unlock: false, lines: ['lint receipt was unreadable; treating the lint as not run'] }
  }
  if (!result || typeof result.passed !== 'boolean') return { unlock: false, lines: ['lint receipt has no verdict; treating the lint as not run'] }
  if (planArticleId !== undefined && planArticleId.toLowerCase() !== run.articleId.toLowerCase()) {
    return { unlock: false, lines: [`plan.json is for article ${planArticleId}, not this run's ${run.articleId}; receipt stays locked`] }
  }
  if (!result.passed) return { unlock: false, lines }
  // The lint may skip exactly one check (--pre-receipt). A receipt that scoped out anything else, or a malformed
  // checks_scoped, is a lint we did not ask for: it never unlocks.
  const scoped = result.counts?.checks_scoped
  if (scoped !== undefined && !(Array.isArray(scoped) && scoped.length === 1 && scoped[0] === PRE_RECEIPT_SCOPE))
    return { unlock: false, lines: [`lint receipt scoped out ${JSON.stringify(scoped)}; only ["${PRE_RECEIPT_SCOPE}"] may be skipped; receipt stays locked`] }
  if (result.brief_scanned !== true) lines.push('NOT RUN: locked-heading rule (no usable heading brief for this run)')
  if (methodRulesApply(run.variant, planVariant) && result.counts?.v2_method_rules_run !== true) lines.push('NOT RUN: V2 approved-method rules (template check)')
  if (result.testers_block_scanned !== true) lines.push('note: testers-block rule did not run (no testers list supplied)')
  if (result.experts_block_scanned !== true) lines.push('note: experts rule did not run (no experts list supplied)')
  const blocking = lines.filter(l => l.startsWith('NOT RUN'))
  return { unlock: blocking.length === 0, lines }
}

export const register: Register = (on, options) => {
  const str = (k: string) => String(options[k] ?? '').trim()

  // Module variables are the session's: a reload wipes them, and a wiped lint pass
  // means "not passed" — the safe direction.
  let run: Run | null =
    str('runId') && str('articleId')
      ? { runId: str('runId'), articleId: str('articleId'), slug: str('slug'), variant: str('templateVariant') }
      : null
  let lintPassed = false
  let lintedPlan = ''
  let lintNote = 'draft-lint has not been run in this session'

  // Re-locking is a state change the model and Stan should see, but only when a pass was actually lost:
  // it returns the call-out text to say (or '' when nothing was lost). The engine follows `$` only into
  // top-level functions, so the caller says it.
  const dirty = (why: string): string => {
    const lost = lintPassed
    if (lost) lintNote = `draft-lint passed earlier, but ${why} since; re-run /draft-done`
    lintPassed = false
    return lost ? `Draft receipt re-locked: ${lintNote}` : ''
  }

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'draft-start',
      description: 'Pin this session to a refresh run: /draft-start <run_id> <article_id> <slug> [v1|v2|standard]',
      argumentHint: '<run_id> <article_id> <slug> [v1|v2|standard]',
    })
    await $.command.register({
      name: 'draft-done',
      description: 'Run draft-lint (v2_s6_5 checks); passing unlocks the Draft receipt. Optional plan.json for offline lint',
      argumentHint: '[plan.json]',
    })
    await $.tool.register({
      name: 'draft_pin',
      description:
        'Pin this session to a refresh run so the Draft guards apply (writes to other articles and the passing stage-6 receipt are gated). ' +
        'Call once at the start of a drafting session. Setting a pin only adds restrictions; the same run again is a no-op; ' +
        'a different run is refused and nothing can unpin (a human does that with /draft-start).',
      inputSchema: {
        type: 'object',
        properties: {
          run_id: { type: 'string', description: 'refresh_runs.id (uuid)' },
          article_id: { type: 'string', description: 'articles.id (uuid) of the run' },
          slug: { type: 'string', description: 'Optional article slug; pins file edits to that article' },
        },
        required: ['run_id', 'article_id'],
      },
    })
    await $.tool.register({
      name: 'draft_lint_request',
      description:
        'Ask for the credentialed Draft lint. Returns the exact GitHub workflow dispatch that runs draft-lint in CI and writes the stage-6 receipt. ' +
        'Changes nothing and unlocks nothing; the receipt is written only by that workflow, from the real lint result.',
      inputSchema: { type: 'object', properties: {} },
    })
    if (!run) {
      // Optional env pin (the orchestrator brief can set it). Both must be present and uuid-shaped; anything else pins nothing.
      const envRun = await envRunId($)
      const envArt = await envArticleId($)
      if (envRun && envArt) {
        if (UUID_SHAPE.test(envRun) && UUID_SHAPE.test(envArt)) {
          run = { runId: envRun.toLowerCase(), articleId: envArt.toLowerCase(), slug: '', variant: '' }
          lintPassed = false
          lintNote = 'draft-lint has not been run for this run'
          say($, `session pinned to run ${run.runId} (article ${run.articleId}) from BBM_DRAFT_RUN_ID / BBM_DRAFT_ARTICLE_ID`)
        } else {
          say($, 'BBM_DRAFT_RUN_ID / BBM_DRAFT_ARTICLE_ID are set but not uuids: this session is NOT pinned. Call draft_pin.')
        }
      }
    }
    if (run) $.ui.status(`drafting run ${run.runId.slice(0, 8)}`)
    return started
  })

  // Model-callable pin. The only state change: unpinned -> pinned (or add a slug to a pin with none). Never unpin, never re-pin.
  on('tool.call', { tool: 'mcp__draft-session__draft_pin' }, async ($, e: any) => {
    const runId = String(e.run_id ?? '').trim().toLowerCase()
    const articleId = String(e.article_id ?? '').trim().toLowerCase()
    const slug = String(e.slug ?? '').trim()
    if (!UUID_SHAPE.test(runId) || !UUID_SHAPE.test(articleId))
      return { deny: say($, 'draft_pin REFUSED: run_id and article_id must both be uuids (refresh_runs.id and articles.id). Nothing was pinned.') }
    if (slug && !SLUG_SHAPE.test(slug)) return { deny: say($, `draft_pin REFUSED: slug ${JSON.stringify(slug)} is not a lowercase slug. Nothing was pinned.`) }
    // An env pin outlives a mod reload (the in-memory pin does not): when BBM_DRAFT_RUN_ID is set it is the only run
    // this session may be pinned to, even if the in-memory state is empty.
    const envRun = (await envRunId($)).toLowerCase()
    const envArt = (await envArticleId($)).toLowerCase()
    if (envRun && envRun !== runId)
      return { deny: say($, `draft_pin REFUSED: BBM_DRAFT_RUN_ID pins this session to run ${envRun}, not ${runId}. Nothing was pinned.`) }
    if (envArt && envArt !== articleId)
      return { deny: say($, `draft_pin REFUSED: BBM_DRAFT_ARTICLE_ID pins this session to article ${envArt}, not ${articleId}. Nothing was pinned.`) }
    if (run) {
      if (run.runId.toLowerCase() !== runId || run.articleId.toLowerCase() !== articleId)
        return { deny: say($, `draft_pin REFUSED: this session is already pinned to run ${run.runId} (article ${run.articleId}). A pin is never changed from inside the session; a human re-pins with /draft-start.`) }
      if (slug && run.slug && slug !== run.slug)
        return { deny: say($, `draft_pin REFUSED: the pin already names slug ${run.slug}, not ${slug}.`) }
      if (slug && !run.slug) {
        run = { ...run, slug }
        return { result: say($, `pin extended: file edits are now pinned to slug ${slug} (run ${run.runId} unchanged).`) }
      }
      return { result: say($, `already pinned to run ${run.runId}; no change.`) }
    }
    run = { runId, articleId, slug, variant: '' }
    lintPassed = false
    lintedPlan = ''
    lintNote = 'draft-lint has not been run for this run'
    $.ui.status(`drafting run ${runId.slice(0, 8)}`)
    const c = await loadContract($, str('contractPath'))
    const head = say($, `session pinned to run ${runId} (article ${articleId}); writes to other articles and the Draft receipt are now gated. The pin cannot be removed from inside the session.`)
    return {
      result: c.ok
        ? `${head}\nContract: read stages/v2_s6_draft.md (${c.path}, ${c.text.length} chars); it is injected from the next turn.`
        : `${head}\n[mod:${MOD}] The contract is UNREADABLE (${c.err}); do not draft from memory.`,
    }
  })

  // Read-only: hands back the dispatch. It cannot unlock anything.
  on('tool.call', { tool: 'mcp__draft-session__draft_lint_request' }, async ($, e: any) => {
    if (!run) return { deny: say($, 'draft_lint_request REFUSED: this session is not pinned to a run. Call draft_pin {run_id, article_id} first.') }
    lintPassed = false
    lintNote = 'credentialed draft-lint requested; the stage-6 receipt is written by CI only'
    return { result: `${say($, 'the credentialed draft-lint runs in CI; the Draft receipt stays blocked here until CI has written it.')}\n${ciDispatchText(run)}` }
  })

  // A pinned session may dispatch the stage gate for its own run only.
  on('tool.call', { tool: DISPATCH_TOOL }, async ($, e: any, next) => {
    const pin = await effectivePin($, run)
    if (!pin) return next(e)
    const bad = dispatchViolation(e, pin)
    if (bad) return { deny: say($, `${bad}.`) }
    return next(e)
  }).catch(failClosed)

  // The same ban for the shell routes to a workflow run (gh, direct API calls). Registered before the Bash gates below.
  on('tool.call', { tool: 'Bash' }, async ($, e: any, next) => {
    if (!(await effectivePin($, run))) return next(e)
    const bad = shellDispatchViolation(String(e.command ?? ''))
    if (bad) return { deny: say($, `${bad}.`) }
    return next(e)
  }).catch(failClosed)

  on('command.run', { command: 'draft-start' }, async ($, e) => {
    const [runId, articleId, slug, variant] = e.args.trim().split(/\s+/)
    // The slug is required: it is the only pin that can tell this article's files from another's.
    if (!runId || !articleId || !slug) return { text: 'usage: /draft-start <run_id> <article_id> <slug> [v1|v2|standard] (the first three are required; the slug pins file edits; an unstated template is treated as v2, the strict side)' }
    run = { runId, articleId, slug, variant: variant ?? '' }
    lintPassed = false
    lintNote = 'draft-lint has not been run for this run'
    $.ui.status(`drafting run ${runId.slice(0, 8)}`)
    const c = await loadContract($, str('contractPath'))
    // One say() per outcome: its return value is both the toast and the headline the model reads, so the
    // two cannot diverge. An unreadable contract is a block, so it toasts the block reason, not just the pin.
    const headline = c.ok
      ? say($, `session pinned to run ${runId} (article ${articleId}); writes to other articles and the Draft receipt are now gated`)
      : say($, `session pinned to run ${runId}, but the CONTRACT IS UNREADABLE: ${c.err}. The contract was NOT injected and /draft-done will refuse. Do not draft from memory.`)
    return {
      text: c.ok
        ? `${headline}\nContract: ${c.path} (${c.text.length} chars) is injected into the system prompt from the next turn.`
        : headline,
      context: [
        `${headline} Read stages/v2_s6_draft.md in full before drafting if it is not in your system prompt.`,
      ],
    }
  })

  on('command.run', { command: 'draft-done' }, async ($, e) => {
    if (!run) return { text: 'draft-session is not pinned to a run. /draft-start <run_id> <article_id> first.' }
    lintPassed = false
    const c = await loadContract($, str('contractPath'))
    if (!c.ok) {
      lintNote = 'contract unreadable'
      return { text: say($, `REFUSED: contract unreadable (${c.err}). Fix the checkout path (userConfig contractPath) and retry.`) }
    }
    const plan = e.args.trim()
    const script = await resolveLintScript($)
    if (!script.ok) {
      lintNote = 'draft_lint.py not found'
      return { text: say($, `REFUSED: ${script.err}. The Draft receipt stays locked.`) }
    }
    // --pre-receipt (LC-1869): this lint DECIDES the stage-6 receipt, so it skips only the "v2_s6 status is not done"
    // finding (that status is the outcome). readReceipt refuses any other checks_scoped.
    // --run-id in BOTH modes: it is what turns on the locked-heading and template checks.
    let planArticle: string | undefined
    let planVariant: string | undefined
    if (plan) {
      try {
        const parsed = JSON.parse(await $.fs.read(plan))
        planArticle = String(parsed?.article_id ?? '')
        planVariant = parsed?.template_variant ?? undefined
      } catch (err) {
        lintNote = 'plan unreadable'
        return { text: say($, `REFUSED: could not read plan ${plan}: ${(err as Error)?.message ?? String(err)}. The Draft receipt stays locked.`) }
      }
    }
    // No service role = the lint cannot read the run (exit 2). Do not run it to learn that: hand over the CI dispatch.
    // Nothing is unlocked; the stage-6 receipt is then written by the workflow, from the real result.
    if (!(await hasServiceKey($))) {
      lintNote = 'no service-role key in this session; draft-lint runs in CI (stage-6-draft gate)'
      $.ui.status(`draft-lint via CI · run ${run.runId.slice(0, 8)}`)
      return { text: `${say($, 'no service-role key in this session, so draft-lint cannot run here. The Draft receipt stays blocked; CI writes it.')}\n${ciDispatchText(run)}` }
    }
    // The receipt file is how we learn what the lint actually EXAMINED, not just its exit code. It goes in a directory
    // THIS call creates (mktemp -d: new, mode 700, unpredictable name), so a stale or planted file cannot stand in for it.
    let outDir = ''
    try {
      const m = await $.process.run(['mktemp', '-d', '-t', 'draft-session-lint-XXXXXXXX'], { timeoutMs: 10_000 })
      outDir = m.exitCode === 0 ? String(m.stdout).trim() : ''
    } catch {
      outDir = ''
    }
    if (!outDir.startsWith('/')) {
      lintNote = 'could not create a private directory for the lint receipt'
      return { text: say($, 'REFUSED: could not create a private directory for the lint receipt. The Draft receipt stays locked.') }
    }
    const outPath = `${outDir}/lint.json`
    const argv = plan
      ? ['python3', script.path, '--plan', plan, '--run-id', run.runId, '--pre-receipt', '--output', outPath]
      : ['python3', script.path, '--article-id', run.articleId, '--run-id', run.runId, '--pre-receipt', '--output', outPath]
    let out = ''
    let code: number
    try {
      const r = await $.process.run(argv, { timeoutMs: 120_000 })
      code = r.exitCode
      out = `${r.stdout}${r.stderr ? `\n${r.stderr}` : ''}`.trim()
    } catch (err) {
      code = -1
      out = `could not run draft-lint: ${(err as Error)?.message ?? String(err)}`
    }
    // Only exit 0 can unlock; 1 = findings; 2 or anything else = the lint could not examine the draft.
    let verdict: Verdict = { unlock: false, lines: [] }
    if (code === 0) {
      let raw = ''
      try {
        raw = await $.fs.read(outPath)
      } catch {
        raw = ''
      }
      verdict = readReceipt(raw, planArticle, run, planVariant)
    } else if (planArticle !== undefined && planArticle.toLowerCase() !== run.articleId.toLowerCase()) {
      verdict.lines.push(`plan.json is for article ${planArticle}, not this run's ${run.articleId}`)
    }
    lintPassed = verdict.unlock
    lintedPlan = lintPassed ? plan : ''
    const partial = code === 0 && !verdict.unlock
    lintNote = lintPassed ? 'draft-lint PASS' : partial ? 'partial lint (checks did not run)' : `draft-lint did not pass (exit ${code})`
    const head = [out, ...verdict.lines].filter(Boolean).join('\n').split('\n').slice(0, 60).join('\n')
    $.ui.status(lintPassed ? `draft-lint PASS · run ${run.runId.slice(0, 8)}` : `draft-lint FAIL · run ${run.runId.slice(0, 8)}`)
    // Unlocking and staying locked are both actions of this mod: each is called out, with the lint's head below it.
    const headline = lintPassed
      ? say($, 'draft-lint PASS: the Draft receipt is unlocked until the next draft change.')
      : partial
        ? say($, 'PARTIAL LINT, receipt stays locked: the lint exited 0 but skipped checks it needs.')
        : say($, `draft-lint did NOT pass (exit ${code}). The Draft receipt stays blocked. Fix the draft, then /draft-done again.`)
    return { text: `${headline}\n${head}` }
  })

  on('prompt.compose', async ($, e, next) => {
    const base = await next(e)
    if (!run) return base
    const c = await loadContract($, str('contractPath'))
    const text = c.ok
      ? `# Draft session — run ${run.runId}, article ${run.articleId}\n` +
        `You are drafting v2_s6 for this run only. The contract below is read live from ${c.path}; it is the source. ` +
        `Run /draft-done (draft-lint) before writing the Draft receipt; the receipt is blocked until lint passes.\n\n${c.text}`
      : `# Draft session — CONTRACT UNAVAILABLE\n` +
        `The v2_s6 contract could not be read (${c.err}). DO NOT draft from memory or any older copy. ` +
        `Tell the user plainly that the contract file is missing and stop.`
    if (!c.ok) say($, 'contract unreadable, drafting is blocked', 15_000)
    return { sections: [...base.sections, { id: 'draft-session:contract', text, scope: 'session' as const }] }
  })

  // ---- gates: every one fails CLOSED (a throw while a run is pinned denies) ----

  on('tool.call', { tool: 'Bash' }, ($, e, next) => {
    if (!run) return next(e)
    const bad = bashPinViolation(e.command, run) ?? sqlPinViolation(e.command, run)
    if (bad) return { deny: say($, `${bad}.`) }
    // psql/curl-style stage-6 writes carry the same SQL as the MCP form: gate them the same way
    if (isDraftReceiptSql(e.command) && !lintPassed) return refuse($, `Draft receipt blocked: ${lintNote}`)
    const r = classifyReceiptCommand(e.command, run)
    if (r.pinViolation) return { deny: say($, `${r.pinViolation}.`) }
    if (r.gated && !lintPassed) return refuse($, `Draft receipt blocked: ${lintNote}`)
    const fileBad = bashFileWriteViolation(e.command, run)
    if (fileBad) return { deny: say($, `${fileBad}.`) }
    const touchesPlan = lintedPlan !== '' && e.command.includes(lintedPlan)
    if (runsDraftWriter(e.command) || writesArticleTable(e.command) || (looksLikeFileWrite(e.command) && (bashTouchesArticleFile(e.command) || touchesPlan)))
      relock($, dirty('a command may have changed the draft'))
    return next(e)
  }).catch(failClosed)

  on('tool.call', { tool: /^mcp__.*__(execute_sql|apply_migration)$/ }, ($, e, next) => {
    if (!run) return next(e)
    const sql = String((e as any).query ?? '')
    const bad = sqlPinViolation(sql, run)
    if (bad) return { deny: say($, `${bad}.`) }
    if (isDraftReceiptSql(sql) && !lintPassed) return refuse($, `Draft receipt blocked: ${lintNote}`)
    if (writesArticleTable(sql)) relock($, dirty('the draft was written'))
    return next(e)
  }).catch(failClosed)

  on('tool.call', { tool: /^(Edit|Write|NotebookEdit)$/ }, ($, e, next) => {
    if (!run) return next(e)
    const path = String((e as any).file_path ?? (e as any).notebook_path ?? '')
    const bad = filePinViolation(path, run)
    if (bad) return { deny: say($, `${bad}.`) }
    // Only the run's own article files (and the plan that was linted) are the draft; scratch and notes edits do not re-lock.
    if (isArticlePath(path) || (lintedPlan !== '' && path.endsWith(lintedPlan))) relock($, dirty('the draft was edited'))
    return next(e)
  }).catch(failClosed)
}
