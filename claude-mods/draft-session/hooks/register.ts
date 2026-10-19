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
    if (run) $.ui.status(`drafting run ${run.runId.slice(0, 8)}`)
    return started
  })

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
    // The receipt file is how we learn what the lint actually EXAMINED, not just its exit code.
    const outPath = `/tmp/draft-session-lint-${run.runId.slice(0, 8)}-${await $.clock.now()}.json`
    // --run-id in BOTH modes: it is what turns on the locked-heading and template checks.
    const argv = plan
      ? ['python3', script.path, '--plan', plan, '--run-id', run.runId, '--output', outPath]
      : ['python3', script.path, '--article-id', run.articleId, '--run-id', run.runId, '--output', outPath]
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
