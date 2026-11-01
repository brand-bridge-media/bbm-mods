import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Job } from '../types'
import { blockText, CHECK_IN_RE, judge, jobsOf, MAX_BLOCKS, OWN, parseWatching, signalOf } from './logic'
import type { Held, Signal } from './logic'

// Why (LC-1975): see ./logic.ts. Decisions live there; this file records starts and asks the watchers.

const jobs = atom({ plugin: 'unwatched-job-guard', key: 'jobs' } as const, [] as Job[])
const HOLDERS = ['pr-ci-watch', 'dispatch-watch', 'workflow-run-watch'] as const

function toast($: any, text: string) {
  try { $.ui.toast(text.slice(0, 200)) } catch { /* a toast never changes a verdict */ }
}

export const register: Register = on => {
  let cached: Signal | undefined

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.tool.register({
      name: 'release',
      description: 'Tell unwatched-job-guard a job it lists is finished or handled (give the job key it printed and what you saw).',
      inputSchema: { type: 'object', properties: { job: { type: 'string' }, reason: { type: 'string' } }, required: ['job', 'reason'] },
    })
    return started
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'mcp__unwatched-job-guard__release' }, async ($, e: any) => {
    const key = String(e.job ?? '')
    if (!key || !String(e.reason ?? '').trim()) return { result: `${OWN} job and reason are required.` }
    const had = (await read($, jobs)).some(j => j.key === key)
    await update($, jobs, l => l.filter(j => j.key !== key))
    try { $.ui.log(`unwatched-job-guard: released ${key}: ${String(e.reason).slice(0, 200)}`, { to: 'debug' }) } catch { /* best effort */ }
    return { result: had ? `${OWN} released ${key}.` : `${OWN} no open job ${key}; open jobs are listed in the block message.` }
  }).catch(() => ({ result: `${OWN} could not release the job.` }))

  // Record every start that succeeded; a check-in holds every job open at that moment.
  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError) return ran
    const now = await $.clock.now()
    const tool = String((e as any).tool ?? '')
    if (CHECK_IN_RE.test(tool)) {
      await update($, jobs, l => l.map(j => ({ ...j, checkIn: true })))
      return ran
    }
    const started = jobsOf(e as any, now)
    if (started.length) {
      const keys = started.map(j => j.key)
      await update($, jobs, l => [...l.filter(j => !keys.includes(j.key)), ...started].slice(-30))
    }
    return ran
  // Fail open: a bug here must never change a tool call's outcome.
  }).catch(($, e, next) => next(e))

  on('classic.Stop', async ($, e, next) => {
    const open = (await read($, jobs)).filter(j => !j.checkIn)
    if (open.length === 0) return next(e)
    const held: Record<string, Held> = {}
    for (const h of HOLDERS) {
      if (!open.some(j => j.holder === h)) continue
      try { held[h] = parseWatching(await $.tool.call({ tool: `mcp__${h}__watching` } as any)) } catch { held[h] = null }
    }
    const v = judge(open, held)
    if (v.finished.length) await update($, jobs, l => l.filter(j => !v.finished.includes(j.key)))
    const due = v.unwatched.filter(u => (u.job.blocks ?? 0) < MAX_BLOCKS)
    if (v.unwatched.length === 0) return next(e)

    if (!cached) {
      let sig: Signal
      try { sig = signalOf(await $.mcp.call('claude-code-remote', 'get_session', {})) } catch (err) { sig = { kind: 'unreadable', reason: String(err).slice(0, 80) } }
      if (sig.kind !== 'unreadable') cached = sig
      else {
        try { $.ui.log(`unwatched-job-guard: did not block, session signal unreadable (${sig.reason})`, { to: 'debug' }) } catch { /* best effort */ }
        toast($, `${OWN} ${v.unwatched.length} job(s) unwatched: ${v.unwatched.map(u => u.job.what).join('; ')}`)
        return next(e)
      }
    }
    if (cached.kind !== 'child') {
      // A person is here: say it, never block.
      toast($, `${OWN} ${v.unwatched.length} job(s) nothing will wake you for: ${v.unwatched.map(u => u.job.what).join('; ')}`)
      return next(e)
    }
    if (due.length === 0) {
      toast($, `${OWN} letting the turn end with ${v.unwatched.length} unwatched job(s) after ${MAX_BLOCKS} refusals each.`)
      return next(e)
    }
    const keys = due.map(u => u.job.key)
    await update($, jobs, l => l.map(j => (keys.includes(j.key) ? { ...j, blocks: (j.blocks ?? 0) + 1 } : j)))
    const text = blockText(due)
    toast($, text)
    return { block: text }
  // Fail open: a bug here must never trap a session.
  }).catch(($, e, next) => next(e))
}
