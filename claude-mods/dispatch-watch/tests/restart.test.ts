import { test, expect, mock } from 'claude-code/testing'

import { POLL_MS, restorable } from '../hooks/logic'

// LC-2043: watches lived only in $.state, so a restart emptied them and nothing polled again. They are now saved with
// the session's id and restored (and polled at once) on session.start.
const T0 = Date.parse('2026-10-20T18:27:54Z')
const MIN = 60_000
const NOW = T0 + 30 * MIN
const W = { workflow: 'refresh-run.yml', server: 'Supabase', projectId: 'p', since: new Date(T0 - MIN).toISOString(), startedAt: T0, reqId: 5, reqAt: NOW - 5_000 }
const DISPATCH = "SELECT net.http_post(url := 'https://x.supabase.co/functions/v1/github-dispatch?secret=' || (select 1), " +
  `body := '{"workflow":"refresh-run.yml","inputs":{"run_id":"u"}}'::jsonb)`
const wrap = (rows: unknown) => JSON.stringify({ result: `Below is the result.\n\n<untrusted-data-abc>\n${JSON.stringify(rows)}\n</untrusted-data-abc>\n\nUse this.` })
const runs = (r: Record<string, unknown>[]) => wrap([{ status_code: 200, content: JSON.stringify({ ok: true, runs: r }) }])
const run = { id: 7, status: 'completed', conclusion: 'success', html_url: 'https://gh/7', created_at: new Date(T0 + 5_000).toISOString(),
  run_started_at: new Date(T0 + 10_000).toISOString(), updated_at: new Date(T0 + 95_000).toISOString() }

function host(on: any, opts: { saved?: unknown; sid?: string; pending?: () => boolean }) {
  const data: Record<string, unknown> = opts.saved === undefined ? {} : { saved: opts.saved }
  on('store.get', ((_$: any, e: any) => ({ value: data[e.key] })) as any)
  on('store.set', ((_$: any, e: any) => { data[e.key] = e.value; return { value: undefined } }) as any)
  const clock = mock.clock(on, { now: NOW })
  const prompts: string[] = []
  let calls = 0
  on('session.id', (() => ({ value: opts.sid ?? '' })) as any)
  on('tool.register', (() => ({ value: undefined })) as any)
  on('ui.toast', (() => ({ value: undefined })) as any)
  on('prompt.submit', ((_$: any, e: any) => { prompts.push(e.text); return { text: e.text } }) as any)
  on('mcp.call', ((_$: any, e: any) => { calls++; const text = /net\.http_post/.test(e.args.query) ? wrap([{ req_id: 5 }]) : (opts.pending?.() ? wrap([]) : runs([run]))
    return { value: { isError: false, content: [{ type: 'text', text }] } } }) as any)
  on('session.start', (() => ({ cwd: '/tmp' })) as any)
  return { clock, prompts, data, calls: () => calls }
}

const settle = async (done: () => boolean) => { for (let i = 0; i < 30 && !done(); i++) await new Promise(r => setTimeout(r, 10)) }

test('a restart of the same session brings its watch back and delivers the finish at once', async ($: any, on: any) => {
  const h = host(on, { saved: { sessionId: 'session_a', watches: [W], finished: [] }, sid: 'session_a' })
  await $.session.start({ source: 'resume', cwd: '/tmp' } as any)
  await settle(() => h.prompts.length > 0)
  expect(h.prompts[0]).toContain('run 7 finished: success')
  expect(h.prompts[0]).toContain('min late')
  await settle(() => (h.data.saved as any)?.watches?.length === 0)
  expect((h.data.saved as any).watches).toEqual([])
})

