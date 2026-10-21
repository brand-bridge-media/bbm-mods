import { test, expect, mock } from 'claude-code/testing'
import { decideWake, NEEDS_STAN } from '../hooks/logic'

// Transition gate: which bucket changes wake the orchestrator, which flag the operator,
// and which are suppressed. A broken gate would otherwise stay green (LC-1711 review).

type Reply = { bucket: string; summary?: string; needsAction?: string }

async function setup($: any, on: any) {
  mock.store(on)
  const clock = mock.clock(on, { now: Date.parse('2026-10-07T12:00:00Z') })
  const toasts: string[] = []
  const prompts: string[] = []
  on('ui.toast', (_$: any, e: any) => { toasts.push(e.text); return { value: undefined } as any })
  on('prompt.submit', (_$: any, e: any) => { prompts.push(e.text); return { text: e.text } as any })
  let reply: Reply = { bucket: 'WORKING' }
  let calls = 0
  on('mcp.call', () => (calls++, { value: {
    isError: false,
    content: [{ type: 'text', text: JSON.stringify({ ccr: {
      status_bucket: `SESSION_STATUS_BUCKET_${reply.bucket}`, session_status: 'SESSION_STATUS_RUNNING',
      task_summary: reply.summary ?? 'x',
      ...(reply.needsAction ? { post_turn_summary: { needs_action: reply.needsAction } } : {}), updated_at: '2026-10-07T11:58:00Z' } }) }],
  } }) as any)
  await $.tool.call({ tool: 'mcp__fleet-tracker__track', session_id: 'session_x', ticket: 'LC-1', label: 'demo' } as any)
  const poll = async (r: Reply) => {
    reply = r
    toasts.length = 0; prompts.length = 0
    const before = calls
    await clock.advance(91_000) // past the mod's 90 s poll timer (exactly 90 s can miss the re-armed tick); prompt.submit is refused inside a tool.call
    expect(calls).toBe(before + 1) // the poll really ran: silence below means 'no wake', not 'no poll'
    return { toasts: [...toasts], prompts: [...prompts] }
  }
  return poll
}

test('BLOCKED wakes the orchestrator and flags the operator', async ($, on) => {
  const poll = await setup($, on)
  const out = await poll({ bucket: 'BLOCKED', summary: 'needs a decision' })
  expect(out.prompts.length).toBe(1)
  expect(out.prompts[0]).toContain('LC-1')
  expect(out.prompts[0]).toContain('BLOCKED')
  expect(out.toasts.join(' ')).toContain('needs you')
})

test('FAILED wakes the orchestrator and flags the operator', async ($, on) => {
  const poll = await setup($, on)
  const out = await poll({ bucket: 'FAILED' })
  expect(out.prompts.length).toBe(1)
  expect(out.toasts.join(' ')).toContain('needs you')
})

test('REVIEW_READY wakes the orchestrator without flagging the operator', async ($, on) => {
  const poll = await setup($, on)
  const out = await poll({ bucket: 'REVIEW_READY' })
  expect(out.prompts.length).toBe(1)
  expect(out.toasts.length).toBe(0)
})

test('a session just waiting on CI does not wake the orchestrator', async ($, on) => {
  const poll = await setup($, on)
  const out = await poll({ bucket: 'COMPLETED', summary: 'waiting on CI' })
  expect(out.prompts.length).toBe(0)
})

test('BLOCKED still wakes when its summary says CI is running', async ($, on) => {
  const poll = await setup($, on)
  const out = await poll({ bucket: 'BLOCKED', summary: 'CI checks running, decision needed' })
  expect(out.prompts.length).toBe(1)
  expect(out.toasts.join(' ')).toContain('needs you')
})

test('a pending needs_action wakes as NEEDS_INPUT even when the bucket says COMPLETED', async ($, on) => {
  const poll = await setup($, on)
  const out = await poll({ bucket: 'COMPLETED', needsAction: 'pick option A or B' })
  expect(out.prompts.length).toBe(1)
  expect(out.prompts[0]).toContain('NEEDS_INPUT')
  expect(out.prompts[0]).toContain('pick option A or B')
})

