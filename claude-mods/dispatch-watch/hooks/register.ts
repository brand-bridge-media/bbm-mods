import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Watch } from '../types'
import { decide, parseDispatch, parseReply, parseReqId, POLL_MS, replySql, REPLY_STALE_MS, statusSql } from './logic'

// Why (LCH-528): a dispatched workflow is watched by the mod, not by a check-in the session
// schedules and forgets. Decisions live in ./logic.ts; this file gathers facts and acts.

const watches = atom({ plugin: 'dispatch-watch', key: 'watches' } as const, [] as Watch[])

function textOf(r: { content?: readonly unknown[] }): string {
  return (r.content ?? []).map(c => String((c as { text?: unknown }).text ?? '')).join('')
}

// Wakes the host refused (submitted from inside a tool call) wait for the turn's end.
const pendingWakes: string[] = []
let ticking = false
let busy = false

function wake($: any, line: string) {
  pendingWakes.push(line)
  flush($)
}

function flush($: any) {
  if (pendingWakes.length === 0) return
  const lines = pendingWakes.splice(0)
  try { $.ui.toast(lines[0]!.slice(0, 200)) } catch { /* a toast never changes a wake */ }
  Promise.resolve()
    .then(() => $.prompt.submit({ text: lines.join('\n') }))
    .catch(() => { pendingWakes.unshift(...lines) })
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
      if (d.wake) wake($, d.wake)
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
