import { expect, mock } from 'claude-code/testing'
import { test } from './slow'
import { AWAIT_STALE_MS, decideAwait, mergeAwaits, parseAwaits, prState, runState, waitingOn } from '../hooks/awaits'

// LC-1975 fix 4: the orchestrator reads what an idle child said it waits on (its watcher mods' own lines),
// checks that thing itself, and is woken when it finished 10+ min ago while the child still sits idle.
// Motivating cases (2026-10-31): LC-1935 idle ~3 h after its run finished; LC-1967 on #2398.

const T0 = Date.parse('2026-11-01T00:00:00Z')
const MIN = 60_000
const iso = (ms: number) => new Date(ms).toISOString()
const ev = (at: number, text: string) => ({ created_at: iso(at), user: { content: [{ type: 'tool_result', content: text }] } })
const events = (...e: any[]) => JSON.stringify({ ccr: { data: e } })

const PR_ANNOUNCE = '[mod:pr-ci-watch] Watching CI on brand-bridge-media/bbm-infrastructure#2398: checked every 2 minutes; this session is woken when it finishes.'
const ARMED = '[mod:pr-ci-watch] Watching o/r#7 until it merges: checked every 2 minutes.'
const ARMED_IN_PLACE = '[mod:pr-ci-watch] o/r#8 is armed: watching it until it merges; woken on merge.'
const RUN = '[mod:workflow-run-watch] Watching o/r db-test.yml: checked every minute.'
const DISPATCH = '[mod:dispatch-watch] Watching refresh-run.yml: its run is checked every minute.'

test('announcements of every watcher are read with their time; the child being told ends the item', () => {
  const p = parseAwaits(events(ev(T0, PR_ANNOUNCE), ev(T0 + MIN, ARMED), ev(T0 + 2 * MIN, ARMED_IN_PLACE), ev(T0 + 3 * MIN, RUN), ev(T0 + 4 * MIN, DISPATCH)))
  expect(p.announced.map(a => [a.key, a.since, !!a.untilMerge])).toEqual([
    ['pr:brand-bridge-media/bbm-infrastructure#2398', T0, false],
    ['pr:o/r#7', T0 + MIN, true],
    ['pr:o/r#8', T0 + 2 * MIN, true],
    ['run:o/r:db-test.yml', T0 + 3 * MIN, false],
    ['dispatch:refresh-run.yml', T0 + 4 * MIN, false],
  ])
  const told = parseAwaits(events(ev(T0, PR_ANNOUNCE), ev(T0 + 9 * MIN, '[mod:pr-ci-watch] brand-bridge-media/bbm-infrastructure#2398: CI finished on bb7204e: 1 of 26 checks failed'),
    ev(T0 + MIN, ARMED), ev(T0 + 100 * MIN, '[mod:pr-ci-watch] o/r#7 is armed for auto-merge and green on abc1234, but still not merged after 90 min: x. Stopped watching'),
    ev(T0 + 3 * MIN, RUN), ev(T0 + 5 * MIN, '[mod:workflow-run-watch] o/r db-test.yml run 9 finished: success after 2 min.'),
    ev(T0 + 4 * MIN, DISPATCH), ev(T0 + 6 * MIN, '[mod:dispatch-watch] refresh-run.yml run 4 finished: success after 44 s.')))
  expect(mergeAwaits([], told)).toEqual([])
})

test('the 30-min "green but not merged" reminder does not end an armed watch; only the merge or the give-up does (#2444 review)', () => {
  const kept = mergeAwaits([], parseAwaits(events(ev(T0, ARMED),
    ev(T0 + 40 * MIN, '[mod:pr-ci-watch] o/r#7 is armed for auto-merge and green on abc1234, but not merged after 30 min: x. Still watching'))))
  expect(kept.map(a => a.key)).toEqual(['pr:o/r#7'])
})

test('a newer announcement is a new watch; a report older than it does not end it', () => {
  const first = mergeAwaits([], parseAwaits(events(ev(T0, PR_ANNOUNCE))))
  const again = mergeAwaits(first, parseAwaits(events(
    ev(T0 + 5 * MIN, '[mod:pr-ci-watch] brand-bridge-media/bbm-infrastructure#2398: CI finished on aaa: all passed'),
    ev(T0 + 10 * MIN, PR_ANNOUNCE))))
  expect(again.map(a => a.since)).toEqual([T0 + 10 * MIN])
})

