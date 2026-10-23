import { expect, mock } from 'claude-code/testing'
import { test } from './slow'
import { childIdOf, decideStall, newestActivity, NUDGE_MARK, ESCALATE_MS, STALL_MS, ticketOf } from '../hooks/logic'

// LC-1834: a hung child sits in WORKING forever, so the transition wake never fires.
// Stall = WORKING with no new transcript event for STALL_MS -> one automatic nudge ->
// still silent ESCALATE_MS later -> wake the orchestrator.

const T0 = Date.parse('2026-10-15T12:00:00Z')
const iso = (ms: number) => new Date(ms).toISOString()

type World = {
  bucket: string
  updatedAt: number
  events: { created_at: string; user?: unknown; assistant?: unknown }[] | 'garbage'
  sendFails?: boolean
}

async function setup($: any, on: any, world: World) {
  mock.store(on)
  const clock = mock.clock(on, { now: T0 })
  const prompts: string[] = []
  const toasts: string[] = []
  const sent: any[] = []
  const calls: string[] = []
  on('ui.toast', (_$: any, e: any) => { toasts.push(e.text); return { value: undefined } as any })
  on('prompt.submit', (_$: any, e: any) => { prompts.push(e.text); return { text: e.text } as any })
  on('mcp.call', (_$: any, e: any) => {
    calls.push(e.tool)
    const reply = (text: string, isError = false) => ({ value: { isError, content: [{ type: 'text', text }] } }) as any
    if (e.tool === 'list_events') {
      return reply(world.events === 'garbage' ? 'not json at all' : JSON.stringify({ ccr: { data: world.events } }))
    }
    if (e.tool === 'send_message') {
      sent.push(e.args)
      return world.sendFails ? reply('delivery refused', true) : reply('{"ok":true}')
    }
    return reply(JSON.stringify({ ccr: {
      status_bucket: `SESSION_STATUS_BUCKET_${world.bucket}`, session_status: 'SESSION_STATUS_RUNNING',
      task_summary: 'working on it', updated_at: iso(world.updatedAt),
      external_metadata: { usage: { cost_usd: 0.1 } } } }))
  })
  await $.tool.call({ tool: 'mcp__fleet-tracker__track', session_id: 'session_s', ticket: 'LC-9', label: 'child' } as any)
  const status = async () => JSON.stringify(await $.tool.call({ tool: 'mcp__fleet-tracker__status' } as any))
  return { clock, prompts, toasts, sent, calls, status }
}

test('a healthy WORKING session costs no transcript read and is never nudged', async ($, on) => {
  const w = await setup($, on, { bucket: 'WORKING', updatedAt: T0 - 60_000, events: [] })
  await w.clock.advance(91_000)
  expect(w.calls.includes('get_session')).toBe(true)
  expect(w.calls.includes('list_events')).toBe(false)
  expect(w.sent.length).toBe(0)
})

test('a long turn with recent transcript activity is not a stall', async ($, on) => {
  const w = await setup($, on, { bucket: 'WORKING', updatedAt: T0 - 40 * 60_000, events: [{ created_at: iso(T0 - 2 * 60_000) }] })
  await w.clock.advance(91_000)
  expect(w.calls.includes('list_events')).toBe(true)
  expect(w.sent.length).toBe(0)
  expect(await w.status()).toContain('WORKING')
})

test('a stalled session is nudged once with priority next, without waking the orchestrator', async ($, on) => {
  const w = await setup($, on, { bucket: 'WORKING', updatedAt: T0 - 20 * 60_000, events: [{ created_at: iso(T0 - 20 * 60_000) }] })
  await w.status()
  await w.clock.advance(91_000)
  await w.status() // a later poll inside the window must not nudge again
  expect(w.calls.filter(c => c === 'get_session').length).toBe(3)
  expect(w.sent.length).toBe(1)
  expect(w.sent[0].session_id).toBe('session_s')
  expect(w.sent[0].priority).toBe('next')
  expect(String(w.sent[0].message)).toContain(NUDGE_MARK)
  expect(w.prompts.length).toBe(0)
  expect(await w.status()).toContain('NUDGED')
})

