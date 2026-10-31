import { test, expect } from 'claude-code/testing'

import { ASK_USER_QUESTION, DENY, signalOf, verdictFor } from '../hooks/logic'

const reply = (ccr: unknown, isError = false) => ({ isError, content: [{ type: 'text', text: JSON.stringify({ ccr }) }] })
const CHILD = reply({ id: 'session_01Child', parent_session_id: 'session_01Parent', origin: 'claude_code_mcp_seed' })
const TOP = reply({ id: 'session_01Top', origin: 'web' }) // no parent_session_id key: a person started it

test('a session with a parent_session_id is a child and is denied with the guidance', () => {
  expect(signalOf(CHILD)).toEqual({ kind: 'child', parent: 'session_01Parent' })
  const v: any = verdictFor(signalOf(CHILD))
  expect(v.deny).toBe(DENY)
  expect(DENY).toMatch(/^\[mod:no-ask-in-child\] No human is watching/)
  expect(DENY).toContain('recommend')
  expect(DENY).toContain('NEEDS YOU')
})

test('a top-level session (no parent, null or empty parent) is allowed', () => {
  for (const r of [TOP, reply({ id: 's', parent_session_id: null }), reply({ id: 's', parent_session_id: '' }), reply({ id: 's', parent_session_id: '  ' })]) {
    const sig = signalOf(r)
    expect(sig.kind).toBe('top')
    expect(verdictFor(sig)).toBeUndefined()
  }
})

test('an unreadable signal is allowed, with a reason', () => {
  const bad: unknown[] = [undefined, null, 'x', { isError: true, content: [] }, { content: [] }, { content: [{ type: 'text', text: 'not json' }] },
    { content: [{ type: 'text', text: '{bad json}' }] }, reply({}), reply({ parent_session_id: 'session_01P' }), reply({ id: 's', parent_session_id: 7 }),
    { content: [{ type: 'text', text: JSON.stringify({ other: 1 }) }] }]
  for (const r of bad) {
    const sig = signalOf(r)
    expect(sig.kind).toBe('unreadable')
    expect(typeof (sig as any).reason).toBe('string')
    expect((sig as any).reason.length).toBeGreaterThan(0)
    expect(verdictFor(sig)).toBeUndefined()
  }
})

test('prose braces or another object around the session object do not hide it (CI reviewer, LC-1968)', () => {
  const real = '{"ccr":{"id":"session_01Child","parent_session_id":"session_01Parent"}}'
  for (const text of [`Note: use {id} form. ${real}`, `{"meta":1}${real}`, `${real} trailing {x`, `{"a":"}{"} ${real}`]) {
    expect(signalOf({ content: [{ type: 'text', text }] }).kind).toBe('child')
  }
  const decoy = '{"ccr":{"id":"decoy"}}'
  // Two session objects: we cannot tell which is ours, so the signal is unreadable (allow), in either order and
  // whichever one names a parent. Never a guess that could block a person (CI reviewer, rounds 2-4).
  const decoyParent = '{"ccr":{"id":"decoy","parent_session_id":"session_01P"}}'
  const top = '{"ccr":{"id":"session_01Top"}}'
  for (const text of [decoy + real, real + decoy, decoyParent + top, top + decoyParent]) {
    const sig: any = signalOf({ content: [{ type: 'text', text }] })
    expect(sig.kind).toBe('unreadable')
    expect(sig.reason).toContain('several session objects')
  }
  expect(signalOf({ content: [{ type: 'text', text: '{'.repeat(5000) }] }).kind).toBe('unreadable') // unclosed braces end
  expect(signalOf({ content: [{ type: 'text', text: 'Note {id} {"meta":1}' }] }).kind).toBe('unreadable') // no ccr.id anywhere
})

function world(on: any, mcp: (e: any) => any) {
  const toasts: string[] = [], reached: string[] = [], logs: string[] = [], calls: string[] = []
  on('ui.toast', (_$: any, e: any) => { toasts.push(e.text); return { value: undefined } as any })
  on('ui.log', (_$: any, e: any) => { logs.push(String(e.text ?? e.message ?? JSON.stringify(e))); return { value: undefined } as any })
  on('mcp.call', (_$: any, e: any) => { calls.push(e.tool ?? e.name); return { value: mcp(e) } as any })
  on('tool.call', (_$: any, e: any) => { reached.push(e.tool); return { result: 'ok', text: 'ok' } as any })
  return { toasts, reached, logs, calls }
}

test('end to end: a child session is denied before the tool runs, and toasted', async ($: any, on: any) => {
  const w = world(on, () => CHILD)
  const r: any = await $.tool.call({ tool: ASK_USER_QUESTION, questions: [] })
  expect(String(r.deny ?? r.text)).toContain('[mod:no-ask-in-child]')
  expect(w.reached.length).toBe(0)
  expect(w.toasts[0]).toContain('No human is watching')
})

test('end to end: a top-level session reaches the tool, no toast', async ($: any, on: any) => {
  const w = world(on, () => TOP)
  await $.tool.call({ tool: ASK_USER_QUESTION, questions: [] })
  expect(w.reached).toEqual([ASK_USER_QUESTION])
  expect(w.toasts.length).toBe(0)
})

test('end to end: an unreadable signal (get_session throws) allows and logs the reason', async ($: any, on: any) => {
  const w = world(on, () => { throw new Error('connector down') })
  await $.tool.call({ tool: ASK_USER_QUESTION, questions: [] })
  expect(w.reached).toEqual([ASK_USER_QUESTION])
  expect(w.toasts.length).toBe(0)
  expect(w.logs.join('\n')).toMatch(/no-ask-in-child: allowed AskUserQuestion, signal unreadable/)
})

test('an unreadable answer is retried next time; a readable one is asked once', async ($: any, on: any) => {
  let n = 0
  const w = world(on, () => (++n === 1 ? { isError: true, content: [] } : CHILD))
  await $.tool.call({ tool: ASK_USER_QUESTION, questions: [] }) // unreadable: allowed
  expect(w.reached.length).toBe(1)
  await $.tool.call({ tool: ASK_USER_QUESTION, questions: [] }).catch(() => undefined) // now a child: denied
  await $.tool.call({ tool: ASK_USER_QUESTION, questions: [] }).catch(() => undefined) // cached
  expect(w.reached.length).toBe(1)
  expect(w.calls.length).toBe(2)
})

test('other tools never trigger the lookup', async ($: any, on: any) => {
  const w = world(on, () => CHILD)
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  await $.tool.call({ tool: 'mcp__claude-code-remote__get_session' })
  expect(w.reached.length).toBe(2)
  expect(w.calls.length).toBe(0)
})
