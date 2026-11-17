import { test, expect } from 'claude-code/testing'

import {
  BUDGET_MS, CAUSE_TICKETS, EPIC, OWN, STAGES, WAKE_AT_MS, causeTicketFor, decide, normalisePr, occurrenceBody, operatorAsk,
  parseCheckRuns, parsePr, prNumberFrom, readReport, routeOccurrence, statusCategoryFrom, summariseRuns, timing,
} from '../hooks/logic'

const MIN = 60_000
// The real incident that started LCH-600: PR #2866 opened 15:19:18Z, still unmerged at 16:35Z.
const T0 = Date.parse('2026-11-05T15:19:18Z')
const C = { owner: 'brand-bridge-media', repo: 'bbm-infrastructure', number: 2866, server: 'github', startedAt: T0, nextWake: 0 }
const open = (extra: Record<string, unknown> = {}) => ({ kind: 'pr' as const, pr: { state: 'open', merged: false, autoMerge: true, ...extra }, runs: [
  { name: 'independent-review', status: 'queued', conclusion: null },
  { name: 'quick-checks', status: 'in_progress', conclusion: null },
  { name: 'lint', status: 'completed', conclusion: 'success' },
] })

test('under budget: no wake; over budget: one wake naming the facts and the report tool', () => {
  expect(decide(C, open(), T0 + 29 * MIN)).toEqual({ done: false, patch: { errors: 0 } })
  const d = decide(C, open(), T0 + BUDGET_MS + MIN)
  expect(d.patch!.nextWake).toBe(1)
  expect(d.wake!.startsWith(`${OWN} brand-bridge-media/bbm-infrastructure#2866 is over its time budget`)).toBe(true)
  expect(d.wake).toContain('31 min ago (budget 30 min)')
  expect(d.wake).toContain('1 queued (independent-review)')
  expect(d.wake).toContain('mcp__slowness-report__report')
  // The same threshold does not wake twice.
  expect(decide({ ...C, nextWake: 1 }, open(), T0 + 40 * MIN).wake).toBeUndefined()
})

test('one wake per PR: one PR is one occurrence', () => {
  expect(WAKE_AT_MS.length).toBe(1)
  expect(decide({ ...C, nextWake: 1 }, open(), T0 + 500 * MIN).wake).toBeUndefined()
  const d = decide(C, open(), T0 + BUDGET_MS + MIN)
  expect(d.wake).toContain('ONE occurrence comment on the ticket that owns that cause')
  expect(d.wake).toContain('never a new ticket')
})

test('merged or closed ends the clock quietly; read errors give up after five', () => {
  expect(decide(C, { kind: 'pr', pr: { state: 'closed', merged: true } }, T0 + 90 * MIN)).toEqual({ done: true })
  expect(decide(C, { kind: 'pr', pr: { state: 'closed', merged: false } }, T0 + MIN)).toEqual({ done: true })
  expect(decide(C, { kind: 'error' }, T0)).toEqual({ done: false, patch: { errors: 1 } })
  expect(decide({ ...C, errors: 4 }, { kind: 'error' }, T0)).toEqual({ done: true })
})

test('GitHub replies are read; unreadable ones are not mistaken for facts', () => {
  expect(parsePr(JSON.stringify({ state: 'open', merged: false, title: 't', auto_merge: { merge_method: 'squash' }, mergeable_state: 'blocked' })))
    .toEqual({ state: 'open', merged: false, title: 't', autoMerge: true, mergeableState: 'blocked' })
  expect(parsePr(JSON.stringify({ state: 'closed', merged_at: '2026-11-05T16:40:00Z' }))!.merged).toBe(true)
  expect(parsePr('not json')).toBeUndefined()
  expect(parsePr('{"state":""}')).toBeUndefined()
  expect(parsePr(JSON.stringify({ state: 'open', merged: false, merged_at: '' }))!.merged).toBe(false)
  expect(parsePr(JSON.stringify({ state: 'open', merged: false, merged_at: null }))!.merged).toBe(false)
  expect(parseCheckRuns(JSON.stringify({ check_runs: [{ name: 'a', status: 'QUEUED', conclusion: null }] }))).toEqual([{ name: 'a', status: 'queued', conclusion: null }])
  expect(parseCheckRuns('{}')).toBeUndefined()
  expect(summariseRuns(undefined)).toContain('NOT CHECKED')
  expect(summariseRuns([])).toContain('none registered')
  expect(prNumberFrom('{"number": 2866}')).toBe(2866)
  expect(prNumberFrom('see https://github.com/a/b/pull/12')).toBe(12)
})

test('a report needs every field and a known stage', () => {
  const ok = { subject: 'record 7 picks', stage: 'runner_queue', cause: 'c', evidence: 'e', fix: 'f' }
  expect(readReport({ ...ok, cause_ticket: 'lc-2076' }, 'session')).toMatchObject({ causeTicket: 'LC-2076' })
  expect(readReport({ ...ok, cause_ticket: 'JIRA-1' }, 'session')).toContain('cause_ticket must be')
  expect(readReport({ ...ok, cause: ' ' }, 'session')).toContain('missing cause')
  expect(readReport({ ...ok, stage: 'vibes' }, 'session')).toContain('stage must be one of')
  const r = readReport({ ...ok, pr: '#2866', waited_minutes: 76.4, still_waiting: true }, 'operator')
  expect(typeof r).toBe('object')
  expect((r as any).waitedMinutes).toBe(76)
  expect((r as any).source).toBe('operator')
})

