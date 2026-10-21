import { test, expect, mock } from 'claude-code/testing'
import { childIdOf, closeoutLine, decideCloseout, CLOSEOUT_MS } from '../hooks/logic'

// LC-1835: Claude closes out every child session it spins up (the operator, 2026-10-15).
//  - untrack ARCHIVES, refuses a live session, keeps the row when archiving fails,
//    and only skips the archive with an explicit keep_reason;
//  - a row idle in COMPLETED / REVIEW_READY for 60 min gets ONE reminder per bucket episode;
//  - open_children lists the rows not yet closed out (session-close reads it).
// Harness timing: see the note above the multi-step tests in stall.test.ts. Later polls run
// inside a status call, where prompt.submit is refused, so wakes are asserted after a
// turn.complete flush.

const T0 = Date.parse('2026-10-15T12:00:00Z')
const MIN = 60_000
const iso = (ms: number) => new Date(ms).toISOString()

type World = { bucket: string; needInput?: boolean; archiveFails?: boolean; archiveText?: string; getFails?: boolean; sessionStatus?: string }

async function setup($: any, on: any, world: World) {
  mock.store(on)
  const clock = mock.clock(on, { now: T0 })
  on('turn.complete', () => ({ text: 'done' }) as any)
  const prompts: string[] = []
  const toasts: string[] = []
  const archived: any[] = []
  on('ui.toast', (_$: any, e: any) => { toasts.push(e.text); return { value: undefined } as any })
  on('prompt.submit', (_$: any, e: any) => { prompts.push(e.text); return { text: e.text } as any })
  on('mcp.call', (_$: any, e: any) => {
    const reply = (text: string, isError = false) => ({ value: { isError, content: [{ type: 'text', text }] } }) as any
    if (e.tool === 'archive_session') {
      archived.push(e.args)
      return world.archiveFails ? reply(world.archiveText ?? 'session is busy: cannot archive', true) : reply('{"ok":true}')
    }
    if (e.tool === 'get_session' && world.getFails) return reply('upstream timeout', true)
    return reply(JSON.stringify({ ccr: {
      status_bucket: `SESSION_STATUS_BUCKET_${world.bucket}`, session_status: world.sessionStatus ?? 'SESSION_STATUS_IDLE',
      task_summary: 'did the work', updated_at: iso(T0),
      ...(world.needInput ? { post_turn_summary: { status_category: 'need_input' } } : {}),
      external_metadata: { usage: { cost_usd: 0.1 } } } }))
  })
  await $.tool.call({ tool: 'mcp__fleet-tracker__track', session_id: 'session_s', ticket: 'LC-9', label: 'child' } as any)
  const status = async () => JSON.stringify(await $.tool.call({ tool: 'mcp__fleet-tracker__status' } as any))
  const untrack = async (extra: Record<string, unknown> = {}) =>
    JSON.stringify(await $.tool.call({ tool: 'mcp__fleet-tracker__untrack', session_id: 'session_s', ...extra } as any))
  const open = async () => JSON.stringify(await $.tool.call({ tool: 'mcp__fleet-tracker__open_children' } as any))
  // End the orchestrator's turn so wakes queued inside tool calls are delivered.
  const endTurn = async () => {
    await ($ as any).turn.complete({ reason: 'answer', answer: 'done' })
    await clock.advance(1)
  }
  const idle = () => prompts.filter(p => p.includes('idle in'))
  return { clock, prompts, toasts, archived, status, untrack, open, endTurn, idle }
}

// ---- untrack archives ----

test('untrack on a COMPLETED session archives it and removes the row', async ($, on) => {
  const w = await setup($, on, { bucket: 'COMPLETED' })
  const out = await w.untrack()
  expect(out).toContain('[mod:fleet-tracker] Archived and untracked session_s')
  expect(w.archived).toEqual([{ session_id: 'session_s' }])
  expect(w.toasts.join(' ')).toContain('Archived and untracked')
  expect(await w.status()).toContain('No sessions tracked')
})

test('untrack archives a REVIEW_READY session too', async ($, on) => {
  const w = await setup($, on, { bucket: 'REVIEW_READY' })
  await w.untrack()
  expect(w.archived.length).toBe(1)
  expect(await w.status()).toContain('No sessions tracked')
})

test('untrack on a WORKING session is refused: no archive, row kept', async ($, on) => {
  const w = await setup($, on, { bucket: 'WORKING' })
  const out = await w.untrack()
  expect(out).toContain('[mod:fleet-tracker] Refused')
  expect(out).toContain('WORKING')
  expect(w.archived.length).toBe(0)
  expect(w.toasts.join(' ')).toContain('Refused')
  expect(await w.status()).toContain('LC-9')
})

