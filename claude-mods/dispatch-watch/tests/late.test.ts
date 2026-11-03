import { test, expect } from 'claude-code/testing'

import { LATE_MS, lateNote, stampWake } from '../hooks/logic'

// LC-2043: a wake delivered long after its event says when the event really was and how late it arrives.
const Z = Date.parse('2026-11-03T21:21:00Z')
const MIN = 60_000

test('an on-time wake is unchanged', () => {
  expect(lateNote(Z, Z)).toBe('')
  expect(lateNote(Z, Z + LATE_MS - 1)).toBe('')
  expect(stampWake({ text: 'LC-2015 entered NEEDS_INPUT', at: Z }, Z + MIN)).toBe('LC-2015 entered NEEDS_INPUT')
})

test('a late wake states the real event time and how late it is', () => {
  expect(lateNote(Z, Z + LATE_MS)).toBe(' (event at 21:21Z, delivered 5 min late)')
  expect(lateNote(Z, Z + 97 * MIN)).toBe(' (event at 21:21Z, delivered 97 min late)')
  expect(stampWake({ text: 'LC-2015 entered NEEDS_INPUT', at: Z }, Z + 97 * MIN)).toBe('LC-2015 entered NEEDS_INPUT (event at 21:21Z, delivered 97 min late)')
})

test('an event from another day carries its date', () => {
  expect(lateNote(Z, Z + 12 * 60 * MIN - 1)).toContain('(event at 21:21Z,')
  expect(lateNote(Z, Z + 12 * 60 * MIN)).toBe(' (event at 2026-11-03 21:21Z, delivered 720 min late)')
})

test('an unknown or future event time adds nothing', () => {
  expect(lateNote(NaN, Z)).toBe('')
  expect(lateNote(Z, NaN)).toBe('')
  expect(lateNote(Z + 10 * MIN, Z)).toBe('')
})

import { decide, LONG_MS, NO_RUN_MS } from '../hooks/logic'

const T0 = Date.parse('2026-11-03T19:00:00Z')
const iso = (ms: number) => new Date(ms).toISOString()
const W = { workflow: 'refresh-run.yml', server: 'Supabase', projectId: 'p', since: iso(T0 - MIN), startedAt: T0 }
const R = { id: 7, status: 'completed', conclusion: 'success', html_url: 'https://gh/7', created_at: iso(T0 + 5_000), run_started_at: iso(T0 + 10_000), updated_at: iso(T0 + 23 * MIN) }

test('each wake carries the time of its real event', () => {
  expect(decide(W as any, { kind: 'runs', runs: [R] } as any, T0 + 120 * MIN).eventAt).toBe(T0 + 23 * MIN)
  expect(decide(W as any, { kind: 'runs', runs: [] } as any, T0 + NO_RUN_MS + MIN).eventAt).toBe(T0 + NO_RUN_MS)
  expect(decide(W as any, { kind: 'runs', runs: [{ ...R, status: 'in_progress' }] } as any, T0 + LONG_MS + 30 * MIN).eventAt).toBe(T0 + LONG_MS)
})
