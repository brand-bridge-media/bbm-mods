import { expect, mock } from 'claude-code/testing'
import { test } from './slow'
import { CHILD_NOTE, withChildTools } from '../hooks/logic'

// LC-1843: children stalled on unwatched permission prompts for send_message / send_later.
// LC-1917: the platform drops any extra_allowed_tools grant, so none is attempted; the note is the control.

const T0 = Date.parse('2026-10-19T19:00:00Z')

test('create_session reaches the platform with the child note appended and the input otherwise untouched', async ($, on) => {
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
  expect(seen.extra_allowed_tools).toEqual(['Bash(npm test)']) // passed through, nothing merged in
  expect(seen.append_system_prompt).toBe(`Be terse.\n\n${CHILD_NOTE}`) // caller's text kept, note appended
  expect(seen.title).toBe('LC-1 x') // the rest of the input is untouched
  expect(seen.prompt).toBe('go')
  // Let the auto-track poll settle inside the test, then clean up the row it added.
  expect(JSON.stringify(await $.tool.call({ tool: 'mcp__fleet-tracker__status' } as any))).toContain('LC-1')
  await $.tool.call({ tool: 'mcp__fleet-tracker__untrack', session_id: 'session_01ChildToolsChildTools0', keep_reason: 'test' } as any)
})

test('withChildTools no longer touches extra_allowed_tools', () => {
  expect('extra_allowed_tools' in withChildTools({})).toBe(false)
  expect((withChildTools({ extra_allowed_tools: ['Read'] } as any) as any).extra_allowed_tools).toEqual(['Read'])
})

test('the child note is appended once and tells the child not to call remote tools', () => {
  expect(withChildTools({}).append_system_prompt).toBe(CHILD_NOTE)
  const once = withChildTools({}) as any
  expect(withChildTools(once).append_system_prompt).toBe(CHILD_NOTE) // re-wrapping does not duplicate
  expect(withChildTools({ append_system_prompt: 42 as any }).append_system_prompt).toBe(CHILD_NOTE)
  for (const t of ['send_message', 'send_later']) expect(CHILD_NOTE).toContain(t)
  expect(CHILD_NOTE).toContain('Do NOT call')
})

test('the child note carves out exactly one exception: confirm_repository_trust (LC-1917)', () => {
  expect(CHILD_NOTE).toContain('[repository_trust_required]')
  expect(CHILD_NOTE).toContain('mcp__claude-code-remote__confirm_repository_trust')
  expect(CHILD_NOTE).toContain('content_digest')
  expect(CHILD_NOTE).toContain('`NEEDS YOU: repository trust`')
  expect(CHILD_NOTE).not.toContain('NEEDS STAN')
})