test('untrack on a NEEDS_INPUT session is refused: no archive, row kept', async ($, on) => {
  const w = await setup($, on, { bucket: 'COMPLETED', needInput: true })
  const out = await w.untrack()
  expect(out).toContain('[mod:fleet-tracker] Refused')
  expect(out).toContain('NEEDS_INPUT')
  expect(w.archived.length).toBe(0)
  expect(await w.status()).toContain('LC-9')
})

test('an archive error keeps the row, keeps a person\'s note, and returns the error', async ($, on) => {
  const w = await setup($, on, { bucket: 'COMPLETED', archiveFails: true })
  await $.tool.call({ tool: 'mcp__fleet-tracker__note', session_id: 'session_s', note: 'The operator: check the diff', needs_you: true } as any)
  const out = await w.untrack()
  expect(out).toContain('[mod:fleet-tracker]')
  expect(out).toContain('session is busy: cannot archive')
  expect(w.archived.length).toBe(1)
  const st = await w.status()
  expect(st).toContain('LC-9')
  expect(st).toContain('The operator: check the diff') // the failure went to `error`, not over the note
  expect(w.toasts.join(' ')).toContain('Archive of session_s failed')
})

test('a failed archive drops the row only when the session itself reads ARCHIVED', async ($, on) => {
  const world: World = { bucket: 'COMPLETED', archiveFails: true, archiveText: 'transient error' }
  const w = await setup($, on, world)
  await w.status()
  world.sessionStatus = 'SESSION_STATUS_ARCHIVED' // archived meanwhile by someone else
  const out = await w.untrack()
  expect(out).toContain('is archived')
  expect(await w.status()).toContain('No sessions tracked')
})

for (const text of ['session is not already archived', 'cannot verify already archived state', 'archived state machine error']) {
  test(`error text "${text}" is NOT read as archived: row kept`, async ($, on) => {
    const w = await setup($, on, { bucket: 'COMPLETED', archiveFails: true, archiveText: text })
    const out = await w.untrack()
    expect(out).toContain('failed, row kept')
    expect(await w.status()).toContain('LC-9')
  })
}

// Archive is an allowlist: only a fresh, error-free COMPLETED / REVIEW_READY row (review of LC-1835).
for (const bucket of ['BLOCKED', 'FAILED', 'UNKNOWN']) {
  test(`untrack on a ${bucket} session is refused: no archive, row kept`, async ($, on) => {
    const w = await setup($, on, { bucket })
    const out = await w.untrack()
    expect(out).toContain('[mod:fleet-tracker] Refused')
    expect(w.archived.length).toBe(0)
    expect(await w.status()).toContain('LC-9')
  })
}

test('untrack refuses when the fresh poll fails, even if the row last read COMPLETED', async ($, on) => {
  const world: World = { bucket: 'COMPLETED' }
  const w = await setup($, on, world)
  await w.status() // row now reads COMPLETED
  world.bucket = 'WORKING' // the child was resumed...
  world.getFails = true // ...and the poll that would show it fails
  const out = await w.untrack()
  expect(out).toContain('[mod:fleet-tracker] Refused')
  expect(out).toContain('could not read')
  expect(w.archived.length).toBe(0)
})

test('keep_reason removes the row without archiving and records the reason', async ($, on) => {
  const w = await setup($, on, { bucket: 'COMPLETED' })
  const out = await w.untrack({ keep_reason: 'The operator wants to read the transcript' })
  expect(out).toContain('[mod:fleet-tracker] Untracked session_s WITHOUT archiving')
  expect(out).toContain('The operator wants to read the transcript')
  expect(w.archived.length).toBe(0)
  expect(await w.status()).toContain('No sessions tracked')
})

test('keep_reason also works on a live session (nothing is archived, so nothing is lost)', async ($, on) => {
  const w = await setup($, on, { bucket: 'WORKING' })
  const out = await w.untrack({ keep_reason: 'handed to the operator' })
  expect(out).toContain('handed to the operator')
  expect(w.archived.length).toBe(0)
  expect(await w.status()).toContain('No sessions tracked')
})

test('a blank keep_reason is not a reason: the session is archived', async ($, on) => {
  const w = await setup($, on, { bucket: 'COMPLETED' })
  await w.untrack({ keep_reason: '   ' })
  expect(w.archived.length).toBe(1)
})

test('untrack on a session that is not tracked archives nothing', async ($, on) => {
  const w = await setup($, on, { bucket: 'COMPLETED' })
  const out = JSON.stringify(await $.tool.call({ tool: 'mcp__fleet-tracker__untrack', session_id: 'session_other' } as any))
  expect(out).toContain('[mod:fleet-tracker] Not tracked: session_other')
  expect(w.archived.length).toBe(0)
})

// ---- close-out reminder ----

