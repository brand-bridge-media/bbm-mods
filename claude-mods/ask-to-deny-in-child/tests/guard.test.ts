import { test, expect } from 'claude-code/testing'

import { GUIDANCE, answerFor, denyText, signalOf } from '../hooks/logic'

const reply = (ccr: unknown, isError = false) => ({ isError, content: [{ type: 'text', text: JSON.stringify({ ccr }) }] })
const CHILD = reply({ id: 'session_01Child', parent_session_id: 'session_01Parent' })
const TOP = reply({ id: 'session_01Top' })
const EV = { tool_name: 'Bash', reason: '[mod:run-state] confirm this receipt write. Allow this write?' }

test('a child: the prompt becomes a deny that names the tool, the reason and the guidance', () => {
  const a: any = answerFor(signalOf(CHILD), EV)
  expect(a.decision.behavior).toBe('deny')
  expect(a.decision.message).toMatch(/^\[mod:ask-to-deny-in-child\] Permission request refused\./)
  expect(a.decision.message).toContain('Tool: Bash.')
  expect(a.decision.message).toContain('confirm this receipt write')
  expect(a.decision.message).toContain(GUIDANCE)
  expect(GUIDANCE).toContain('NEEDS YOU')
  expect(denyText(undefined)).toContain(GUIDANCE) // an event with no fields still denies with the guidance
})

test('top-level (no, null, empty parent): the prompt is left alone', () => {
  for (const r of [TOP, reply({ id: 's', parent_session_id: null }), reply({ id: 's', parent_session_id: '' }), reply({ id: 's', parent_session_id: ' ' })]) {
    expect(signalOf(r).kind).toBe('top')
    expect(answerFor(signalOf(r), EV)).toBeUndefined()
  }
})

test('unreadable: the prompt is left alone, with a reason', () => {
  for (const r of [undefined, null, 'x', { isError: true, content: [] }, { content: [] }, { content: [{ type: 'text', text: '{bad}' }] },
    reply({}), reply({ parent_session_id: 'session_01P' }), reply({ id: 's', parent_session_id: 7 })]) {
    const sig: any = signalOf(r)
    expect(sig.kind).toBe('unreadable')
    expect(sig.reason.length).toBeGreaterThan(0)
    expect(answerFor(sig, EV)).toBeUndefined()
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

function world(on: any, mcp: () => any) {
  const logs: string[] = [], toasts: string[] = []
  on('ui.toast', (_$: any, e: any) => { toasts.push(e.text); return { value: undefined } as any })
  on('ui.log', (_$: any, e: any) => { logs.push(String(e.text ?? e.message ?? JSON.stringify(e))); return { value: undefined } as any })
  on('mcp.call', () => ({ value: mcp() }) as any)
  on('classic.PermissionRequest', () => ({}) as any) // the engine beneath: no decision of its own
  return { logs, toasts }
}

test('end to end: a child session gets a deny, toasted', async ($: any, on: any) => {
  const w = world(on, () => CHILD)
  const r: any = await $.classic.PermissionRequest(EV)
  expect(JSON.stringify(r)).toContain('[mod:ask-to-deny-in-child]')
  expect(r.decision?.behavior ?? r.hookSpecificOutput?.decision?.behavior).toBe('deny')
  expect(w.toasts[0]).toContain('Permission request refused')
})

test('end to end: a top-level session is not touched', async ($: any, on: any) => {
  const w = world(on, () => TOP)
  const r: any = await $.classic.PermissionRequest(EV)
  expect(JSON.stringify(r ?? '')).not.toContain('deny')
  expect(w.toasts.length).toBe(0)
})

test('end to end: an unreadable signal leaves the prompt alone and logs why', async ($: any, on: any) => {
  const w = world(on, () => { throw new Error('connector down') })
  const r: any = await $.classic.PermissionRequest(EV)
  expect(JSON.stringify(r ?? '')).not.toContain('deny')
  expect(w.toasts.length).toBe(0)
  expect(w.logs.join('\n')).toMatch(/ask-to-deny-in-child: left the prompt alone, signal unreadable/)
})
