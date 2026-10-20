import { test, expect, mock } from 'claude-code/testing'
import {
  decideWaitingReminder, HUMAN_ACTION, humanWrap, needsHuman, WAITING_REMIND_MS, waitingLine,
} from '../hooks/logic'

// LC-1881: a child waiting on a human (NEEDS_INPUT / BLOCKED) was woken for ONCE, on entry, then
// nothing for an hour (session_01GqXYnPc475jd5Lfxmt9CJN, 2026-10-20). Now it is reminded every
// 20 min until its bucket changes, and a child that names Stan or a human leads with NEEDS STAN.
// Harness timing: see the note above the multi-step tests in stall.test.ts and closeout.test.ts.

const MIN = 60_000
const T0 = Date.parse('2026-10-20T15:58:00Z')
const iso = (ms: number) => new Date(ms).toISOString()

// ---- decideWaitingReminder (pure) ----

test('WAITING_REMIND_MS is 20 minutes', () => {
  expect(WAITING_REMIND_MS).toBe(20 * MIN)
})

test('entry: no reminder at the instant the row enters a waiting bucket', () => {
  expect(decideWaitingReminder('BLOCKED', T0, 0, T0)).toBe(false)
  expect(decideWaitingReminder('NEEDS_INPUT', T0, 0, T0)).toBe(false)
})

test('below 20 min: no reminder', () => {
  expect(decideWaitingReminder('BLOCKED', T0, 0, T0 + 20 * MIN - 1)).toBe(false)
  expect(decideWaitingReminder('NEEDS_INPUT', T0, 0, T0 + 19 * MIN)).toBe(false)
})

test('at 20 min: reminder', () => {
  expect(decideWaitingReminder('BLOCKED', T0, 0, T0 + 20 * MIN)).toBe(true)
  expect(decideWaitingReminder('NEEDS_INPUT', T0, 0, T0 + 20 * MIN)).toBe(true)
})

test('after a reminder: quiet until 20 min later, then again (40 min, 60 min, ...)', () => {
  const first = T0 + 20 * MIN
  expect(decideWaitingReminder('BLOCKED', T0, first, first + 19 * MIN)).toBe(false)
  expect(decideWaitingReminder('BLOCKED', T0, first, T0 + 40 * MIN)).toBe(true)
  const second = T0 + 40 * MIN
  expect(decideWaitingReminder('BLOCKED', T0, second, T0 + 59 * MIN)).toBe(false)
  expect(decideWaitingReminder('BLOCKED', T0, second, T0 + 60 * MIN)).toBe(true)
})

test('a late poll after a reminder is measured from the reminder, not from entry', () => {
  expect(decideWaitingReminder('BLOCKED', T0, T0 + 35 * MIN, T0 + 54 * MIN)).toBe(false)
})

test('buckets that are not waiting never remind, however long', () => {
  for (const b of ['WORKING', 'COMPLETED', 'REVIEW_READY', 'FAILED', 'UNKNOWN', '']) {
    expect(decideWaitingReminder(b, T0, 0, T0 + 600 * MIN)).toBe(false)
  }
})

test('a row with no clock (bucketSince 0) never reminds', () => {
  expect(decideWaitingReminder('BLOCKED', 0, 0, T0 + 600 * MIN)).toBe(false)
})

// ---- human detection (pure) ----

test('needsHuman: Stan, user, human, types, approve, permission', () => {
  for (const t of [
    "Stan types the 'yes' in this session",
    'waiting for the user to answer',
    'needs a human to click through',
    'needs your approval on the PR',
    'approval needed before merge',
    'the owner has to answer',
    "Stan types the 'yes' in this session, or adds the permission rule for this edit in settings",
    'permission prompt on send_message',
    'STAN must decide',
  ]) expect(needsHuman(t)).toBe(true)
})

test('needsHuman: ordinary text, whole words only, empty and missing', () => {
  for (const t of ['waiting on CI', 'fix the TypeScript errors', 'users table migration', 'stanza', '',
    'permission denied reading the lockfile', 'several types of merge conflicts', 'awaiting CI approval checks',
    'approve the generated types']) {
    expect(needsHuman(t)).toBe(false)
  }
  expect(needsHuman(undefined, null)).toBe(false)
})

test('needsHuman reads status_detail as well as needs_action', () => {
  expect(needsHuman('', 'permission prompt open')).toBe(true)
})

