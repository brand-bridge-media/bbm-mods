import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Watch } from '../types'
import { decide, parseRuns, parseStart, POLL_MS, watchKey } from './logic'
import type { Observation } from './logic'

// Why (LC-1975): see ./logic.ts. Decisions live there; this file gathers facts and acts.

const watches = atom({ plugin: 'workflow-run-watch', key: 'watches' } as const, [] as Watch[])
// Keys of watches that ended: unwatched-job-guard reads both lists through the `watching` tool.
const finished = atom({ plugin: 'workflow-run-watch', key: 'finished' } as const, [] as string[])

const pendingWakes: string[] = []
let ticking = false
let busy = false

function textOf(r: { content?: readonly unknown[] }): string {
  return (r.content ?? []).map(c => String((c as { text?: unknown }).text ?? '')).join('')
}

function flush($: any) {
  if (pendingWakes.length === 0) return
  const lines = pendingWakes.splice(0)
  try { $.ui.toast(lines[0]!.slice(0, 200)) } catch { /* a toast never changes a wake */ }
  Promise.resolve()
    .then(() => $.prompt.submit({ text: lines.join('\n') }))
    .catch(() => { pendingWakes.unshift(...lines) })
}

async function observe($: any, w: Watch): Promise<Observation> {
  try {
    const r = w.runId !== undefined
      ? await $.mcp.call(w.server, 'actions_get', { method: 'get_workflow_run', owner: w.owner, repo: w.repo, resource_id: String(w.runId) })
      : await $.mcp.call(w.server, 'actions_list', { method: 'list_workflow_runs', owner: w.owner, repo: w.repo, resource_id: w.workflow,
          perPage: 20, workflow_runs_filter: { event: 'workflow_dispatch' } })
    if (r.isError) return { kind: 'error', detail: textOf(r).slice(0, 120) || 'tool error' }
    const runs = parseRuns(textOf(r))
    return runs ? { kind: 'runs', runs } : { kind: 'error', detail: 'reply not readable as runs' }
  } catch (err) { return { kind: 'error', detail: String(err).slice(0, 120) } }
}

async function tick($: any) {
  if (busy) return
  busy = true
  try {
    const now = await $.clock.now()
    for (const w of await read($, watches)) {
      const d = decide(w, await observe($, w), now)
      if (d.wake) { pendingWakes.push(d.wake); flush($) }
      await update($, watches, l => (d.done ? l.filter(x => x.startedAt !== w.startedAt || watchKey(x) !== watchKey(w))
        : l.map(x => (x.startedAt === w.startedAt && watchKey(x) === watchKey(w) ? { ...x, ...d.patch } : x))))
      if (d.done) await update($, finished, l => [...l.filter(k => k !== watchKey(w)), watchKey(w)].slice(-50))
    }
  } catch { /* a failed tick is retried by the next one */ } finally {
    busy = false
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.tool.register({
      name: 'watching',
      description: 'What workflow-run-watch is watching now and which watches ended (JSON {active, finished} of run:owner/repo:<workflow|run id> keys). Read by unwatched-job-guard.',
      inputSchema: { type: 'object', properties: {} },
    })
    return started
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'mcp__workflow-run-watch__watching' }, async $ => {
    const active = [...new Set((await read($, watches)).map(w => watchKey(w)))]
    return { result: JSON.stringify({ active, finished: (await read($, finished)).filter(k => !active.includes(k)) }) }
  }).catch(() => ({ result: '{"error":"workflow-run-watch could not read its watches"}' }))

  on('tool.call', { tool: /^mcp__.*__actions_run_trigger$/ }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError) return ran
    const a = e as any
    const start = parseStart(a)
    if (!start) return ran
    const now = await $.clock.now()
    const w: Watch = { owner: String(a.owner), repo: String(a.repo), server: String(a.tool).split('__')[1] ?? 'github',
      ...start, since: new Date(now - 60_000).toISOString(), startedAt: now }
    await update($, watches, l => [...l.filter(x => watchKey(x) !== watchKey(w)), w])
    await update($, finished, l => l.filter(k => k !== watchKey(w)))
    if (!ticking) {
      ticking = true
      $.clock.every(POLL_MS, () => { void tick($) })
    }
    return { ...ran, context: [...(ran.context ?? []),
      `[mod:workflow-run-watch] Watching ${w.owner}/${w.repo} ${w.workflow ?? `run ${w.runId}`}: checked every minute; this session ` +
      'is woken when it finishes (flagging a finish under 2 minutes), never registers, or runs past 90 minutes. No check-in needed.'] }
  // Fail open: a bug here must never change the start's outcome.
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const res = await next(e)
    flush($)
    return res
  })
}