// Harness timing (probed 2026-10-15): the only clock-driven poll in a test is the one
// `track` queues, and it runs as soon as anything pumps the engine (the first status
// call or clock.advance). Later polls come only from the status tool, which runs them
// inside a tool call where prompt.submit is refused. So multi-step cases assert the
// escalation through the status text and the toast (both reach the operator); the wake text
// itself is asserted on the single clock poll in the failed-nudge case, which shares
// the escalation's wake path.
async function nudged($: any, on: any, world: World) {
  const w = await setup($, on, world)
  await w.status()
  expect(w.sent.length).toBe(1) // precondition: the nudge really happened
  return w
}

test('still silent after the nudge window: the orchestrator is woken with STALLED', async ($, on) => {
  const world: World = { bucket: 'WORKING', updatedAt: T0 - 20 * 60_000, events: [{ created_at: iso(T0 - 20 * 60_000) }] }
  const w = await nudged($, on, world)
  // The nudge's own delivery is a user event; it must not count as the session waking.
  world.events = [{ created_at: iso(T0 - 20 * 60_000) }, { created_at: iso(T0 + 1000), user: { text: `${NUDGE_MARK}: ...` } }]
  await w.clock.advance(ESCALATE_MS + 1000)
  expect(await w.status()).toContain('STALLED')
  expect(w.toasts.join(' ')).toContain('LC-9 stalled')
  expect(w.sent.length).toBe(1) // escalation never re-nudges
  const toastsBefore = w.toasts.length
  await w.status() // already escalated: no second toast
  expect(w.toasts.length).toBe(toastsBefore)
})

test('inside the nudge window nothing escalates', async ($, on) => {
  const world: World = { bucket: 'WORKING', updatedAt: T0 - 20 * 60_000, events: [{ created_at: iso(T0 - 20 * 60_000) }] }
  const w = await nudged($, on, world)
  await w.clock.advance(ESCALATE_MS - 60_000)
  const st = await w.status()
  expect(st).toContain('NUDGED')
  expect(st).not.toContain('STALLED')
  expect(w.sent.length).toBe(1)
})

test('activity after the nudge clears the stall; no escalation', async ($, on) => {
  const world: World = { bucket: 'WORKING', updatedAt: T0 - 20 * 60_000, events: [{ created_at: iso(T0 - 20 * 60_000) }] }
  const w = await nudged($, on, world)
  world.events = [{ created_at: iso(T0 + ESCALATE_MS), assistant: { text: 'continuing' } }]
  await w.clock.advance(ESCALATE_MS + 1000)
  const st = await w.status()
  expect(w.calls.filter(c => c === 'list_events').length).toBeGreaterThan(1) // it really re-read the transcript
  expect(st).not.toContain('NUDGED')
  expect(st).not.toContain('STALLED')
})

test('a nudged session that goes BLOCKED clears the stall and flags the operator', async ($, on) => {
  const world: World = { bucket: 'WORKING', updatedAt: T0 - 20 * 60_000, events: [{ created_at: iso(T0 - 20 * 60_000) }] }
  const w = await nudged($, on, world)
  world.bucket = 'BLOCKED'
  await w.clock.advance(91_000)
  const st = await w.status()
  expect(st).toContain('BLOCKED')
  expect(st).not.toContain('NUDGED')
  expect(w.toasts.join(' ')).toContain('LC-9 needs you')
})

test('a failed nudge wakes the orchestrator immediately', async ($, on) => {
  const w = await setup($, on, { bucket: 'WORKING', updatedAt: T0 - 20 * 60_000, events: [{ created_at: iso(T0 - 20 * 60_000) }], sendFails: true })
  await w.clock.advance(91_000)
  expect(w.sent.length).toBe(1)
  expect(w.prompts.filter(p => p.includes('STALLED') && p.includes('nudge failed')).length).toBe(1)
  expect(w.toasts.join(' ')).toContain('nudge failed')
  expect(await w.status()).toContain('STALLED')
})

test('an unreadable transcript is never treated as a stall', async ($, on) => {
  const w = await setup($, on, { bucket: 'WORKING', updatedAt: T0 - 20 * 60_000, events: 'garbage' })
  await w.clock.advance(91_000)
  expect(w.calls.includes('list_events')).toBe(true)
  expect(w.sent.length).toBe(0)
})

