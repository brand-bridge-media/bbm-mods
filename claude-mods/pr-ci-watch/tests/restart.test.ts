import { test, expect, mock } from 'claude-code/testing'

import { POLL_MS, restorable } from '../hooks/logic'

// LC-2043: on 2026-11-05 the watch list was found empty twice after a restart and six merges went unannounced.
// The list is now saved with the session's id and restored (and polled at once) on session.start.
const T0 = Date.parse('2026-11-05T19:46:00Z')
const MIN = 60_000
const W = { owner: 'acme', repo: 'infra', number: 7, server: 'github', sha: 'abc1234', startedAt: T0 - 90 * MIN, armed: true }
const MERGED = JSON.stringify({ state: 'closed', merged: true, merged_at: '2026-11-05T19:46:00Z', head: { sha: 'abc1234' }, labels: [] })

function host(on: any, opts: { saved?: unknown; sid?: string; idThrows?: boolean; reply?: (method: string) => string }) {
  // A hand-rolled store so a test can read what the mod saved.
  const data: Record<string, unknown> = opts.saved === undefined ? {} : { saved: opts.saved }
  on('store.get', ((_$: any, e: any) => ({ value: data[e.key] })) as any)
  on('store.set', ((_$: any, e: any) => { data[e.key] = e.value; return { value: undefined } }) as any)
  const clock = mock.clock(on, { now: T0 + 100 * MIN })
  const prompts: string[] = []
  const calls: string[] = []
  on('session.id', (() => { if (opts.idThrows) throw new Error('no id'); return { value: opts.sid ?? '' } }) as any)
  on('tool.register', (() => ({ value: undefined })) as any)
  on('ui.toast', (() => ({ value: undefined })) as any)
  on('prompt.submit', ((_$: any, e: any) => { prompts.push(e.text); return { text: e.text } }) as any)
  on('mcp.call', ((_$: any, e: any) => { calls.push(String(e.args?.method ?? e.tool)); return { value: { isError: false, content: [{ type: 'text', text: opts.reply ? opts.reply(String(e.args?.method)) : MERGED }] } } }) as any)
  on('session.start', (() => ({ cwd: '/tmp' })) as any)
  return { clock, prompts, calls, data }
}

const settle = async (done: () => boolean) => { for (let i = 0; i < 30 && !done(); i++) await new Promise(r => setTimeout(r, 10)) }

test('a restart of the same session brings its watches back and polls them at once', async ($: any, on: any) => {
  const h = host(on, { saved: { sessionId: 'session_a', watches: [W], finished: [] }, sid: 'session_a' })
  await $.session.start({ source: 'resume', cwd: '/tmp' } as any)
  await settle(() => h.prompts.length > 0)
  expect(h.prompts[0]).toContain('acme/infra#7')
  expect(h.prompts[0]).toContain('merged')
  // Delivered with the merge's real time, not as if it just happened.
  expect(h.prompts[0]).toContain('delivered 100 min late')
  // The finished watch is dropped from the saved list too, so the next restart does not bring it back.
  await settle(() => (h.data.saved as any)?.watches?.length === 0)
  expect((h.data.saved as any).watches).toEqual([])
})

test('the restored watch keeps being polled on the timer', async ($: any, on: any) => {
  const open = JSON.stringify({ state: 'open', merged: false, head: { sha: 'abc1234' }, labels: [] })
  const h = host(on, { saved: { sessionId: 'session_a', watches: [W], finished: [] }, sid: 'session_a', reply: m => (m === 'get' ? open : '[]') })
  await $.session.start({ source: 'resume', cwd: '/tmp' } as any)
  await settle(() => h.calls.length > 0)
  const first = h.calls.length
  await h.clock.advance(POLL_MS + 1000)
  await settle(() => h.calls.length > first)
  expect(h.calls.length).toBeGreaterThan(first)
})

test('another session\'s saved watches are not inherited', async ($: any, on: any) => {
  const h = host(on, { saved: { sessionId: 'session_old', watches: [W], finished: [] }, sid: 'session_new' })
  await $.session.start({ source: 'startup', cwd: '/tmp' } as any)
  await h.clock.advance(POLL_MS + 1000)
  await settle(() => false)
  expect(h.calls).toEqual([])
  expect(h.prompts).toEqual([])
})

test('an unreadable session id restores nothing', async ($: any, on: any) => {
  const h = host(on, { saved: { sessionId: '', watches: [W], finished: [] }, idThrows: true })
  await $.session.start({ source: 'resume', cwd: '/tmp' } as any)
  await h.clock.advance(POLL_MS + 1000)
  await settle(() => false)
  expect(h.calls).toEqual([])
})

