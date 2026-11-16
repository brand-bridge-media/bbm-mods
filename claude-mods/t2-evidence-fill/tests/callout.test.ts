import { test, expect } from 'claude-code/testing'

// Callout convention (claude-mods/README.md): a refusal carries the [mod:t2-evidence-fill] prefix for the model AND a
// toast for the operator; an untouched call carries neither.

function world(on: any, fill: unknown) {
  const toasts: string[] = []
  on('ui.toast', (_$: any, e: any) => { toasts.push(e.text); return { value: undefined } as any })
  on('process.run', () => ({ value: { exitCode: 0, stdout: JSON.stringify(fill), stderr: '' } }) as any)
  on('tool.call', () => ({ result: 'ok', text: 'ok' }) as any)
  return toasts
}
const CREATE = { tool: 'mcp__github__create_pull_request', owner: 'o', repo: 'r', head: 'h', base: 'main', title: 't', body: 'B' } as any

test('a refusal is prefixed and toasted', async ($: any, on: any) => {
  const toasts = world(on, { applicable: true, tier: 'tier:T2', body: 'B', changed: [], missing: [['Tests', 'empty', 'x']], deny: true })
  const r: any = await $.tool.call(CREATE)
  expect(String(r.deny).startsWith('[mod:t2-evidence-fill] ')).toBe(true)
  expect(toasts.length).toBe(1)
  expect(toasts[0]!.startsWith('[mod:t2-evidence-fill] ')).toBe(true)
})

test('an untouched call carries neither', async ($: any, on: any) => {
  const toasts = world(on, { applicable: false })
  const r: any = await $.tool.call(CREATE)
  expect(r.deny).toBeUndefined()
  expect(r.context ?? []).toEqual([])
  expect(toasts).toEqual([])
})