test('PR state: merged / closed / CI failed / green / running / armed-not-merged / unreadable', () => {
  const open = JSON.stringify({ state: 'open', merged: false, head: { sha: 'x' } })
  const runs = (...r: [string, string, string | null][]) => JSON.stringify({ check_runs: r.map(([name, status, conclusion]) => ({ name, status, conclusion })) })
  expect(prState(JSON.stringify({ state: 'closed', merged: true }), undefined, false)).toEqual({ done: true, what: 'merged' })
  expect(prState(JSON.stringify({ state: 'closed', merged: false }), undefined, false)).toEqual({ done: true, what: 'closed without merging' })
  expect(prState(open, undefined, false)).toBeNull()
  expect(prState(open, runs(['lint', 'completed', 'success'], ['review', 'completed', 'failure']), true)).toEqual({ done: true, what: 'CI failed (review)' })
  expect(prState(open, runs(['lint', 'completed', 'success']), false)).toEqual({ done: true, what: 'CI finished green' })
  expect(prState(open, runs(['lint', 'in_progress', null]), false)).toEqual({ done: false, what: 'CI running' })
  expect(prState(open, runs(['lint', 'completed', 'success']), true)).toEqual({ done: false, what: 'armed, not merged' })
  expect(prState('garbage', undefined, false)).toBeNull()
  // An empty or malformed merged_at is not a merge (#2444 review findings 1-2).
  expect(prState(JSON.stringify({ state: 'closed', merged: false, merged_at: '' }), undefined, false)).toEqual({ done: true, what: 'closed without merging' })
  expect(prState(JSON.stringify({ state: 'open', merged: false, merged_at: '' }), undefined, false)).toBeNull()
  expect(prState(JSON.stringify({ state: 'closed', merged: false, merged_at: '2026-11-01T01:19:26Z' }), undefined, false)).toEqual({ done: true, what: 'merged' })
})

test('run state: the first run created after the start', () => {
  const list = JSON.stringify({ workflow_runs: [
    { id: 1, status: 'completed', conclusion: 'success', created_at: iso(T0 - 30 * MIN) },
    { id: 2, status: 'completed', conclusion: 'success', created_at: iso(T0 + 10_000) }] })
  expect(runState(list, T0)).toEqual({ done: true, what: 'run 2 success' })
  expect(runState(JSON.stringify({ workflow_runs: [{ id: 3, status: 'in_progress', conclusion: null, created_at: iso(T0) }] }), T0)).toEqual({ done: false, what: 'run 3 in_progress' })
  expect(runState(JSON.stringify({ workflow_runs: [] }), T0)).toEqual({ done: false, what: 'no run yet' })
  expect(runState('x', T0)).toBeNull()
})

const A = { key: 'pr:o/r#7', kind: 'pr' as const, owner: 'o', repo: 'r', number: 7, since: T0 }
const DONE = { done: true, what: 'merged' }

test('finished: no wake for 10 min, then one wake while the child stays idle with no activity since', () => {
  const first = decideAwait(A, DONE, 'REVIEW_READY', T0, T0 + 20 * MIN)
  expect(first.wake).toBeUndefined()
  expect(first.item.doneAt).toBe(T0 + 20 * MIN)
  expect(decideAwait(first.item, DONE, 'REVIEW_READY', T0, T0 + 29 * MIN).wake).toBeUndefined()
  const due = decideAwait(first.item, DONE, 'REVIEW_READY', T0, T0 + 20 * MIN + AWAIT_STALE_MS)
  expect(due.wake).toContain('o/r#7 merged 10+ min ago, and the child is still REVIEW_READY')
  expect(due.item.woke).toBe(true)
  expect(decideAwait(due.item, DONE, 'REVIEW_READY', T0, T0 + 60 * MIN).wake).toBeUndefined()
})

