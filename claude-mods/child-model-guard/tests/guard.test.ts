import { test, expect } from 'claude-code/testing'

import { NAME_MODEL, TOP_TIER_ASK, verdictFor } from '../hooks/logic'

const CS = 'mcp__claude-code-remote__create_session'

test('missing, empty and whitespace model are denied with the routing text', () => {
  for (const input of [{ prompt: 'x' }, { model: '', prompt: 'x' }, { model: '   ', prompt: 'x' }, { model: 7, prompt: 'x' }, {}]) {
    expect(verdictFor(input as any)).toEqual({ deny: NAME_MODEL })
  }
  expect(NAME_MODEL).toMatch(/^\[mod:child-model-guard\] Name the child's model\./)
  expect(NAME_MODEL).toContain('haiku for reading/watching')
  expect(NAME_MODEL).toContain('~3x the cost')
})

test('haiku and sonnet are allowed silently, even with a prompt that says nothing', () => {
  for (const model of ['haiku', 'claude-haiku-5-5', 'sonnet', 'claude-sonnet-5-5']) {
    expect(verdictFor({ model, prompt: 'build it' })).toBeUndefined()
  }
})

test('opus without the phrase asks; fable asks; case-insensitive on the model id', () => {
  for (const model of ['opus', 'claude-opus-5-5', 'CLAUDE-OPUS-5', 'claude-fable-5-1', 'Fable']) {
    expect(verdictFor({ model, prompt: 'build it' })).toEqual({ ask: TOP_TIER_ASK })
  }
  expect(verdictFor({ model: 'opus' })).toEqual({ ask: TOP_TIER_ASK }) // no prompt at all
})

test('opus or fable with the phrase "design judgment" (any case) is allowed', () => {
  expect(verdictFor({ model: 'claude-opus-5-5', prompt: 'This needs a Design Judgment on the schema.' })).toBeUndefined()
  expect(verdictFor({ model: 'fable', prompt: 'design judgment: pick one' })).toBeUndefined()
  expect(verdictFor({ model: 'opus', prompt: 'design-judgment' })).toEqual({ ask: TOP_TIER_ASK }) // exact phrase only
})

function world(on: any) {
  const toasts: string[] = []
  const reached: string[] = []
  on('ui.toast', (_$: any, e: any) => { toasts.push(e.text); return { value: undefined } as any })
  on('tool.call', (_$: any, e: any) => { reached.push(e.tool); return { result: 'ok', text: 'ok' } as any })
  return { toasts, reached }
}

test('a missing model is denied before the tool runs, and toasted', async ($: any, on: any) => {
  const w = world(on)
  const r: any = await $.tool.call({ tool: CS, title: 'LC-1 x', prompt: 'go' })
  expect(String(r.deny ?? r.text)).toContain('[mod:child-model-guard] Name the child')
  expect(w.reached.length).toBe(0)
  expect(w.toasts[0]).toContain('[mod:child-model-guard]')
})

test('a named cheap model reaches the tool with no toast', async ($: any, on: any) => {
  const w = world(on)
  await $.tool.call({ tool: CS, model: 'claude-sonnet-5-5', prompt: 'go' })
  expect(w.reached).toEqual([CS])
  expect(w.toasts.length).toBe(0)
})

test('opus without the phrase is toasted (the ask itself is pinned by verdictFor above)', async ($: any, on: any) => {
  const w = world(on)
  await $.tool.call({ tool: CS, model: 'claude-opus-5-5', prompt: 'go' }).catch(() => undefined)
  expect(w.toasts[0]).toContain('This child is top-tier')
})

test('opus with the phrase runs silently', async ($: any, on: any) => {
  const w = world(on)
  await $.tool.call({ tool: CS, model: 'claude-opus-5-5', prompt: 'a design judgment call' })
  expect(w.reached).toEqual([CS])
  expect(w.toasts.length).toBe(0)
})

test('other tools are ignored, including other claude-code-remote tools', async ($: any, on: any) => {
  const w = world(on)
  await $.tool.call({ tool: 'mcp__claude-code-remote__send_message', session_id: 's', message: 'x' })
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(w.reached.length).toBe(2)
  expect(w.toasts.length).toBe(0)
})