test('create_session results are auto-tracked with the ticket from the title', async ($, on) => {
  mock.store(on)
  mock.clock(on, { now: T0 })
  on('mcp.call', () => ({ value: { isError: false, content: [{ type: 'text', text: JSON.stringify({ ccr: {
    status_bucket: 'SESSION_STATUS_BUCKET_WORKING', updated_at: iso(T0) } }) }] } }) as any)
  on('tool.call', { tool: 'mcp__claude-code-remote__create_session' }, () =>
    ({ result: 'created', text: '{"session_id":"session_01AutoChildAbcdefghij","status":"idle"}' }) as any)
  const res: any = await $.tool.call({ tool: 'mcp__claude-code-remote__create_session', title: 'LC-777 build the thing', prompt: 'go' } as any)
  expect(JSON.stringify(res)).toContain('session_01AutoChildAbcdefghij') // the orchestrator still gets its result
  const status = JSON.stringify(await $.tool.call({ tool: 'mcp__fleet-tracker__status' } as any))
  expect(status).toContain('LC-777')
  expect(status).toContain('build the thing')
  // The row is keyed by the child's id, not the JSON key `session_id`: untracking by id removes it.
  await $.tool.call({ tool: 'mcp__fleet-tracker__untrack', session_id: 'session_01AutoChildAbcdefghij', keep_reason: 'test' } as any)
  expect(JSON.stringify(await $.tool.call({ tool: 'mcp__fleet-tracker__status' } as any))).not.toContain('LC-777')
})

test('childIdOf never returns the JSON key, the caller, or a guess', () => {
  const own = 'session_01ParentParentParent0'
  const kid = 'session_01ChildChildChild00'
  expect(childIdOf(`{"session_id":"${kid}"}`, own)).toBe(kid)
  expect(childIdOf(`{"ccr":{"parent_session":"${own}","id":"${kid}"}}`, own)).toBe(kid)
  expect(childIdOf(`Created ${kid} (from ${own})`, own)).toBe(kid)
  expect(childIdOf(`{"session_id":"${own}"}`, own)).toBe(null)
  expect(childIdOf('session_id: unknown', own)).toBe(null)
  expect(childIdOf('{"id":"session_abc"}', own)).toBe(null) // real ids are 24+ chars; a short token is not one
  expect(childIdOf(`${kid} and session_01OtherOtherOther00`, own)).toBe(null) // ambiguous: no guess
})

test('a nudge that bumps updated_at does not clear the stall', async ($, on) => {
  const world: World = { bucket: 'WORKING', updatedAt: T0 - 20 * 60_000, events: [{ created_at: iso(T0 - 20 * 60_000) }] }
  const w = await nudged($, on, world)
  world.updatedAt = T0 + 1000 // the server stamps our nudge's delivery
  world.events = [{ created_at: iso(T0 - 20 * 60_000) }, { created_at: iso(T0 + 1000), user: { text: `${NUDGE_MARK}: ...` } }]
  await w.clock.advance(ESCALATE_MS + 1000)
  expect(await w.status()).toContain('STALLED')
  expect(w.sent.length).toBe(1)
})

test('an unreadable transcript after a nudge still escalates once the window passes', async ($, on) => {
  const world: World = { bucket: 'WORKING', updatedAt: T0 - 20 * 60_000, events: [{ created_at: iso(T0 - 20 * 60_000) }] }
  const w = await nudged($, on, world)
  world.events = 'garbage'
  await w.clock.advance(ESCALATE_MS + 1000)
  expect(await w.status()).toContain('STALLED')
})

test('a one-off UNKNOWN poll does not reset a nudge', async ($, on) => {
  const world: World = { bucket: 'WORKING', updatedAt: T0 - 20 * 60_000, events: [{ created_at: iso(T0 - 20 * 60_000) }] }
  const w = await nudged($, on, world)
  world.bucket = 'UNKNOWN'
  await w.status()
  world.bucket = 'WORKING'
  await w.clock.advance(STALL_MS)
  await w.status()
  expect(w.sent.length).toBe(1) // not re-nudged
})

test('untrack while a poll is in flight is not undone by that poll', async ($, on) => {
  const world: World = { bucket: 'WORKING', updatedAt: T0 - 60_000, events: [] }
  const w = await setup($, on, world)
  const polling = w.status()
  await $.tool.call({ tool: 'mcp__fleet-tracker__untrack', session_id: 'session_s', keep_reason: 'test' } as any)
  await polling
  await w.clock.advance(91_000)
  expect(await w.status()).not.toContain('LC-9')
})

