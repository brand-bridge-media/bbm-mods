import { test, expect, mock } from 'claude-code/testing'

// LC-1711 callout convention. fleet-tracker never denies or asks; its refusal path is a note on a
// session that is not tracked (nothing saved) and its changes are track / note / untrack. Each one
// carries `[mod:fleet-tracker]` in the tool result AND fires a toast naming the mod and the reason.

function setup(on: any) {
  mock.store(on)
  mock.clock(on, { now: Date.parse('2026-10-07T12:00:00Z') })
  const toasts: string[] = []
  on('ui.toast', (_$: any, e: any) => { toasts.push(e.text); return { value: undefined } as any })
  on('mcp.call', () => ({ value: {
    isError: false,
    content: [{ type: 'text', text: JSON.stringify({ ccr: { status_bucket: 'SESSION_STATUS_BUCKET_WORKING', session_status: 'SESSION_STATUS_RUNNING', task_summary: 'x', updated_at: '2026-10-07T11:58:00Z' } }) }],
  } }) as any)
  return toasts
}

test('a note on an untracked session is refused with the prefix and a toast', async ($, on) => {
  const toasts = setup(on)
  const out: any = await $.tool.call({ tool: 'mcp__fleet-tracker__note', session_id: 'session_none', note: 'hello' } as any)
  expect(JSON.stringify(out)).toContain('[mod:fleet-tracker] Not tracked: session_none')
  expect(toasts.length).toBe(1)
  expect(toasts[0]).toContain('[mod:fleet-tracker]')
  expect(toasts[0]).toContain('Not tracked')
})

test('track, flag and untrack each carry the prefix and a toast', async ($, on) => {
  const toasts = setup(on)
  const track: any = await $.tool.call({ tool: 'mcp__fleet-tracker__track', session_id: 'session_x', ticket: 'LC-1', label: 'demo' } as any)
  expect(JSON.stringify(track)).toContain('[mod:fleet-tracker] Tracking session_x')
  const flag: any = await $.tool.call({ tool: 'mcp__fleet-tracker__note', session_id: 'session_x', note: 'merge approval', needs_you: true } as any)
  expect(JSON.stringify(flag)).toContain('[mod:fleet-tracker] Needs you: merge approval')
  const gone: any = await $.tool.call({ tool: 'mcp__fleet-tracker__untrack', session_id: 'session_x', keep_reason: 'test' } as any)
  expect(JSON.stringify(gone)).toContain('[mod:fleet-tracker] Untracked session_x WITHOUT archiving')
  expect(toasts.filter(t => t.includes('[mod:fleet-tracker]')).length).toBe(3)
  expect(toasts.join(' ')).toContain('merge approval')
})

test('a routine note is prefixed for the model but stays silent for the operator', async ($, on) => {
  const toasts = setup(on)
  await $.tool.call({ tool: 'mcp__fleet-tracker__track', session_id: 'session_y', ticket: 'LC-2', label: 'demo' } as any)
  const before = toasts.length
  const out: any = await $.tool.call({ tool: 'mcp__fleet-tracker__note', session_id: 'session_y', note: 'halfway' } as any)
  expect(JSON.stringify(out)).toContain('[mod:fleet-tracker] Noted on session_y')
  expect(toasts.length).toBe(before)
  const clear: any = await $.tool.call({ tool: 'mcp__fleet-tracker__note', session_id: 'session_y', note: 'ok now', needs_you: false } as any)
  expect(JSON.stringify(clear)).toContain('Noted on session_y')
  expect(toasts.length).toBe(before)
})
