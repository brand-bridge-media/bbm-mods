import { expect, mock } from 'claude-code/testing'
import { test } from './slow'

// LC-2043: a transition found long after it happened (the in-process timer stopped while the session idled)
// is delivered with the child's own time, not the time of the late poll.
const T0 = Date.parse('2026-10-15T12:00:00Z')
const iso = (ms: number) => new Date(ms).toISOString()

test('a child that entered NEEDS_INPUT 97 minutes ago says so, with its real time', async ($: any, on: any) => {
  mock.store(on)
  const clock = mock.clock(on, { now: T0 })
  const prompts: string[] = []
  on('ui.toast', () => ({ value: undefined }) as any)
  on('prompt.submit', (_$: any, e: any) => { prompts.push(e.text); return { text: e.text } as any })
  on('mcp.call', () => ({ value: { isError: false, content: [{ type: 'text', text: JSON.stringify({ ccr: {
    status_bucket: 'SESSION_STATUS_BUCKET_NEEDS_INPUT', session_status: 'SESSION_STATUS_IDLE', task_summary: 'asked a question',
    updated_at: iso(T0 - 97 * 60_000), external_metadata: { usage: { cost_usd: 0.1 } } } }) }] } }) as any)
  await $.tool.call({ tool: 'mcp__fleet-tracker__track', session_id: 'session_s', ticket: 'LC-2015', label: 'track a' } as any)
  await clock.advance(91_000)
  for (let i = 0; i < 20 && prompts.length === 0; i++) await new Promise(r => setTimeout(r, 10))
  expect(prompts[0]).toContain('LC-2015')
  expect(prompts[0]).toContain('NEEDS_INPUT')
  expect(prompts[0]).toContain('(event at 10:23Z, delivered 97 min late)')
})

test('a transition seen on time carries no note', async ($: any, on: any) => {
  mock.store(on)
  const clock = mock.clock(on, { now: T0 })
  const prompts: string[] = []
  on('ui.toast', () => ({ value: undefined }) as any)
  on('prompt.submit', (_$: any, e: any) => { prompts.push(e.text); return { text: e.text } as any })
  on('mcp.call', () => ({ value: { isError: false, content: [{ type: 'text', text: JSON.stringify({ ccr: {
    status_bucket: 'SESSION_STATUS_BUCKET_NEEDS_INPUT', session_status: 'SESSION_STATUS_IDLE', task_summary: 'asked a question',
    updated_at: iso(T0 - 30_000), external_metadata: { usage: { cost_usd: 0.1 } } } }) }] } }) as any)
  await $.tool.call({ tool: 'mcp__fleet-tracker__track', session_id: 'session_s', ticket: 'LC-2015', label: 'track a' } as any)
  await clock.advance(91_000)
  for (let i = 0; i < 20 && prompts.length === 0; i++) await new Promise(r => setTimeout(r, 10))
  expect(prompts[0]).toContain('NEEDS_INPUT')
  expect(prompts[0]).not.toContain('min late')
})
