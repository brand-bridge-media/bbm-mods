import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Watch } from '../types'
import { decide, parseDispatch, watchKey, parseReply, parseReqId, POLL_MS, replySql, REPLY_STALE_MS, stampWake, statusSql } from './logic'
import type { Wake } from './logic'

// Why (LCH-528): a dispatched workflow is watched by the mod, not by a check-in the session
// schedules and forgets. Decisions live in ./logic.ts; this file gathers facts and acts.

const watches = atom({ plugin: 'dispatch-watch', key: 'watches' } as const, [] as Watch[])
// Keys of watches that ended: unwatched-job-guard (LC-1975) reads both lists through the `watching` tool.
const finished = atom({ plugin: 'dispatch-watch', key: 'finished' } as const, [] as string[])

function textOf(r: { content?: readonly unknown[] }): string {
  return (r.content ?? []).map(c => String((c as { text?: unknown }).text ?? '')).join('')
}

// Wakes the host refused (submitted from inside a tool call) wait for the turn's end.
const pendingWakes: Wake[] = []
let ticking = false
let busy = false

function wake($: any, line: string, at: number) {
  pendingWakes.push({ text: line, at })
  flush($)
}

function flush($: any) {
  if (pendingWakes.length === 0) return
  const wakes = pendingWakes.splice(0)
  // LC-2043: stamp each line with its real event time and how late it arrives, at the moment of delivery.
  Promise.resolve()
    .then(async () => {
      const now = await $.clock.now()
      const lines = wakes.map(w => stampWake(w, now))
      try { $.ui.toast(lines[0]!.slice(0, 200)) } catch { /* a toast never changes a wake */ }
      await $.prompt.submit({ text: lines.join('\n') })
    })
    .catch(() => { pendingWakes.unshift(...wakes) })
}

async function sql($: any, w: Watch, query: string): Promise<string | null> {
  try {
    const r = await $.mcp.call(w.server, 'execute_sql', { project_id: w.projectId, query })
    return r.isError ? null : textOf(r)
  } catch { return null }
}

async function tick($: any) {
  if (busy) return
  busy = true
  try {
    const now = await $.clock.now()
    for (const w of await read($, watches)) {
      if (w.reqId === undefined || now - (w.reqAt ?? 0) > REPLY_STALE_MS) {
        const id = parseReqId((await sql($, w, statusSql(w))) ?? '')
        await update($, watches, l => l.map(x => (x === w || x.startedAt === w.startedAt
          ? { ...x, reqId: id ?? undefined, reqAt: now } : x)))
        continue
      }
      const d = decide(w, parseReply((await sql($, w, replySql(w.reqId))) ?? ''), now)
      if (d.wake) wake($, d.wake, d.eventAt ?? now)
      if (d.done) await update($, finished, l => [...l.filter(k => k !== watchKey(w.workflow)), watchKey(w.workflow)].slice(-50))
      await update($, watches, l => (d.done
        ? l.filter(x => x.startedAt !== w.startedAt)
        // The answer is used: the next tick sends a fresh status request.
        : l.map(x => (x.startedAt === w.startedAt ? { ...x, reqId: undefined, warnedLong: x.warnedLong || d.warnedLong } : x))))
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
      description: 'What dispatch-watch is watching now and which watches ended (JSON {active, finished} of dispatch:<workflow> keys). Read by unwatched-job-guard.',
      inputSchema: { type: 'object', properties: {} },
    })
    return started
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'mcp__dispatch-watch__watching' }, async $ => {
    const active = [...new Set((await read($, watches)).map(w => watchKey(w.workflow)))]
    return { result: JSON.stringify({ active, finished: (await read($, finished)).filter(k => !active.includes(k)) }) }
  }).catch(() => ({ result: '{"error":"dispatch-watch could not read its watches"}' }))

  on('tool.call', { tool: /^mcp__.*__execute_sql$/ }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError) return ran
    const workflow = parseDispatch(String((e as any).query ?? ''))
    if (!workflow) return ran
    const now = await $.clock.now()
    const w: Watch = {
      workflow,
      server: String((e as any).tool).split('__')[1] ?? 'Supabase',
      projectId: String((e as any).project_id ?? ''),
      since: new Date(now - 60_000).toISOString(),
      startedAt: now,
    }
    await update($, watches, l => [...l, w])
    await update($, finished, l => l.filter(k => k !== watchKey(workflow)))
    if (!ticking) {
      ticking = true
      $.clock.every(POLL_MS, () => { void tick($) })
    }
    return { ...ran, context: [...(ran.context ?? []),
      `[mod:dispatch-watch] Watching ${workflow}: its run is checked every minute and this session is woken when it ` +
      'finishes (or fails to start). Do not schedule a long check-in for it.'] }
  // Fail open: a bug here must never change the dispatch's outcome.
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const res = await next(e)
    flush($)
    return res
  })
}