test('a new watch is saved with the session id, so a restart can find it', async ($: any, on: any) => {
  const h = host(on, { sid: 'session_a' })
  on('tool.call', (() => ({ result: 'ok', text: '{"number":9,"url":"https://github.com/acme/infra/pull/9"}' })) as any)
  await $.tool.call({ tool: 'mcp__github__create_pull_request', owner: 'acme', repo: 'infra', title: 't', head: 'h', base: 'main' })
  const saved: any = h.data.saved
  expect(saved.sessionId).toBe('session_a')
  expect(saved.watches.map((w: any) => w.number)).toEqual([9])
})

test('restorable accepts only this session\'s well-formed list', () => {
  // A row missing its start time or its server is dropped; non-string finished keys are dropped.
  // A row missing what names the thing it watches is dropped too. An empty sha is kept: watch_pr starts one that way.
  expect(restorable({ sessionId: 's', watches: [{ ...W, sha: '' }] }, 's')!.watches).toEqual([{ ...W, sha: '' }])
  expect(restorable({ sessionId: 's', watches: [{ ...W, owner: '' }, { ...W, repo: 7 }, { ...W, number: 'x' }, { ...W, sha: undefined }, W] }, 's')!.watches.length).toBe(1)
  expect(restorable({ sessionId: 's', watches: [{ ...W, startedAt: NaN }, { ...W, server: '' }, W] }, 's')).toEqual({ watches: [W], finished: [] })
  expect(restorable({ sessionId: 's', watches: [{ server: 'x' }, { startedAt: 1 }, W], finished: [1, 'k'] }, 's')).toEqual({ watches: [W], finished: ['k'] })
  expect(restorable({ sessionId: 's', watches: [W], finished: ['pr:acme/infra#1'] }, 's')).toEqual({ watches: [W], finished: ['pr:acme/infra#1'] })
  expect(restorable({ sessionId: 's', watches: [W] }, 's')).toEqual({ watches: [W], finished: [] })
  expect(restorable({ sessionId: 's', watches: [W] }, 'other')).toBeUndefined()
  expect(restorable({ sessionId: '', watches: [W] }, '')).toBeUndefined()
  expect(restorable({ sessionId: 's', watches: 'x' }, 's')).toBeUndefined()
  expect(restorable(null, 's')).toBeUndefined()
  expect(restorable({ sessionId: 's', watches: [{ owner: 'a' }, null, W], finished: [1, 'k'] }, 's')).toEqual({ watches: [W], finished: ['k'] })
})

for (const [name, call] of [
  ['enable_pr_auto_merge', { tool: 'mcp__github__enable_pr_auto_merge', owner: 'acme', repo: 'infra', pullNumber: 9 }],
  ['the queue label', { tool: 'mcp__github__issue_write', method: 'update', owner: 'acme', repo: 'infra', issue_number: 9, labels: ['queue'] }],
] as const) {
  test(`arming an already watched PR through ${name} is saved, so a restart keeps watching until it merges`, async ($: any, on: any) => {
    const h = host(on, { sid: 'session_a' })
    on('tool.call', (() => ({ result: 'ok', text: '{"number":9,"url":"https://github.com/acme/infra/pull/9"}' })) as any)
    await $.tool.call({ tool: 'mcp__github__create_pull_request', owner: 'acme', repo: 'infra', title: 't', head: 'h', base: 'main' })
    expect((h.data.saved as any).watches[0].armed).toBeUndefined()
    await $.tool.call(call as any)
    expect((h.data.saved as any).watches[0].armed).toBe(true)
  })
}

test('ended watches come back after a restart even when none is still open', async ($: any, on: any) => {
  const h = host(on, { saved: { sessionId: 'session_a', watches: [], finished: ['k:ended'] }, sid: 'session_a' })
  await $.session.start({ source: 'resume', cwd: '/tmp' } as any)
  const out: any = await $.tool.call({ tool: 'mcp__pr-ci-watch__watching' } as any)
  expect(JSON.parse(out.result)).toEqual({ active: [], finished: ['k:ended'] })
})

test('a save with no readable session id keeps the last good save', async ($: any, on: any) => {
  const prior = { sessionId: 'session_a', watches: [W], finished: [] }
  const h = host(on, { saved: prior, sid: '' })
  on('tool.call', (() => ({ result: 'ok', text: '{"number":9,"url":"https://github.com/acme/infra/pull/9"}' })) as any)
  await $.tool.call({ tool: 'mcp__github__create_pull_request', owner: 'acme', repo: 'infra', title: 't', head: 'h', base: 'main' })
  expect(h.data.saved).toEqual(prior)
})
