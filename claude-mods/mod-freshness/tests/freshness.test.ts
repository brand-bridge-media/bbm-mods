import { test, expect, mock } from 'claude-code/testing'

import { CHECK_MS, newlyStale, notCheckedText, wakeText } from '../hooks/logic'

// The comparison is tested by mod-freshness.py --selftest (claude-mods.yml runs it). These tests
// pin what the mod says about its answer and the plumbing around it.

const T0 = Date.parse('2026-10-22T18:00:00Z')
const SNAP = { 'fleet-tracker': 'aaa', 'jira-closer': 'bbb' }

test('each stale mod is reported once; a newly stale one is reported again', () => {
  expect(newlyStale({ stale: ['fleet-tracker'] }, [])).toEqual(['fleet-tracker'])
  expect(newlyStale({ stale: ['fleet-tracker'] }, ['fleet-tracker'])).toEqual([])
  expect(newlyStale({ stale: ['fleet-tracker', 'jira-closer'] }, ['fleet-tracker'])).toEqual(['jira-closer'])
  expect(newlyStale(undefined, [])).toEqual([])
})

test('the wake names the mods and the mirror head, and routes to the operator in chat', () => {
  const t = wakeText(['fleet-tracker'], { mirror: 'Sync from bbm-infrastructure@abc (2026-10-22)' })
  expect(t).toMatch(/^\[mod:mod-freshness\] This session is running out-of-date mod code: fleet-tracker\./)
  expect(t).toContain('Sync from bbm-infrastructure@abc')
  expect(t).toContain('NEEDS YOU')
  expect(t).not.toContain('PushNotification')
})

test('NOT CHECKED is said, never silently read as fresh', () => {
  expect(notCheckedText({ stale: [], fresh: ['x'], not_checked: {} })).toBeUndefined()
  expect(notCheckedText({ not_checked: { '*': 'mirror unreadable: boom' } })).toContain('NOT CHECKED: mirror unreadable')
  expect(notCheckedText(undefined)).toContain('NOT CHECKED')
})

function world(on: any, verdicts: unknown[]) {
  const clock = mock.clock(on, { now: T0 })
  const stdins: any[] = []
  const prompts: string[] = []
  const toasts: string[] = []
  on('env.get', (_$: any, e: any) => ({ value: e.name === 'CLAUDE_CODE_PLUGIN_DIRS' ? '/infra/claude-mods/fleet-tracker' : undefined }) as any)
  on('process.run', (_$: any, e: any) => {
    const p = JSON.parse(String(e.init?.stdin ?? '{}'))
    stdins.push(p)
    const out = p.mode === 'snapshot' ? { loaded: SNAP } : verdicts.shift()
    return { value: { exitCode: 0, stdout: JSON.stringify(out ?? {}), stderr: '' } } as any
  })
  on('ui.toast', (_$: any, e: any) => { toasts.push(e.text); return { value: undefined } as any })
  on('prompt.submit', (_$: any, e: any) => { prompts.push(e.text); return { text: e.text } as any })
  on('turn.complete', () => ({ text: 'done' }) as any)
  on('session.start', (() => ({ cwd: '/tmp' })) as any)
  return { clock, stdins, prompts, toasts }
}

test('end to end: snapshot at start, hourly check, one wake per newly stale mod', async ($: any, on: any) => {
  const w = world(on, [
    { stale: [], fresh: ['fleet-tracker', 'jira-closer'], not_checked: {} },
    { stale: ['fleet-tracker'], fresh: ['jira-closer'], not_checked: {}, mirror: 'Sync from bbm-infrastructure@def' },
    { stale: ['fleet-tracker'], fresh: ['jira-closer'], not_checked: {} },
  ])
  await $.session.start({ source: 'startup', cwd: '/tmp' } as any)
  expect(w.stdins[0]).toEqual({ mode: 'snapshot', plugin_dirs: '/infra/claude-mods/fleet-tracker' })

  await w.clock.advance(CHECK_MS) // fresh: nothing said
  expect(w.stdins[1]).toEqual({ mode: 'check', loaded: SNAP })
  expect(w.prompts).toEqual([])

  await w.clock.advance(CHECK_MS) // fleet-tracker changed upstream: one wake
  await ($ as any).turn.complete({ reason: 'answer', answer: 'done' })
  await w.clock.advance(1)
  expect(w.prompts.join('\n')).toContain('out-of-date mod code: fleet-tracker')

  await w.clock.advance(CHECK_MS) // still stale: not repeated
  await w.clock.advance(1)
  expect(w.prompts.filter(p => p.includes('fleet-tracker')).length).toBe(1)
})

test('a check that cannot run toasts NOT CHECKED once and wakes nobody', async ($: any, on: any) => {
  const nc = { stale: [], fresh: [], not_checked: { '*': 'mirror unreadable: offline' } }
  const w = world(on, [nc, nc])
  await $.session.start({ source: 'startup', cwd: '/tmp' } as any)
  await w.clock.advance(CHECK_MS)
  await w.clock.advance(CHECK_MS)
  expect(w.prompts).toEqual([])
  expect(w.toasts.filter(t => t.includes('NOT CHECKED')).length).toBe(1)
})