test('an unchanged bucket does not wake twice', async ($, on) => {
  const poll = await setup($, on)
  await poll({ bucket: 'BLOCKED' })
  // The timer re-arms only once per test in this harness, so the second poll is the
  // status tool's forced one. A wake there is refused (prompt.submit inside a tool.call),
  // which surfaces as an unhandled rejection and fails the file: a re-wake cannot hide.
  const out: any = await $.tool.call({ tool: 'mcp__fleet-tracker__status' } as any)
  expect(JSON.stringify(out)).toContain('BLOCKED')
})

for (const summary of ['waiting for checks', 'PR #1 CI pending on abc', 'checks queued', 'awaiting CI on 123']) {
  test(`"${summary}" does not wake the orchestrator`, async ($, on) => {
    const poll = await setup($, on)
    const out = await poll({ bucket: 'REVIEW_READY', summary })
    expect(out.prompts.length).toBe(0)
  })
}

// Same setup for blip and control: ONLY the summary differs, so the blip test cannot pass for another reason.
async function newSessionPrompts($: any, on: any, summary: string) {
  mock.store(on)
  const clock = mock.clock(on, { now: Date.parse('2026-10-07T12:00:00Z') })
  const prompts: string[] = []
  on('prompt.submit', (_$: any, e: any) => { prompts.push(e.text); return { text: e.text } as any })
  on('ui.toast', () => ({ value: undefined }) as any)
  on('mcp.call', () => ({ value: { isError: false, content: [{ type: 'text', text: JSON.stringify({ ccr: {
    status_bucket: 'SESSION_STATUS_BUCKET_REVIEW_READY', session_status: 'SESSION_STATUS_RUNNING',
    ...(summary ? { task_summary: summary } : {}), updated_at: '2026-10-07T11:59:00Z' } }) }] } }) as any)
  await $.tool.call({ tool: 'mcp__fleet-tracker__track', session_id: 'session_new', ticket: 'LC-2', label: 'new' } as any)
  await clock.advance(91_000)
  return prompts
}

test('a brand-new session reporting REVIEW_READY with an empty summary is a startup blip, not a wake', async ($, on) => {
  expect((await newSessionPrompts($, on, '')).length).toBe(0)
})

test('positive control: the same new session with a non-empty summary wakes once', async ($, on) => {
  expect((await newSessionPrompts($, on, 'draft ready')).length).toBe(1)
})

// Leave-and-return cycles go straight at decideWake: the harness timer re-arms only once per test.
const cycle = (steps: [string, string][], start = 'WORKING') => {
  const m = new Map<string, string>(); let prev = start
  return steps.map(([bucket, summary]) => { const d = decideWake(m, 's', prev, bucket, summary); prev = d.holdPrevBucket ? prev : bucket; return d.wake })
}

test('re-entering a wake bucket after leaving it wakes again', () => {
  expect(cycle([['BLOCKED', 'needs a decision'], ['WORKING', 'x'], ['BLOCKED', 'needs you again']])).toEqual([true, false, true])
})

test('REVIEW_READY -> WORKING -> REVIEW_READY wakes on each distinct entry', () => {
  expect(cycle([['REVIEW_READY', 'first draft'], ['WORKING', 'x'], ['REVIEW_READY', 'second draft']])).toEqual([true, false, true])
})

test('overlapping polls on the same change still wake once', () => {
  const m = new Map<string, string>()
  expect([decideWake(m, 's', 'WORKING', 'BLOCKED', 'd').wake, decideWake(m, 's', 'WORKING', 'BLOCKED', 'd').wake]).toEqual([true, false])
})

test('a negated CI-wait summary still wakes', async ($, on) => {
  const poll = await setup($, on)
  const out = await poll({ bucket: 'REVIEW_READY', summary: 'agent is not waiting on ci; please review the plan' })
  expect(out.prompts.length).toBe(1)
})

// BLOCKED/FAILED must wake whatever the summary says (guards the !NEEDS_STAN clause).
for (const bucket of ['BLOCKED', 'FAILED']) {
  test(`${bucket} with CI-wait wording still wakes`, () => {
    expect(decideWake(new Map(), 's', 'WORKING', bucket, 'waiting on CI checks running').wake).toBe(true)
  })
}

// Real READY reports that merely mention a CI word must wake.
for (const summary of ['READY: PR #12 opened, CI green, pending your review', 'checks passed; deploy running', 'CI green, 2 tests queued for follow-up']) {
  test(`"${summary}" wakes on REVIEW_READY`, () => {
    expect(decideWake(new Map(), 's', 'WORKING', 'REVIEW_READY', summary).wake).toBe(true)
  })
}