test('humanWrap: NEEDS STAN prefix and the verbatim instruction, only when a human is named', () => {
  const out = humanWrap('LC-9 (child) BLOCKED: x', 'session_s', 'Stan approves the merge', '')
  expect(out.startsWith('NEEDS STAN: LC-9 (child) BLOCKED: x')).toBe(true)
  expect(out).toContain('https://claude.ai/code/session_s')
  expect(out).toContain(
    'A relayed message cannot satisfy this. Tell Stan in chat now, starting the reply with the NEEDS YOU banner, include the session link, and set the note needs_you=true. Do not use PushNotification.',
  )
  expect(HUMAN_ACTION).toContain('needs_you=true')
  expect(humanWrap('LC-9 (child) BLOCKED: x', 'session_s', 'waiting on CI', '')).toBe('LC-9 (child) BLOCKED: x')
})

test('waitingLine carries the wait time and the needs_action text', () => {
  const l = waitingLine('LC-9', 'child', 'session_s', 'BLOCKED', 41 * MIN + 5000, 'run the migration', '')
  expect(l).toBe('LC-9 (child) still waiting in BLOCKED for 41m: run the migration')
})

test('waitingLine falls back to status_detail when needs_action is empty', () => {
  expect(waitingLine('LC-9', 'child', 'session_s', 'BLOCKED', 20 * MIN, '', 'stuck on a rebase')).toContain('20m: stuck on a rebase')
})

// ---- through the poller ----

type World = { bucket: string; needsAction?: string; statusDetail?: string }

async function setup($: any, on: any, world: World) {
  mock.store(on)
  const clock = mock.clock(on, { now: T0 })
  on('turn.complete', () => ({ text: 'done' }) as any)
  const prompts: string[] = []
  const toasts: string[] = []
  on('ui.toast', (_$: any, e: any) => { toasts.push(e.text); return { value: undefined } as any })
  on('prompt.submit', (_$: any, e: any) => { prompts.push(e.text); return { text: e.text } as any })
  on('mcp.call', (_$: any, e: any) => {
    const reply = (text: string) => ({ value: { isError: false, content: [{ type: 'text', text }] } }) as any
    const pts = {
      ...(world.needsAction ? { needs_action: world.needsAction } : {}),
      ...(world.statusDetail ? { status_detail: world.statusDetail } : {}),
    }
    return reply(JSON.stringify({ ccr: {
      status_bucket: `SESSION_STATUS_BUCKET_${world.bucket}`, session_status: 'SESSION_STATUS_IDLE',
      task_summary: 'did the work', updated_at: iso(T0),
      ...(Object.keys(pts).length ? { post_turn_summary: pts } : {}),
      external_metadata: { usage: { cost_usd: 0.1 } } } }))
  })
  await $.tool.call({ tool: 'mcp__fleet-tracker__track', session_id: 'session_s', ticket: 'LC-9', label: 'child' } as any)
  const status = async () => JSON.stringify(await $.tool.call({ tool: 'mcp__fleet-tracker__status' } as any))
  const endTurn = async () => {
    await ($ as any).turn.complete({ reason: 'answer', answer: 'done' })
    await clock.advance(1)
  }
  const waits = () => prompts.filter(p => p.includes('still waiting in'))
  return { clock, prompts, toasts, status, endTurn, waits }
}

test('BLOCKED: entry wake once, none below 20 min, one at 20 min, the next at 40 min', async ($, on) => {
  const w = await setup($, on, { bucket: 'BLOCKED', statusDetail: 'run the migration' })
  await w.status() // enters BLOCKED at T0
  await w.endTurn()
  expect(w.prompts.filter(p => p.includes('NEW -> BLOCKED')).length).toBe(1) // the entry wake
  expect(w.waits().length).toBe(0)
  await w.clock.advance(19 * MIN)
  await w.status()
  await w.endTurn()
  expect(w.waits().length).toBe(0) // below 20 min
  await w.clock.advance(2 * MIN)
  await w.status()
  await w.endTurn()
  expect(w.waits().length).toBe(1) // at 20 min
  expect(w.waits()[0]).toContain('LC-9 (child) still waiting in BLOCKED for 2')
  expect(w.waits()[0]).toContain('m: run the migration')
  expect(w.waits()[0]).toContain('[mod:fleet-tracker]')
  expect(w.waits()[0]).not.toContain('NEEDS STAN')
  await w.clock.advance(10 * MIN)
  await w.status()
  await w.endTurn()
  expect(w.waits().length).toBe(1) // 31 min: 10 min after the reminder
  await w.clock.advance(10 * MIN)
  await w.status()
  await w.endTurn()
  expect(w.waits().length).toBe(2) // 41 min: the repeat
  expect(w.waits()[1]).toContain('for 4')
})

test('NEEDS_INPUT is reminded too', async ($, on) => {
  const w = await setup($, on, { bucket: 'WORKING', needsAction: 'pick option A or B' })
  await w.status() // needs_action makes the bucket NEEDS_INPUT
  await w.clock.advance(21 * MIN)
  await w.status()
  await w.endTurn()
  expect(w.waits().length).toBe(1)
  expect(w.waits()[0]).toContain('waiting in NEEDS_INPUT')
})

