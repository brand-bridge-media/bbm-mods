import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Call, Receipt } from '../types'

// Why (LC-2043): see ./idle-backstop-guard.py, which holds every decision and its tests. This file
// records the check-ins the session makes, gathers what is open at turn end, asks the check, and acts.
//
// Fail open everywhere: an unreadable source or a crash allows the turn to end with a NOT CHECKED
// toast. Only a clear BLOCK from the check ever stops a turn.
const OWN = '[mod:idle-backstop-guard]'
const SERVER = 'claude-code-remote'
const CHECK_INS = /^mcp__.*__(send_later|create_trigger)$/
const WATCHERS = ['pr-ci-watch', 'dispatch-watch', 'workflow-run-watch']
const MAX_CALLS = 50
const MAX_TEXT = 4_000

const calls = atom({ plugin: 'idle-backstop-guard', key: 'calls' } as const, [] as Call[])
const blocks = atom({ plugin: 'idle-backstop-guard', key: 'blocks' } as const, 0)
const receipt = atom({ plugin: 'idle-backstop-guard', key: 'receipt' } as const, null as Receipt | null)

type Verdict = { verdict: 'PASS' | 'BLOCK' | 'NOT CHECKED'; reason: string; block: string | null; released?: boolean }

// --- $ helpers: they live here because the plugin validator follows $ only into functions
// declared in the hook's own file.
function toast($: any, text: string): void {
  try { $.ui.toast(text.split('\n')[0]!.slice(0, 200)) } catch { /* a toast never changes a verdict */ }
}

function textOf(out: any): string | null {
  if (!out || out.deny || out.isError) return null
  if (typeof out.result === 'string') return out.result
  if (typeof out.text === 'string') return out.text
  try {
    const c = out.result?.content ?? out.content
    if (Array.isArray(c)) return c.map((b: any) => String(b?.text ?? '')).join('')
  } catch { /* unreadable */ }
  return null
}

async function readTool($: any, tool: string): Promise<string | null> {
  try { return textOf(await $.tool.call({ tool })) } catch { return null }
}

async function readSession($: any): Promise<string | null> {
  try { return textOf(await $.mcp.call(SERVER, 'get_session', {})) } catch { return null }
}

async function ask($: any, payload: unknown): Promise<Verdict | null> {
  try {
    const r = await $.process.run(['python3', '-I', `${$.plugin.root}/hooks/idle-backstop-guard.py`],
      { stdin: JSON.stringify(payload), timeoutMs: 10_000 })
    if (r?.exitCode !== 0) return null
    const v = JSON.parse(String(r.stdout ?? ''))
    // Only the three verdicts count, and a BLOCK must carry its text: anything else is "did not answer" (NOT CHECKED),
    // so a malformed answer can neither count as a refusal nor pass silently.
    const ok = v && ['PASS', 'BLOCK', 'NOT CHECKED'].includes(v.verdict) && typeof v.reason === 'string'
    return ok && (v.verdict !== 'BLOCK' || (typeof v.block === 'string' && v.block !== '')) ? v : null
  } catch { return null }
}

async function judgeTurnEnd($: any): Promise<Verdict> {
  const now = await $.clock.now()
  const watchers: Record<string, string | null> = {}
  for (const w of WATCHERS) watchers[w] = await readTool($, `mcp__${w}__watching`)
  const payload = {
    now_ms: now,
    calls: await read($, calls),
    children: await readTool($, 'mcp__fleet-tracker__open_children'),
    watchers,
    session: await readSession($),
    blocks: await read($, blocks),
  }
  return (await ask($, payload)) ?? { verdict: 'NOT CHECKED', reason: 'the check did not answer; not blocking', block: null }
}

async function settle($: any, v: Verdict): Promise<void> {
  const now = await $.clock.now()
  await update($, receipt, () => ({ at: now, verdict: v.verdict, reason: v.reason }))
  try { $.ui.log(`${OWN} receipt: ${v.verdict}: ${v.reason}`, { to: 'debug' }) } catch { /* best effort */ }
  if (v.verdict === 'BLOCK') await update($, blocks, n => n + 1)
  // PASS, or a release after MAX_BLOCKS refusals: re-arm, so the next turn end is judged afresh (CI review, LC-2043).
  else if (v.verdict === 'PASS' || v.released === true) await update($, blocks, () => 0)
  if (v.verdict === 'BLOCK') toast($, v.block ?? `${OWN} ${v.reason}`)
  else if (v.verdict === 'NOT CHECKED') toast($, `${OWN} NOT CHECKED: ${v.reason}`)
}

export const register: Register = on => {
  // Record every check-in the session makes that succeeded; the check decides which count.
  on('tool.call', { tool: CHECK_INS }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError) return ran
    const a = e as Record<string, unknown>
    const input: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(a)) if (!['tool', 'tool_use_id', 'agentId', 'requestMeta'].includes(k)) input[k] = v
    const result = (textOf(ran) ?? '').slice(0, MAX_TEXT)
    const at = await $.clock.now()
    await update($, calls, l => [...l, { tool: String(a.tool), input, result, at_ms: at }].slice(-MAX_CALLS))
    return ran
  // A recording failure must never change the call's outcome.
  }).catch(($, e, next) => next(e))

  on('classic.Stop', async ($, e, next) => {
    let v: Verdict
    try { v = await judgeTurnEnd($) } catch { v = { verdict: 'NOT CHECKED', reason: 'the guard crashed; not blocking', block: null } }
    try { await settle($, v) } catch { /* a receipt failure never changes the verdict */ }
    return v.verdict === 'BLOCK' && v.block ? { block: v.block } : next(e)
  // Fail open: a bug here must never trap a session.
  }).catch(($, e, next) => next(e))
}
