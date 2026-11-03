import { test, expect, mock } from 'claude-code/testing'

import { decide, LONG_MS, NO_RUN_MS } from '../hooks/logic'

const T0 = Date.parse('2026-11-03T19:00:00Z')
const MIN = 60_000
const iso = (ms: number) => new Date(ms).toISOString()
const W = { owner: 'o', repo: 'r', server: 'github', workflow: 'db-test.yml', since: iso(T0 - MIN), startedAt: T0 }
const fin = { id: 7, status: 'completed', conclusion: 'success', created_at: iso(T0 + 10_000), run_started_at: iso(T0 + 10_000), updated_at: iso(T0 + 23 * MIN), html_url: 'https://x/7' }

test('each wake carries the time of its real event', () => {
  expect(decide(W, { kind: 'runs', runs: [fin] }, T0 + 120 * MIN).eventAt).toBe(T0 + 23 * MIN)
  expect(decide(W, { kind: 'runs', runs: [] }, T0 + NO_RUN_MS + MIN).eventAt).toBe(T0 + NO_RUN_MS)
  expect(decide(W, { kind: 'runs', runs: [{ ...fin, status: 'in_progress', conclusion: null }] }, T0 + LONG_MS + 30 * MIN).eventAt).toBe(T0 + LONG_MS)
})

test('end to end: a finish found 97 minutes late is delivered with its real time', async ($: any, on: any) => {
  const clock = mock.clock(on, { now: T0 })
  const prompts: string[] = []
  on('ui.toast', () => ({ value: undefined }) as any)
  on('prompt.submit', (_$: any, e: any) => { prompts.push(e.text); return { text: e.text } as any })
  // The poll sees the run still going until the flag flips: the timer was not running when it finished.
  let seen = false
  const going = { ...fin, status: 'in_progress', conclusion: null }
  on('mcp.call', () => ({ value: { isError: false, content: [{ type: 'text', text: JSON.stringify([seen ? fin : going]) }] } }) as any)
  on('tool.call', { tool: /actions_run_trigger$/ }, () => ({ result: { content: [{ type: 'text', text: 'ok' }] } }))
  await $.tool.call({ tool: 'mcp__github__actions_run_trigger', method: 'run_workflow', owner: 'o', repo: 'r', workflow_id: 'db-test.yml', ref: 'main' })
  // The session idled: the first poll after the start comes 97 min after the run actually finished (T0 + 23 min).
  await clock.advance(119 * MIN)
  expect(prompts.length).toBe(1) // only the 90-minute "still running" warning so far
  seen = true
  await clock.advance(MIN)
  for (let i = 0; i < 20 && prompts.length < 2; i++) await new Promise(r => setTimeout(r, 10))
  expect(prompts[1]).toContain('finished: success')
  expect(prompts[1]).toContain('(event at 19:23Z, delivered 97 min late)')
  // The 90-minute warning's own event was 90 min after the start, delivered on time: no note.
  expect(prompts[0]).not.toContain('min late')
})