test('a row idle in COMPLETED gets ONE reminder at 60 min, none before', async ($, on) => {
  const w = await setup($, on, { bucket: 'COMPLETED' })
  await w.status() // first poll: the clock starts in COMPLETED at T0
  await w.endTurn() // delivers the entry wake
  expect(w.idle().length).toBe(0)
  await w.clock.advance(59 * MIN)
  await w.status()
  await w.endTurn()
  expect(w.idle().length).toBe(0) // 59 min: too early
  await w.clock.advance(2 * MIN)
  await w.status()
  await w.endTurn()
  const lines = w.idle()
  expect(lines.length).toBe(1)
  expect(lines[0]).toContain('LC-9 (child) idle in COMPLETED for 61m: close it out')
  expect(lines[0]).toContain('untrack (archives) or untrack with keep_reason')
  expect(lines[0]).toContain('[mod:fleet-tracker]')
  // Later polls in the same episode stay quiet.
  await w.clock.advance(30 * MIN)
  await w.status()
  await w.endTurn()
  await w.status()
  await w.endTurn()
  expect(w.idle().length).toBe(1)
})

test('REVIEW_READY gets the reminder as well', async ($, on) => {
  const w = await setup($, on, { bucket: 'REVIEW_READY' })
  await w.status()
  await w.clock.advance(61 * MIN)
  await w.status()
  await w.endTurn()
  expect(w.idle().length).toBe(1)
  expect(w.idle()[0]).toContain('idle in REVIEW_READY')
})

test('the reminder resets when the bucket changes and fires again for the next episode', async ($, on) => {
  const world: World = { bucket: 'COMPLETED' }
  const w = await setup($, on, world)
  await w.status()
  await w.clock.advance(61 * MIN)
  await w.status()
  await w.endTurn()
  expect(w.idle().length).toBe(1)
  // The child is picked up again, then finishes again: a new episode with a fresh 60-min clock.
  world.bucket = 'WORKING'
  await w.clock.advance(MIN)
  await w.status()
  world.bucket = 'COMPLETED'
  await w.clock.advance(MIN)
  await w.status()
  await w.endTurn()
  expect(w.idle().length).toBe(1) // 0 min into the new episode: not yet
  await w.clock.advance(59 * MIN)
  await w.status()
  await w.endTurn()
  expect(w.idle().length).toBe(1) // 59 min into it
  await w.clock.advance(2 * MIN)
  await w.status()
  await w.endTurn()
  expect(w.idle().length).toBe(2)
  expect(w.idle()[1]).toContain('idle in COMPLETED for 6') // 60-61 min, not the old episode's age
})

test('moving between COMPLETED and REVIEW_READY restarts the clock', async ($, on) => {
  const world: World = { bucket: 'COMPLETED' }
  const w = await setup($, on, world)
  await w.status()
  await w.clock.advance(50 * MIN)
  world.bucket = 'REVIEW_READY'
  await w.status()
  await w.clock.advance(50 * MIN)
  await w.status()
  await w.endTurn()
  expect(w.idle().length).toBe(0) // 100 min in COMPLETED + REVIEW_READY, but only 50 in the current bucket
})

test('buckets that are not finished never get a close-out reminder', async ($, on) => {
  const w = await setup($, on, { bucket: 'BLOCKED' })
  await w.status()
  await w.clock.advance(120 * MIN)
  await w.status()
  await w.endTurn()
  expect(w.idle().length).toBe(0)
})

test('decideCloseout: exact boundary, once only, finished buckets only', () => {
  expect(decideCloseout('COMPLETED', T0, T0 + CLOSEOUT_MS - 1, false)).toBe(false)
  expect(decideCloseout('COMPLETED', T0, T0 + CLOSEOUT_MS, false)).toBe(true)
  expect(decideCloseout('REVIEW_READY', T0, T0 + CLOSEOUT_MS, false)).toBe(true)
  expect(decideCloseout('COMPLETED', T0, T0 + CLOSEOUT_MS, true)).toBe(false)
  expect(decideCloseout('WORKING', T0, T0 + 5 * CLOSEOUT_MS, false)).toBe(false)
  expect(decideCloseout('BLOCKED', T0, T0 + 5 * CLOSEOUT_MS, false)).toBe(false)
  expect(decideCloseout('COMPLETED', 0, T0 + 5 * CLOSEOUT_MS, false)).toBe(false) // unknown entry time never fires
})

test('closeoutLine names the ticket, label, bucket and minutes', () => {
  expect(closeoutLine('LC-9', 'child', 'COMPLETED', T0, T0 + 61 * MIN + 30_000)).toBe(
    'LC-9 (child) idle in COMPLETED for 61m: close it out — untrack (archives) or untrack with keep_reason',
  )
})

// ---- open_children ----