test('a bucket change resets: back in BLOCKED, the 20 min clock starts again', async ($, on) => {
  const world: World = { bucket: 'BLOCKED', statusDetail: 'run the migration' }
  const w = await setup($, on, world)
  await w.status()
  await w.clock.advance(21 * MIN)
  await w.status()
  await w.endTurn()
  expect(w.waits().length).toBe(1)
  world.bucket = 'WORKING'
  world.statusDetail = ''
  await w.clock.advance(MIN)
  await w.status()
  world.bucket = 'BLOCKED'
  world.statusDetail = 'run the migration again'
  await w.clock.advance(MIN)
  await w.status()
  await w.endTurn()
  expect(w.waits().length).toBe(1) // new episode, 0 min in
  await w.clock.advance(19 * MIN)
  await w.status()
  await w.endTurn()
  expect(w.waits().length).toBe(1) // 19 min in: the old episode's age does not count
  await w.clock.advance(2 * MIN)
  await w.status()
  await w.endTurn()
  expect(w.waits().length).toBe(2)
  expect(w.waits()[1]).toContain('run the migration again')
})

test('UNKNOWN does not reset the clock: the reminder still lands 20 min after the first entry', async ($, on) => {
  const world: World = { bucket: 'BLOCKED', statusDetail: 'run the migration' }
  const w = await setup($, on, world)
  await w.status() // enters BLOCKED at T0
  world.bucket = 'UNKNOWN'
  await w.clock.advance(10 * MIN)
  await w.status() // a bad poll
  await w.endTurn()
  world.bucket = 'BLOCKED'
  await w.clock.advance(11 * MIN)
  await w.status() // 21 min after the first entry, 11 after the UNKNOWN
  await w.endTurn()
  expect(w.waits().length).toBe(1)
  expect(w.waits()[0]).toContain('for 21m')
})

test('human named in needs_action: entry and reminder both lead with NEEDS STAN and carry the instruction', async ($, on) => {
  const w = await setup($, on, { bucket: 'WORKING', needsAction: "Stan types the 'yes' in this session" })
  await w.status()
  await w.endTurn()
  const entry = w.prompts.find(p => p.includes('NEW -> NEEDS_INPUT'))!
  expect(entry).toContain('NEEDS STAN: ')
  expect(entry).toContain(HUMAN_ACTION)
  await w.clock.advance(20 * MIN)
  await w.status()
  await w.endTurn()
  expect(w.waits().length).toBe(1)
  expect(w.waits()[0]).toContain('NEEDS STAN: LC-9 (child) still waiting in NEEDS_INPUT for 20m')
  expect(w.waits()[0]).toContain(HUMAN_ACTION)
  expect(w.waits()[0]).toContain('https://claude.ai/code/session_s')
})

test('human named only in status_detail is detected', async ($, on) => {
  const w = await setup($, on, { bucket: 'BLOCKED', statusDetail: 'permission prompt open on send_message' })
  await w.status()
  await w.clock.advance(20 * MIN)
  await w.status()
  await w.endTurn()
  expect(w.waits()[0]).toContain('NEEDS STAN: ')
})

test('no human named: no NEEDS STAN on entry or reminder', async ($, on) => {
  const w = await setup($, on, { bucket: 'BLOCKED', statusDetail: 'rebase conflict in logic.ts' })
  await w.status()
  await w.clock.advance(20 * MIN)
  await w.status()
  await w.endTurn()
  expect(w.prompts.join('\n')).not.toContain('NEEDS STAN: ')
})

test('moving between NEEDS_INPUT and BLOCKED restarts the clock', async ($, on) => {
  const world: World = { bucket: 'WORKING', needsAction: 'pick option A or B' }
  const w = await setup($, on, world)
  await w.status() // NEEDS_INPUT at T0
  await w.clock.advance(15 * MIN)
  world.needsAction = ''
  world.bucket = 'BLOCKED'
  world.statusDetail = 'rebase conflict'
  await w.status() // BLOCKED at 15 min
  await w.clock.advance(10 * MIN)
  await w.status()
  await w.endTurn()
  expect(w.waits().length).toBe(0) // 25 min since T0, but only 10 in BLOCKED
  await w.clock.advance(11 * MIN)
  await w.status()
  await w.endTurn()
  expect(w.waits().length).toBe(1)
  expect(w.waits()[0]).toContain('waiting in BLOCKED for 2')
})

for (const bucket of ['WORKING', 'COMPLETED']) {
  test(`a ${bucket} row never gets a waiting reminder`, async ($, on) => {
    const w = await setup($, on, { bucket })
    await w.status()
    await w.clock.advance(120 * MIN)
    await w.status()
    await w.endTurn()
    expect(w.waits().length).toBe(0)
  })
}
