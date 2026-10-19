import { test, expect, mock } from 'claude-code/testing'
import { CHILD_NOTE, CHILD_REMOTE_TOOLS, withChildTools } from '../hooks/logic'

// LC-1843: children stalled on unwatched permission prompts for send_message / send_later.
// Every create_session must pre-approve them, without dropping what the caller passed.

const T0 = Date.parse('2026-10-19T19:00:00Z')

test('create_session reaches the platform with the child remote tools pre-approved', async ($, on) => {
  mock.store(on)
  mock.clock(on, { now: T0 })
  on('mcp.call', () => ({ value: { isError: false, content: [{ type: 'text', text: JSON.stringify({ ccr: {
    status_bucket: 'SESSION_STATUS_BUCKET_WORKING', updated_at: new Date(T0).toISOString() } }) }] } }) as any)
  let seen: any = null
  on('tool.call', { tool: 'mcp__claude-code-remote__create_session' }, (_$: any, e: any) => {
    seen = e
    return { result: 'created', text: '{"session_id":"session_01ChildToolsChildTools0"}' } as any
  })
  await $.tool.call({ tool: 'mcp__claude-code-remote__create_session', title: 'LC-1 x', prompt: 'go',
    extra_allowed_tools: ['Bash(npm test)'], append_system_prompt: 'Be terse.' } as any)
  expect(seen.extra_allowed_tools).toEqual(['Bash(npm test)', ...CHILD_REMOTE_TOOLS])
  expect(seen.append_system_prompt).toBe(`Be terse.\n\n${CHILD_NOTE}`) // caller's text kept, note appended
  expect(seen.title).toBe('LC-1 x') // the rest of the input is untouched
  expect(seen.prompt).toBe('go')
  // Let the auto-track poll settle inside the test, then clean up the row it added.
  expect(JSON.stringify(await $.tool.call({ tool: 'mcp__fleet-tracker__status' } as any))).toContain('LC-1')
  await $.tool.call({ tool: 'mcp__fleet-tracker__untrack', session_id: 'session_01ChildToolsChildTools0', keep_reason: 'test' } as any)
})

test('withChildTools adds the tools once, keeps caller entries first, ignores junk', () => {
  expect(withChildTools({}).extra_allowed_tools).toEqual(CHILD_REMOTE_TOOLS)
  expect(withChildTools({ extra_allowed_tools: [CHILD_REMOTE_TOOLS[1], 'Read'] }).extra_allowed_tools)
    .toEqual([CHILD_REMOTE_TOOLS[1], 'Read', CHILD_REMOTE_TOOLS[0]])
  expect(withChildTools({ extra_allowed_tools: 'Read' as any }).extra_allowed_tools).toEqual(CHILD_REMOTE_TOOLS)
  expect(withChildTools({ extra_allowed_tools: [7, null, 'Read'] as any }).extra_allowed_tools)
    .toEqual(['Read', ...CHILD_REMOTE_TOOLS])
  expect(CHILD_REMOTE_TOOLS).toContain('mcp__claude-code-remote__send_message')
  expect(CHILD_REMOTE_TOOLS).toContain('mcp__claude-code-remote__send_later')
})

test('the child note is appended once and tells the child not to call remote tools', () => {
  expect(withChildTools({}).append_system_prompt).toBe(CHILD_NOTE)
  const once = withChildTools({}) as any
  expect(withChildTools(once).append_system_prompt).toBe(CHILD_NOTE) // re-wrapping does not duplicate
  expect(withChildTools({ append_system_prompt: 42 as any }).append_system_prompt).toBe(CHILD_NOTE)
  for (const t of ['send_message', 'send_later']) expect(CHILD_NOTE).toContain(t)
  expect(CHILD_NOTE).toContain('Do NOT call')
})