test('a restored watch whose run has not finished keeps being polled on the timer', async ($: any, on: any) => {
  let pending = true
  const h = host(on, { saved: { sessionId: 'session_a', watches: [W], finished: [] }, sid: 'session_a', pending: () => pending })
  await $.session.start({ source: 'resume', cwd: '/tmp' } as any)
  await settle(() => h.calls() > 0)
  expect(h.prompts).toEqual([])
  pending = false
  // The next ticks send a fresh status request if the old one went stale, then read its reply.
  for (let i = 0; i < 3 && h.prompts.length === 0; i++) { await h.clock.advance(POLL_MS + 1000); await settle(() => h.prompts.length > 0) }
  await settle(() => h.prompts.length > 0)
  expect(h.prompts[0]).toContain('run 7 finished: success')
})

test('another session\'s saved watches are not inherited', async ($: any, on: any) => {
  const h = host(on, { saved: { sessionId: 'session_old', watches: [W], finished: [] }, sid: 'session_new' })
  await $.session.start({ source: 'startup', cwd: '/tmp' } as any)
  await h.clock.advance(POLL_MS + 1000)
  await settle(() => false)
  expect(h.calls()).toBe(0)
  expect(h.prompts).toEqual([])
})

test('a dispatch is saved with the session id, so a restart can find it', async ($: any, on: any) => {
  const h = host(on, { sid: 'session_a' })
  on('tool.call', () => ({ result: 'ok', text: wrap([{ http_post: 1 }]) }) as any)
  await $.tool.call({ tool: 'mcp__Supabase__execute_sql', project_id: 'p', query: DISPATCH })
  const saved: any = h.data.saved
  expect(saved.sessionId).toBe('session_a')
  expect(saved.watches.map((w: any) => w.workflow)).toEqual(['refresh-run.yml'])
})

test('restorable accepts only this session\'s well-formed list', () => {
  // A row missing its start time or its server is dropped; non-string finished keys are dropped.
  // A row missing what names the thing it watches is dropped too.
  expect(restorable({ sessionId: 's', watches: [{ ...W, workflow: '' }, { ...W, projectId: 3 }, { ...W, projectId: '' }, { ...W, since: undefined }, { ...W, since: '' }, W] }, 's')!.watches.length).toBe(1)
  expect(restorable({ sessionId: 's', watches: [{ ...W, startedAt: NaN }, { ...W, server: '' }, W] }, 's')).toEqual({ watches: [W], finished: [] })
  expect(restorable({ sessionId: 's', watches: [{ server: 'x' }, { startedAt: 1 }, W], finished: [1, 'k'] }, 's')).toEqual({ watches: [W], finished: ['k'] })
  expect(restorable({ sessionId: 's', watches: [W], finished: ['k'] }, 's')).toEqual({ watches: [W], finished: ['k'] })
  expect(restorable({ sessionId: 's', watches: [W] }, 'other')).toBeUndefined()
  expect(restorable({ sessionId: '', watches: [W] }, '')).toBeUndefined()
  expect(restorable({ sessionId: 's', watches: [{ workflow: 'x' }, W] }, 's')).toEqual({ watches: [W], finished: [] })
})

test('ended watches come back after a restart even when none is still open', async ($: any, on: any) => {
  const h = host(on, { saved: { sessionId: 'session_a', watches: [], finished: ['k:ended'] }, sid: 'session_a' })
  await $.session.start({ source: 'resume', cwd: '/tmp' } as any)
  const out: any = await $.tool.call({ tool: 'mcp__dispatch-watch__watching' } as any)
  expect(JSON.parse(out.result)).toEqual({ active: [], finished: ['k:ended'] })
})

test('a save with no readable session id keeps the last good save', async ($: any, on: any) => {
  const prior = { sessionId: 'session_a', watches: [W], finished: [] }
  const h = host(on, { saved: prior, sid: '' })
  on('tool.call', () => ({ result: 'ok', text: wrap([{ http_post: 1 }]) }) as any)
  await $.tool.call({ tool: 'mcp__Supabase__execute_sql', project_id: 'p', query: DISPATCH })
  expect(h.data.saved).toEqual(prior)
})
