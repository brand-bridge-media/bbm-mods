import { test, expect, mock } from 'claude-code/testing'

import { POLL_MS, restorable } from '../hooks/logic'

// LC-2043: watches lived only in $.state, so a restart emptied them and nothing polled again. They are now saved with
// the session's id and restored (and polled at once) on session.start.
const T0 = Date.parse('2026-11-05T19:00:00Z')
const MIN = 60_000
const iso = (ms: number) => new Date(ms).toISOString()
const W = { owner: 'o', repo: 'r', server: 'github', workflow: 'db-test.yml', since: iso(T0 - MIN), startedAt: T0 }
const fin = { id: 7, status: 'completed', conclusion: 'success', created_at: iso(T0 + 10_000), run_started_at: iso(T0 + 10_000), updated_at: iso(T0 + 23 * MIN), html_url: 'https://x/7' }

function host(on: any, opts: { saved?: unknown; sid?: string; reply?: () => unknown }) {
  const data: Record<string, unknown> = opts.saved === undefined ? {} : { saved: opts.saved }
  on('store.get', ((_$: any, e: any) => ({ value: data[e.key] })) as any)
  on('store.set', ((_$: any, e: any) => { data[e.key] = e.value; return { value: undefined } }) as any)
  const clock = mock.clock(on, { now: T0 + 60 * MIN })
  const prompts: string[] = []
  let calls = 0
  on('session.id', (() => ({ value: opts.sid ?? '' })) as any)
  on('tool.register', (() => ({ value: undefined })) as any)
  on('ui.toast', (() => ({ value: undefined })) as any)
  on('prompt.submit', ((_$: any, e: any) => { prompts.push(e.text); return { text: e.text } }) as any)
  on('mcp.call', (() => { calls++; return { value: { isError: false, content: [{ type: 'text', text: JSON.stringify([opts.reply ? opts.reply() : fin]) }] } } }) as any)
  on('session.start', (() => ({ cwd: '/tmp' })) as any)
  return { clock, prompts, data, calls: () => calls }
}

const settle = async (done: () => boolean) => { for (let i = 0; i < 30 && !done(); i++) await new Promise(r => setTimeout(r, 10)) }

test('a restart of the same session brings its watch back and delivers the finish at once, with its real time', async ($: any, on: any) => {
  const h = host(on, { saved: { sessionId: 'session_a', watches: [W], finished: [] }, sid: 'session_a' })
  await $.session.start({ source: 'resume', cwd: '/tmp' } as any)
  await settle(() => h.prompts.length > 0)
  expect(h.prompts[0]).toContain('finished: success')
  expect(h.prompts[0]).toContain('delivered 37 min late')
  await settle(() => (h.data.saved as any)?.watches?.length === 0)
  expect((h.data.saved as any).watches).toEqual([])
})

test('a restored watch whose run is still going keeps being polled on the timer', async ($: any, on: any) => {
  let done = false
  const h = host(on, { saved: { sessionId: 'session_a', watches: [W], finished: [] }, sid: 'session_a',
    reply: () => (done ? fin : { ...fin, status: 'in_progress', conclusion: null }) })
  await $.session.start({ source: 'resume', cwd: '/tmp' } as any)
  await settle(() => h.calls() > 0)
  expect(h.prompts).toEqual([])
  done = true
  await h.clock.advance(POLL_MS + 1000)
  await settle(() => h.prompts.length > 0)
  expect(h.prompts[0]).toContain('finished: success')
})

test('another session\'s saved watches are not inherited', async ($: any, on: any) => {
  const h = host(on, { saved: { sessionId: 'session_old', watches: [W], finished: [] }, sid: 'session_new' })
  await $.session.start({ source: 'startup', cwd: '/tmp' } as any)
  await h.clock.advance(POLL_MS + 1000)
  await settle(() => false)
  expect(h.calls()).toBe(0)
  expect(h.prompts).toEqual([])
})

test('a started run is saved with the session id, so a restart can find it', async ($: any, on: any) => {
  const h = host(on, { sid: 'session_a' })
  on('tool.call', { tool: /actions_run_trigger$/ }, () => ({ result: { content: [{ type: 'text', text: 'ok' }] } }))
  await $.tool.call({ tool: 'mcp__github__actions_run_trigger', method: 'run_workflow', owner: 'o', repo: 'r', workflow_id: 'db-test.yml', ref: 'main' })
  const saved: any = h.data.saved
  expect(saved.sessionId).toBe('session_a')
  expect(saved.watches.map((w: any) => w.workflow)).toEqual(['db-test.yml'])
})

test('restorable accepts only this session\'s well-formed list', () => {
  // A row missing its start time or its server is dropped; non-string finished keys are dropped.
  // A row missing what names the thing it watches is dropped too.
  expect(restorable({ sessionId: 's', watches: [{ ...W, owner: '' }, { ...W, repo: 7 }, { ...W, since: undefined }, { ...W, since: '' }, { ...W, workflow: '' }, { ...W, workflow: undefined, runId: 4 }, W] }, 's')!.watches.length).toBe(2)
  expect(restorable({ sessionId: 's', watches: [{ ...W, startedAt: NaN }, { ...W, server: '' }, W] }, 's')).toEqual({ watches: [W], finished: [] })
  expect(restorable({ sessionId: 's', watches: [{ server: 'x' }, { startedAt: 1 }, W], finished: [1, 'k'] }, 's')).toEqual({ watches: [W], finished: ['k'] })
  expect(restorable({ sessionId: 's', watches: [W], finished: ['k'] }, 's')).toEqual({ watches: [W], finished: ['k'] })
  expect(restorable({ sessionId: 's', watches: [W] }, 'other')).toBeUndefined()
  expect(restorable({ sessionId: '', watches: [W] }, '')).toBeUndefined()
  expect(restorable({ sessionId: 's', watches: [{ owner: 'o' }, W] }, 's')).toEqual({ watches: [W], finished: [] })
})

test('ended watches come back after a restart even when none is still open', async ($: any, on: any) => {
  const h = host(on, { saved: { sessionId: 'session_a', watches: [], finished: ['k:ended'] }, sid: 'session_a' })
  await $.session.start({ source: 'resume', cwd: '/tmp' } as any)
  const out: any = await $.tool.call({ tool: 'mcp__workflow-run-watch__watching' } as any)
  expect(JSON.parse(out.result)).toEqual({ active: [], finished: ['k:ended'] })
})

test('a save with no readable session id keeps the last good save', async ($: any, on: any) => {
  const prior = { sessionId: 'session_a', watches: [W], finished: [] }
  const h = host(on, { saved: prior, sid: '' })
  on('tool.call', { tool: /actions_run_trigger$/ }, () => ({ result: { content: [{ type: 'text', text: 'ok' }] } }))
  await $.tool.call({ tool: 'mcp__github__actions_run_trigger', method: 'run_workflow', owner: 'o', repo: 'r', workflow_id: 'db-test.yml', ref: 'main' })
  expect(h.data.saved).toEqual(prior)
})
