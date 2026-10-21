import { test, expect, mock } from 'claude-code/testing'

// Tracking a session puts a row on the dashboard, filled from get_session;
// a WORKING session never flags the operator.
test('track adds a row filled from get_session', async ($, on) => {
  mock.store(on)
  mock.clock(on, { now: Date.parse('2026-10-07T12:00:00Z') })
  on('mcp.call', () => ({ value: {
    isError: false,
    content: [{ type: 'text', text: JSON.stringify({ ccr: {
      status_bucket: 'SESSION_STATUS_BUCKET_WORKING', session_status: 'SESSION_STATUS_RUNNING',
      task_summary: 'running tests', updated_at: '2026-10-07T11:58:00Z',
      external_metadata: { usage: { cost_usd: 0.42 } } } }) }],
  } }) as any)
  await $.tool.call({ tool: 'mcp__fleet-tracker__track', session_id: 'session_x', ticket: 'LC-1', label: 'demo' } as any)
  const out: any = await $.tool.call({ tool: 'mcp__fleet-tracker__status' } as any)
  const text = JSON.stringify(out)
  expect(text).toContain('LC-1')
  expect(text).toContain('WORKING')
  expect(text).not.toContain('!!')
})
