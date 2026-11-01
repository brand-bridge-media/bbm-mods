import { test, expect } from 'claude-code/testing'

import { decide, FAST_MS, LONG_MS, MAX_ERRORS, NO_RUN_MS, parseRuns, parseStart, watchKey } from '../hooks/logic'

const T0 = Date.parse('2026-10-31T19:54:00Z')
const MIN = 60_000
const since = new Date(T0 - MIN).toISOString()
const W = { owner: 'o', repo: 'r', server: 'github', workflow: 'db-test.yml', since, startedAt: T0 }
const iso = (ms: number) => new Date(ms).toISOString()
const run = (id: number, created: number, status = 'completed', took = 10 * MIN, conclusion: string | null = 'success') =>
  ({ id, status, conclusion, created_at: iso(created), run_started_at: iso(created), updated_at: iso(created + took), html_url: `https://x/${id}` })

test('starts and re-runs are recognised; cancels and bad args are not', () => {
  expect(parseStart({ method: 'run_workflow', owner: 'o', repo: 'r', workflow_id: 'db-test.yml', ref: 'main' })).toEqual({ workflow: 'db-test.yml' })
  expect(parseStart({ method: 'rerun_failed_jobs', owner: 'o', repo: 'r', run_id: 41 })).toEqual({ runId: 41 })
  expect(parseStart({ method: 'rerun_workflow_run', owner: 'o', repo: 'r', run_id: 42 })).toEqual({ runId: 42 })
  expect(parseStart({ method: 'cancel_workflow_run', owner: 'o', repo: 'r', run_id: 41 })).toBeNull()
  expect(parseStart({ method: 'run_workflow', owner: 'o', repo: 'r' })).toBeNull()
  expect(parseStart({ method: 'rerun_workflow_run', owner: 'o', repo: 'r', run_id: 'x' })).toBeNull()
  expect(parseStart({ method: 'run_workflow', workflow_id: 'a.yml' })).toBeNull()
})

test('keys: a workflow start keeps its workflow key; a re-run is keyed by run id', () => {
  expect(watchKey({ ...W, runId: 9 })).toBe('run:o/r:db-test.yml')
  expect(watchKey({ owner: 'O', repo: 'R', runId: 9 })).toBe('run:o/r:9')
  expect(watchKey({ owner: 'o', repo: 'r', workflow: '.github/workflows/X.yml' })).toBe('run:o/r:x.yml')
})

test('runs are read from a list, a {workflow_runs} page, or a single run', () => {
  const r = run(1, T0)
  expect(parseRuns(JSON.stringify([r]))).toEqual([r])
  expect(parseRuns(JSON.stringify({ total_count: 1, workflow_runs: [r, { junk: 1 }] }))).toEqual([r])
  expect(parseRuns(JSON.stringify(r))).toEqual([r])
  expect(parseRuns('nope')).toBeUndefined()
})

test('an older run is not this one; no run after 6 min wakes', () => {
  const old = run(1, T0 - 10 * MIN)
  expect(decide(W, { kind: 'runs', runs: [old] }, T0 + 2 * MIN).done).toBe(false)
  const d = decide(W, { kind: 'runs', runs: [old] }, T0 + NO_RUN_MS + MIN)
  expect(d.done).toBe(true)
  expect(d.wake).toMatch(/^\[mod:workflow-run-watch\] o\/r db-test.yml: no run appeared/)
})

test('running records the run id and waits; past 90 min it says so once', () => {
  const r = run(7, T0 + 10_000, 'in_progress', 0, null)
  expect(decide(W, { kind: 'runs', runs: [r] }, T0 + 3 * MIN)).toEqual({ done: false, patch: { errors: 0, runId: 7 } })
  const long = decide(W, { kind: 'runs', runs: [r] }, T0 + LONG_MS + MIN)
  expect(long.wake).toContain('still in_progress')
  expect(decide({ ...W, warnedLong: true }, { kind: 'runs', runs: [r] }, T0 + LONG_MS + 2 * MIN).wake).toBeUndefined()
})

test('a finish wakes with conclusion and time; under 2 minutes it warns (the LC-1935 44 s run)', () => {
  const slow = decide(W, { kind: 'runs', runs: [run(7, T0 + 10_000)] }, T0 + 12 * MIN)
  expect(slow.done).toBe(true)
  expect(slow.wake).toContain('finished: success after 10 min')
  expect(slow.wake).not.toContain('did nothing')
  const fast = decide(W, { kind: 'runs', runs: [run(8, T0 + 10_000, 'completed', 44_000)] }, T0 + 2 * MIN)
  expect(fast.wake).toContain('after 44 s')
  expect(fast.wake).toContain('did nothing')
  expect(44_000).toBeLessThan(FAST_MS)
})

test('a re-run matches its own id only once its new attempt has started', () => {
  const R = { owner: 'o', repo: 'r', server: 'github', runId: 5, since, startedAt: T0 }
  const stale = { ...run(5, T0 - 60 * MIN), run_started_at: iso(T0 - 60 * MIN) }
  expect(decide(R, { kind: 'runs', runs: [stale] }, T0 + MIN).done).toBe(false)
  const fresh = { ...run(5, T0 - 60 * MIN), run_started_at: iso(T0 + 5_000), updated_at: iso(T0 + 5 * MIN) }
  const d = decide(R, { kind: 'runs', runs: [fresh] }, T0 + 6 * MIN)
  expect(d.done).toBe(true)
  expect(d.wake).toContain('o/r workflow run 5 finished: success after 5 min')
})

test('read errors are retried, then end in a wake, never a silent wait', () => {
  let w: any = W
  for (let i = 1; i < MAX_ERRORS; i++) {
    const d = decide(w, { kind: 'error', detail: 'x' }, T0)
    expect(d.done).toBe(false)
    w = { ...w, ...d.patch }
  }
  const last = decide(w, { kind: 'error', detail: 'x' }, T0)
  expect(last.done).toBe(true)
  expect(last.wake).toContain('Check it yourself now')
})

test('end to end: a start is watched and reported by `watching`; a cancel is not', async ($: any, on: any) => {
  on('clock.now', () => ({ value: T0 }) as any)
  on('clock.every', () => ({ value: undefined }) as any)
  on('tool.call', { tool: /actions_run_trigger$/ }, () => ({ result: { content: [{ type: 'text', text: 'ok' }] } }))
  const c: any = await $.tool.call({ tool: 'mcp__github__actions_run_trigger', method: 'cancel_workflow_run', owner: 'o', repo: 'r', run_id: 3 })
  expect(c.context).toBeUndefined()
  const r: any = await $.tool.call({ tool: 'mcp__github__actions_run_trigger', method: 'run_workflow', owner: 'o', repo: 'r', workflow_id: 'db-test.yml', ref: 'main' })
  expect(String(r.context ?? '')).toContain('[mod:workflow-run-watch] Watching o/r db-test.yml')
  const w: any = await $.tool.call({ tool: 'mcp__workflow-run-watch__watching' })
  expect(JSON.parse(String(w.result))).toEqual({ active: ['run:o/r:db-test.yml'], finished: [] })
})