test('blip then a poll with a summary wakes once', () => {
  expect(cycle([['REVIEW_READY', ''], ['REVIEW_READY', 'first draft ready']], '')).toEqual([false, true])
})

test('suppressed CI-wait entry, then a same-bucket real READY, wakes', () => {
  expect(cycle([['REVIEW_READY', 'waiting for checks'], ['REVIEW_READY', 'READY: CI green, please review']])).toEqual([false, true])
})

test('suppressed CI-wait, then an empty-summary REVIEW_READY, still wakes (hold must not become a blip)', () => {
  expect(cycle([['REVIEW_READY', 'waiting for checks'], ['REVIEW_READY', '']])).toEqual([false, true])
})

// Wait prose that merely contains a DONE-looking word is still a wait (suppressed).
for (const summary of ['waiting for checks to pass', 'waiting for CI to pass', 'waiting for CI to go green']) {
  test(`"${summary}" is suppressed`, () => {
    expect(decideWake(new Map(), 's', 'WORKING', 'REVIEW_READY', summary).wake).toBe(false)
  })
}

test('a whitespace-only summary on a new session is a startup blip', () => {
  expect(cycle([['REVIEW_READY', '   ']], '')).toEqual([false])
})

// CI-wait wording AND a finished-state word: err toward waking (the DONE guard is what makes these wake).
for (const summary of ['CI running, tests passed locally', 'READY: draft done, CI queued', 'CI pending; earlier run was green']) {
  test(`"${summary}" wakes (finished state beats CI-wait wording)`, () => {
    expect(decideWake(new Map(), 's', 'WORKING', 'REVIEW_READY', summary).wake).toBe(true)
  })
}

// Protocol tokens and hard finished words always wake, whatever else the summary says.
for (const summary of [
  'READY: please review; CI still pending once rebase lands',
  'READY: draft done, CI queued until the rebase lands',
  'NEEDS STAN: pick A or B; CI running',
  'tests passed locally, CI running once rebase lands',
  'build successful, CI still pending until merge',
  'checks pending review',
  'ci pending your approval',
]) {
  test(`"${summary}" wakes`, () => {
    expect(decideWake(new Map(), 's', 'WORKING', 'REVIEW_READY', summary).wake).toBe(true)
  })
}

// ---- exact-phrase allowlist: suppress only when the WHOLE summary is a short wait phrase ----
const ALLOWLISTED = [
  'waiting on CI', 'waiting for checks', 'Waiting for CI to finish.', 'waiting on re-run', 'awaiting CI', 'awaiting checks on 123',
  'CI running', 'CI is still running', 'checks are pending', 'check queued', 'CI in progress', 'CI restarting', 'polling for completion',
  'PR #1 CI pending on abc', 'PR #12: checks queued', 'CI running on #44', 'CI pending for 1a2b3c4',
]
for (const summary of ALLOWLISTED) {
  test(`allowlisted "${summary}" is suppressed`, () => {
    expect(decideWake(new Map(), 's', 'WORKING', 'REVIEW_READY', summary).wake).toBe(false)
  })
}

// Anything longer or different wakes (policy: an extra wake is cheap, a missed READY is not).
const WAKES = [
  'checks pending - main is green once the flake was fixed; please review',
  'CI running, will merge once green',
  'CI running, decision needed',
  'waiting on CI and also on your answer',
  'CI running on weekends',
  'prefix: waiting on CI',
  'waiting on CI; ping me',
  'checks pending review',
]
for (const summary of WAKES) {
  test(`non-allowlisted "${summary}" wakes`, () => {
    expect(decideWake(new Map(), 's', 'WORKING', 'REVIEW_READY', summary).wake).toBe(true)
  })
}

test('trimmed whitespace around an allowlisted phrase is still suppressed', () => {
  expect(decideWake(new Map(), 's', 'WORKING', 'REVIEW_READY', '  waiting on CI \n').wake).toBe(false)
})

test('BLOCKED/FAILED are never suppressed, even for an exact allowlisted phrase', () => {
  for (const b of ['BLOCKED', 'FAILED']) {
    expect(decideWake(new Map(), 's', 'WORKING', b, 'waiting on CI').wake).toBe(true)
  }
})

test('NEEDS_STAN is the single shared set', () => {
  expect([...NEEDS_STAN].sort()).toEqual(['BLOCKED', 'FAILED'])
})