test('open_children lists the rows not yet closed out, and shrinks as they are closed', async ($, on) => {
  const w = await setup($, on, { bucket: 'COMPLETED' })
  await w.status()
  const out: any = await $.tool.call({ tool: 'mcp__fleet-tracker__open_children' } as any)
  const text = String(out.text ?? out.result ?? '')
  expect(text.startsWith('Open fleet children: 1')).toBe(true) // read-only: no mod prefix
  expect(text).toContain('- LC-9 (child) COMPLETED session_s')
  await w.untrack()
  expect(await w.open()).toContain('Open fleet children: 0')
  expect(await w.open()).not.toContain('LC-9')
})

test('open_children keeps a row whose archive failed', async ($, on) => {
  const w = await setup($, on, { bucket: 'COMPLETED', archiveFails: true })
  await w.untrack()
  expect(await w.open()).toContain('Open fleet children: 1')
})

// ---- PR #1808 review fixes ----

const OWN = 'session_01ParentParentParent0'
const KID = 'session_01ChildChildChild00'
const KID2 = 'session_01OtherOtherOther00'

test('childIdOf: two different ids in the structured fields are ambiguous, not first-wins', () => {
  expect(childIdOf(`{"id":"${KID}","session_id":"${KID2}"}`, OWN)).toBe(null)
  expect(childIdOf(`{"session_id":"${KID}","ccr":{"id":"${KID2}"}}`, OWN)).toBe(null)
  // The same id in several fields is still one id.
  expect(childIdOf(`{"id":"${KID}","session_id":"${KID}","session":{"id":"${KID}"}}`, OWN)).toBe(KID)
  // The caller's own id in a structured field does not make the result ambiguous.
  expect(childIdOf(`{"id":"${KID}","parent":"${OWN}"}`, OWN)).toBe(KID)
})

test('childIdOf: no valid structured id falls through to a one-candidate text scan', () => {
  expect(childIdOf(`{"id":"session_short","note":"made ${KID}"}`, OWN)).toBe(KID)
  expect(childIdOf(`{"id":"session_short","note":"made ${KID} and ${KID2}"}`, OWN)).toBe(null)
})

test('childIdOf with an unknown own id demands exactly one candidate overall', () => {
  expect(childIdOf(`{"session_id":"${KID}"}`, '')).toBe(KID)
  expect(childIdOf(`Created ${KID}`, '')).toBe(KID)
  expect(childIdOf(`{"session_id":"${KID}","parent_session_id":"${OWN}"}`, '')).toBe(null)
  expect(childIdOf(`{"id":"${KID}"} and ${KID2}`, '')).toBe(null)
})

function createSession(on: any, world: { ownCalls: number; ownFailures: number; text: string }) {
  mock.store(on)
  mock.clock(on, { now: T0 })
  on('mcp.call', (_$: any, e: any) => {
    const reply = (text: string, isError = false) => ({ value: { isError, content: [{ type: 'text', text }] } }) as any
    if (e.tool === 'get_session' && !e.args?.session_id) {
      return world.ownCalls++ < world.ownFailures ? reply('upstream hiccup', true) : reply(JSON.stringify({ ccr: { id: OWN } }))
    }
    return reply(JSON.stringify({ ccr: { status_bucket: 'SESSION_STATUS_BUCKET_WORKING', updated_at: iso(T0) } }))
  })
  on('tool.call', { tool: 'mcp__claude-code-remote__create_session' }, () => ({ result: 'created', text: world.text }) as any)
}
const create = ($: any) => $.tool.call({ tool: 'mcp__claude-code-remote__create_session', title: 'LC-5 build', prompt: 'go' } as any)
const tracked = async ($: any) => JSON.stringify(await $.tool.call({ tool: 'mcp__fleet-tracker__status' } as any))

test('a failed own-id lookup is retried, not cached as empty', async ($, on) => {
  const world = { ownCalls: 0, ownFailures: 1, text: `{"session_id":"${KID}","parent_session_id":"${OWN}"}` }
  createSession(on, world)
  await create($)
  // Lookup failed: own id unknown, two candidates in the result -> no guess.
  expect(await tracked($)).toContain('No sessions tracked')
  await create($)
  // Retried and succeeded: the parent is excluded, the child is tracked.
  expect(await tracked($)).toContain('LC-5')
  expect(world.ownCalls).toBe(2)
})

test('auto-track still works when the own-id lookup keeps failing and the result is unambiguous', async ($, on) => {
  const world = { ownCalls: 0, ownFailures: 99, text: `{"session_id":"${KID}"}` }
  createSession(on, world)
  await create($)
  expect(await tracked($)).toContain('LC-5')
})

test('a successful own-id lookup is cached (one lookup for several creates)', async ($, on) => {
  const world = { ownCalls: 0, ownFailures: 0, text: `{"session_id":"${KID}"}` }
  createSession(on, world)
  await create($)
  await create($)
  expect(world.ownCalls).toBe(1)
})