test('a note set while a poll is in flight survives that poll', async ($, on) => {
  const world: World = { bucket: 'WORKING', updatedAt: T0 - 60_000, events: [] }
  const w = await setup($, on, world)
  const polling = w.status()
  await $.tool.call({ tool: 'mcp__fleet-tracker__note', session_id: 'session_s', note: 'merge approval', needs_you: true } as any)
  await polling
  await w.clock.advance(91_000)
  const st = await w.status()
  expect(st).toContain('merge approval')
  expect(st).toContain('!!')
})

test('decideStall: only WORKING stalls, unknown activity never acts, flags clear on recovery', () => {
  const old = T0 - STALL_MS - 1
  expect(decideStall('WORKING', old, T0, 0, false)).toBe('nudge')
  expect(decideStall('WORKING', null, T0, 0, false)).toBe('none')
  expect(decideStall('WORKING', T0 - 1000, T0, 0, false)).toBe('none')
  expect(decideStall('WORKING', T0 - 1000, T0, T0 - 5000, false)).toBe('clear')
  expect(decideStall('BLOCKED', old, T0, T0 - 5000, false)).toBe('clear')
  expect(decideStall('BLOCKED', old, T0, 0, false)).toBe('none')
  expect(decideStall('UNKNOWN', old, T0, T0 - 5000, false)).toBe('none')
  expect(decideStall('WORKING', null, T0, T0 - ESCALATE_MS, false)).toBe('escalate')
  expect(decideStall('WORKING', null, T0, T0 - ESCALATE_MS + 1, false)).toBe('none')
  expect(decideStall('WORKING', old, T0, T0 - ESCALATE_MS, false)).toBe('escalate')
  expect(decideStall('WORKING', old, T0, T0 - ESCALATE_MS + 1, false)).toBe('none')
  expect(decideStall('WORKING', old, T0, T0 - ESCALATE_MS, true)).toBe('none')
})

test('newestActivity: newest event wins, delivered nudge skipped, a reply quoting it counts', () => {
  const txt = (data: unknown) => `<other-session>${JSON.stringify({ ccr: { data } })}</other-session>`
  expect(newestActivity(txt([{ created_at: iso(T0 - 5000) }, { created_at: iso(T0 - 1000) }]))).toBe(T0 - 1000)
  expect(newestActivity(txt([{ created_at: iso(T0 - 5000) }, { created_at: iso(T0), user: { m: NUDGE_MARK } }]))).toBe(T0 - 5000)
  expect(newestActivity(txt([{ created_at: iso(T0), assistant: { m: NUDGE_MARK } }]))).toBe(T0)
  expect(newestActivity('nope')).toBe(null)
  expect(newestActivity(txt([]))).toBe(null)
})

test('ticketOf finds a Jira key in the title, then the prompt', () => {
  expect(ticketOf('LC-1834 fleet', 'x')).toBe('LC-1834')
  expect(ticketOf('no key', 'Work on LCH-12 now')).toBe('LCH-12')
  expect(ticketOf(undefined, '')).toBe('untagged')
})

test('a wake raised inside a tool call is queued and delivered when the turn ends', async ($, on) => {
  on('turn.complete', () => ({ text: 'done' }) as any)
  const world: World = { bucket: 'WORKING', updatedAt: T0, events: [], sendFails: true }
  const w = await setup($, on, world)
  await w.clock.advance(91_000) // the one clock poll runs while the session is healthy
  // Now it stalls and the next poll is a status call: the failed nudge escalates
  // inside a tool call, where the host refuses the submit.
  world.updatedAt = T0 - 20 * 60_000
  world.events = [{ created_at: iso(T0 - 20 * 60_000) }]
  await w.status()
  expect(w.sent.length).toBe(1)
  expect(w.prompts.length).toBe(0) // refused, not delivered
  await ($ as any).turn.complete({ reason: 'answer', answer: 'done' })
  await w.clock.advance(1)
  const wakes = w.prompts.filter(p => p.includes('nudge failed'))
  expect(wakes.length).toBe(1) // delivered at turn end: never lost
  await ($ as any).turn.complete({ reason: 'answer', answer: 'done' })
  await w.clock.advance(1)
  expect(w.prompts.filter(p => p.includes('nudge failed')).length).toBe(1) // never doubled
})