test('PR references of every shape resolve to one key', () => {
  const d = { owner: 'brand-bridge-media', repo: 'bbm-infrastructure' }
  expect(normalisePr('brand-bridge-media/bbm-infrastructure#2866')).toBe('brand-bridge-media/bbm-infrastructure#2866')
  expect(normalisePr('https://github.com/brand-bridge-media/bbm-infrastructure/pull/2866')).toBe('brand-bridge-media/bbm-infrastructure#2866')
  expect(normalisePr('#2866', d)).toBe('brand-bridge-media/bbm-infrastructure#2866')
  expect(normalisePr('2866')).toBeUndefined()
  expect(normalisePr(undefined)).toBeUndefined()
})

test('every stage maps to a cause ticket; the measured clock beats the reported numbers', () => {
  for (const st of STAGES) expect(CAUSE_TICKETS[st]).toMatch(/^(LCH|LC)-\d+$/)
  // LCH-720: the open owners since LCH-603, LCH-614 and LCH-595 closed (2026-11-15/16).
  expect(CAUSE_TICKETS.runner_queue).toBe('LCH-618')
  expect(CAUSE_TICKETS.train_wait).toBe('LCH-697')
  expect(CAUSE_TICKETS.train_recheck).toBe('LCH-697')
  expect(CAUSE_TICKETS.reviewer).toBe(EPIC)
  for (const closed of ['LCH-603', 'LCH-614', 'LCH-595']) expect(Object.values(CAUSE_TICKETS)).not.toContain(closed)
  expect(CAUSE_TICKETS.other).toBe(EPIC)
  const r = readReport({ subject: 'record 7 picks', stage: 'runner_queue', cause: 'queue', evidence: 'ev', fix: 'fx', waited_minutes: 5 }, 'auto') as any
  expect(causeTicketFor(r)).toBe('LCH-618')
  expect(causeTicketFor({ ...r, causeTicket: 'LC-2076' })).toBe('LC-2076')
  const now = T0 + 76 * MIN
  expect(timing(r, C, now)).toEqual({ startedAt: T0, waited: 76, measured: true })
  expect(timing(r, undefined, now)).toEqual({ waited: 5, measured: false })
  const body = occurrenceBody({ ...r, pr: 'brand-bridge-media/bbm-infrastructure#2866' }, timing(r, C, now), now)
  expect(body.split('\n')[0]).toBe('SLOWNESS OCCURRENCE 2026-11-05T16:35Z | stage runner_queue | waited 76 min (budget 30) | brand-bridge-media/bbm-infrastructure#2866 | auto: PR passed its time budget')
  for (const line of ['- Change: record 7 picks', '- Cause: queue', '- Evidence: ev', '- Fix / note: fx']) expect(body).toContain(line)
})

test('/slow quotes the operator and never asks for a new ticket', () => {
  expect(operatorAsk('7 picks stuck')).toContain('"7 picks stuck"')
  expect(operatorAsk('')).toContain('not described')
  expect(operatorAsk('x')).toContain('never a new ticket')
})

test('LCH-720: a closed cause owner sends the occurrence to the epic, with a note; open or unreadable keeps the owner', () => {
  expect(routeOccurrence('LCH-618', 'indeterminate')).toEqual({ ticket: 'LCH-618' })
  expect(routeOccurrence('LCH-618', 'new')).toEqual({ ticket: 'LCH-618' })
  const closed = routeOccurrence('LCH-603', 'done')
  expect(closed.ticket).toBe(EPIC)
  expect(closed.note).toContain('cause owner LCH-603 is closed')
  expect(closed.note).toContain('CAUSE_TICKETS')
  expect(routeOccurrence('LC-2076', 'DONE').ticket).toBe(EPIC)
  const unread = routeOccurrence('LCH-618', undefined)
  expect(unread.ticket).toBe('LCH-618')
  expect(unread.note).toContain('NOT CHECKED')
  expect(routeOccurrence(EPIC, undefined)).toEqual({ ticket: EPIC })
  // The real getJiraIssue reply shape (issues.nodes[0]) and a bare issue both read; junk does not.
  const done = { fields: { status: { statusCategory: { key: 'done' } } } }
  expect(statusCategoryFrom(JSON.stringify({ issues: { nodes: [done] } }))).toBe('done')
  expect(statusCategoryFrom(JSON.stringify(done))).toBe('done')
  expect(statusCategoryFrom('not json')).toBeUndefined()
  expect(statusCategoryFrom(undefined)).toBeUndefined()
  expect(statusCategoryFrom('{"fields":{"status":{}}}')).toBeUndefined()
  // The note travels in the comment; without one the body is unchanged.
  const r = readReport({ subject: 's', stage: 'runner_queue', cause: 'c', evidence: 'e', fix: 'f' }, 'session') as any
  const now = T0 + 40 * MIN
  expect(occurrenceBody(r, timing(r, C, now), now, closed.note)).toContain('- Routing: cause owner LCH-603 is closed')
  expect(occurrenceBody(r, timing(r, C, now), now)).not.toContain('Routing')
})