test('no wake when the child moved after it finished, when it is working, or when the state is unknown', () => {
  const seen = { ...A, doneAt: T0 + 5 * MIN }
  expect(decideAwait(seen, DONE, 'REVIEW_READY', T0 + 6 * MIN, T0 + 30 * MIN).wake).toBeUndefined()
  expect(decideAwait(seen, DONE, 'WORKING', T0, T0 + 30 * MIN).wake).toBeUndefined()
  expect(decideAwait(seen, null, 'REVIEW_READY', T0, T0 + 30 * MIN)).toEqual({ item: { ...seen, checkedAt: T0 + 30 * MIN } })
  // Not finished any more (a re-run): the clock resets.
  expect(decideAwait(seen, { done: false, what: 'CI running' }, 'REVIEW_READY', T0, T0 + 30 * MIN).item.doneAt).toBeUndefined()
})

test('the dashboard line names each item and its state', () => {
  expect(waitingOn([{ ...A, doneWhat: 'CI running' }, { key: 'dispatch:refresh-run.yml', kind: 'dispatch', workflow: 'refresh-run.yml', since: T0 }]))
    .toBe('waiting on: o/r#7 (CI running); refresh-run.yml (bridge) (not checked here)')
  expect(waitingOn([])).toBe('')
})

// ---- end to end through the poll ----

test('end to end: an idle child whose PR merged 10+ min ago wakes the orchestrator once; a working fleet reads no transcript', async ($, on) => {
  mock.store(on)
  const clock = mock.clock(on, { now: T0 })
  on('turn.complete', () => ({ text: 'done' }) as any)
  on('ui.toast', () => ({ value: undefined }) as any)
  const prompts: string[] = []
  on('prompt.submit', (_$: any, e: any) => { prompts.push(e.text); return { text: e.text } as any })
  const calls: string[] = []
  let bucket = 'WORKING'
  on('mcp.call', (_$: any, e: any) => {
    calls.push(`${e.server}:${e.tool}${e.args?.kinds ? ':awaits' : ''}`)
    const reply = (text: string) => ({ value: { isError: false, content: [{ type: 'text', text }] } }) as any
    if (e.tool === 'list_events') return reply(events(ev(T0 - 30 * MIN, ARMED)))
    if (e.tool === 'pull_request_read') return reply(JSON.stringify({ state: 'closed', merged: true }))
    return reply(JSON.stringify({ ccr: { status_bucket: `SESSION_STATUS_BUCKET_${bucket}`, session_status: 'SESSION_STATUS_IDLE',
      task_summary: 'waiting on the train', updated_at: iso(T0 - MIN), external_metadata: { usage: { cost_usd: 0.1 } } } }))
  })
  await $.tool.call({ tool: 'mcp__fleet-tracker__track', session_id: 'session_s', ticket: 'LC-9', label: 'child' } as any)
  const status = async () => String((await $.tool.call({ tool: 'mcp__fleet-tracker__status' } as any) as any).result)
  const endTurn = async () => { await ($ as any).turn.complete({ reason: 'answer', answer: 'done' }); await clock.advance(1) }

  await status()
  expect(calls.some(c => c.endsWith('list_events:awaits'))).toBe(false) // WORKING: no extra read
  bucket = 'REVIEW_READY'
  await status() // first idle poll: still no read
  expect(calls.filter(c => c.endsWith('list_events:awaits')).length).toBe(0)
  await clock.advance(MIN)
  const shown = await status() // second idle poll: reads the transcript, sees the merge
  expect(calls.filter(c => c.endsWith('list_events:awaits')).length).toBe(1)
  expect(shown).toContain('waiting on: o/r#7 (merged)')
  await endTurn()
  expect(prompts.join('\n')).not.toContain('AWAITED THING FINISHED')
  await clock.advance(11 * MIN)
  await status()
  await endTurn()
  const woke = prompts.filter(p => p.includes('AWAITED THING FINISHED'))
  expect(woke.length).toBe(1)
  expect(woke[0]).toContain('LC-9 (child) AWAITED THING FINISHED: o/r#7 merged')
  await clock.advance(10 * MIN)
  await status()
  await endTurn()
  expect(prompts.filter(p => p.includes('AWAITED THING FINISHED')).length).toBe(1)
})
