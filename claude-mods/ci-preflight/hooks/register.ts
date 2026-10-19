import type { Register } from 'claude-code'

import {
  PREFLIGHT_TIMEOUT_MS, decidePush, decideUpdateBranch, hasSkip, nudgeFor, parseCheckRuns, parsePushes, remember,
} from './logic'
import type { Push, PreflightRun } from './logic'

// Why this exists (LC-1846): CI runs ~19 checks per push on a CPU-bound VPS. On 2026-10-19 the
// schema-drift check failed twice (#1833, #1834) and each failure cost a full round, although the
// checks take seconds locally. scripts/ci/preflight.sh runs them before the push leaves the session.
// All decisions live in ./logic.ts (unit-tested); this file only gathers facts and acts.

const UPDATE_BRANCH = /^mcp__(github|GitHub_Custom)__update_pull_request_branch$/
const STORE_KEY = 'lastPushByBranch'
const SCRIPT = 'scripts/ci/preflight.sh'

// Callout convention (claude-mods/README.md): prefix for the model, toast for Stan.
function say($: any, text: string, toast?: string, isQuiet = false): string {
  const msg = `[mod:ci-preflight] ${text}`
  if (!isQuiet) $.ui.toast(toast ? `[mod:ci-preflight] ${toast}` : msg)
  return msg
}

function textOf(r: { content?: readonly unknown[] }): string {
  return (r.content ?? []).map(c => String((c as { text?: unknown }).text ?? '')).join('')
}

async function repoTop($: any, p: Push): Promise<string | undefined> {
  try {
    const r = await $.process.run(['git', '-C', p.dir ?? '.', 'rev-parse', '--show-toplevel'], { timeoutMs: 10_000 })
    const top = String(r.stdout ?? '').trim()
    return r.exitCode === 0 && top ? top : undefined
  } catch { return undefined }
}

async function runPreflight($: any, p: Push, top: string | undefined): Promise<PreflightRun> {
  if (p.isDirUnresolved) return { kind: 'unresolved-dir' }
  // Other repos get this mod through the bbm-mods mirror; only a repo that carries the script is checked.
  if (!top || !(await $.fs.exists(`${top}/${SCRIPT}`))) return { kind: 'not-applicable' }
  const started = await $.clock.now()
  try {
    const r = await $.process.run(['bash', `${top}/${SCRIPT}`, top, 'origin/main'], { cwd: top, timeoutMs: PREFLIGHT_TIMEOUT_MS })
    return { kind: 'exit', code: r.exitCode, output: `${r.stdout ?? ''}${r.stderr ? '\n' + r.stderr : ''}` }
  } catch (x) {
    const message = x instanceof Error ? x.message : String(x)
    // process.run kills the child and rejects at timeoutMs. The rejection's wording is not a contract, so a
    // rejection after (nearly) the whole budget counts as a timeout too. Never block on our own slowness.
    const elapsed = (await $.clock.now()) - started
    const isTimeout = /time/i.test(message) || elapsed >= PREFLIGHT_TIMEOUT_MS * 0.9
    return isTimeout ? { kind: 'timeout', seconds: PREFLIGHT_TIMEOUT_MS / 1000 } : { kind: 'error', message: message.slice(0, 120) }
  }
}

async function branchOf($: any, p: Push, top: string | undefined): Promise<string> {
  if (p.branch) return p.branch
  try {
    const r = await $.process.run(['git', '-C', top ?? p.dir ?? '.', 'rev-parse', '--abbrev-ref', 'HEAD'], { timeoutMs: 10_000 })
    return r.exitCode === 0 ? String(r.stdout ?? '').trim() : ''
  } catch { return '' }
}

export const register: Register = on => {
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const command = String((e as { command?: unknown }).command ?? '')
    if (!command.includes('push')) return next(e)
    const pushes = parsePushes(command)
    if (pushes.length === 0) return next(e)

    const isSkip = hasSkip(command)
    const notes: string[] = []
    const targets: { p: Push; top: string | undefined }[] = []
    const seen = new Set<string>()
    for (const p of pushes) {
      const key = `${p.dir ?? ''}|${p.isDirUnresolved}`
      if (seen.has(key)) continue
      seen.add(key)
      const top = await repoTop($, p)
      targets.push({ p, top })
      const run: PreflightRun = isSkip ? { kind: 'skipped' } : await runPreflight($, p, top)
      const d = decidePush(run)
      if (d.deny !== undefined) return { deny: say($, d.deny, d.toast) }
      for (const c of d.context ?? []) notes.push(say($, c, undefined, d.isQuiet))
    }

    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError) return ran

    // Batching nudge: warning only, after a push that looks successful.
    try {
      const now = await $.clock.now()
      let map = (await $.store.get(STORE_KEY)) as Record<string, number> | undefined
      for (const { p, top } of targets) {
        const branch = await branchOf($, p, top)
        if (!branch) continue
        const k = `${top ?? p.dir ?? ''}::${branch}`
        const nudge = nudgeFor(map?.[k], now)
        if (nudge) notes.push(say($, nudge))
        map = remember(map, k, now)
      }
      await $.store.set(STORE_KEY, map ?? {})
    } catch { /* a store or clock failure must never change the push's outcome */ }

    return notes.length ? { ...ran, context: [...(ran.context ?? []), ...notes] } : ran
  // Fail open: a bug in this mod must never stop a push.
  }).catch(($, e, next) => next(e))

  // Update-branch guard. ADVISORY-STRENGTH, FAILS OPEN: when the check runs cannot be read the update
  // is allowed with a warning (see decideUpdateBranch). CLAUDE.md section 5 owns the rule.
  on('tool.call', { tool: UPDATE_BRANCH }, async ($, ev, next) => {
    const e = ev as unknown as Record<string, unknown>
    let runs: ReturnType<typeof parseCheckRuns>
    let readError: string | undefined
    try {
      const server = String(e.tool).split('__')[1] ?? 'github'
      const r = await $.mcp.call(server, 'pull_request_read', {
        method: 'get_check_runs', owner: e.owner, repo: e.repo, pullNumber: e.pullNumber, perPage: 100,
      })
      if (r.isError) readError = 'the MCP call returned an error'
      else {
        runs = parseCheckRuns(textOf(r))
        if (runs === undefined) readError = 'unrecognised response shape'
      }
    } catch (x) {
      readError = x instanceof Error ? x.message.slice(0, 120) : 'MCP call failed'
    }
    const d = decideUpdateBranch(runs, readError)
    if (d.deny !== undefined) return { deny: say($, d.deny, d.toast) }
    const ran = await next(ev)
    if (ran.deny !== undefined || !d.context) return ran
    return { ...ran, context: [...(ran.context ?? []), ...d.context.map(c => say($, c))] }
  }).catch(($, e, next) => next(e))
}
