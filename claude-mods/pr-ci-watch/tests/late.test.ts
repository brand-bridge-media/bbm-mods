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

import { decide, finishedAt, LONG_MS, NO_CHECKS_MS, parseCheckRuns, parsePr } from '../hooks/logic'

const T0 = Date.parse('2026-11-03T19:00:00Z')
const SHA = '76aa1f236a767211858f749205c16c66f01df9d8'
const W = { owner: 'acme', repo: 'infra', number: 7, server: 'github', sha: SHA, startedAt: T0 }

test('merge and check-run times are read from the replies', () => {
  expect(parsePr(JSON.stringify({ state: 'closed', merged_at: '2026-11-03T19:05:00Z', head: { sha: SHA } }))?.mergedAt).toBe(T0 + 5 * MIN)
  expect(parsePr(JSON.stringify({ state: 'open', head: { sha: SHA } }))).not.toHaveProperty('mergedAt')
  const runs = parseCheckRuns(JSON.stringify({ check_runs: [
    { name: 'a', status: 'completed', conclusion: 'success', completed_at: '2026-11-03T19:10:00Z' },
    { name: 'b', status: 'completed', conclusion: 'success', completed_at: '2026-11-03T19:12:00Z' },
    { name: 'c', status: 'completed', conclusion: 'success' }] }))!
  expect(finishedAt(runs)).toBe(T0 + 12 * MIN)
  expect(finishedAt([{ name: 'c', status: 'completed', conclusion: 'success' }])).toBeUndefined()
})

test('each wake carries the time of its real event', () => {
  const pr = (runs: any[], extra = {}) => ({ kind: 'pr' as const, state: 'open', merged: false, headSha: SHA, runs, ...extra })
  const done = [{ name: 'a', status: 'completed', conclusion: 'success', completedAt: T0 + 9 * MIN }]
  const w = { ...W, lastSig: `${SHA}|a=success` }
  expect(decide(w, pr(done), T0 + 120 * MIN).eventAt).toBe(T0 + 9 * MIN)
  expect(decide(W, pr([]), T0 + 120 * MIN).eventAt).toBe(T0 + NO_CHECKS_MS)
  expect(decide(W, { ...pr([]), state: 'closed', merged: true, mergedAt: T0 + 4 * MIN } as any, T0 + 120 * MIN).eventAt).toBe(T0 + 4 * MIN)
  expect(decide(W, pr([{ name: 'a', status: 'in_progress', conclusion: null }]), T0 + LONG_MS + 30 * MIN).eventAt).toBe(T0 + LONG_MS)
})
