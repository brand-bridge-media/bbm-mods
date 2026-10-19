import { test, expect } from 'claude-code/testing'

// LC-1711 callout convention: a deny or ask carries `[mod:refresh-run-guard]` in the text the model
// reads AND fires a toast that names the mod and the reason. Both halves are asserted, so dropping
// either one fails here (a prefix with no toast, or a toast with a bare reason, is not a callout).

const CMS = 'mcp__webflow__data_cms_tool'
const BLOG = '65fa33419d90d967c68a0964'

const toastsOf = (on: any) => {
  const toasts: string[] = []
  on('ui.toast', (_$: any, e: any) => { toasts.push(e.text); return { value: undefined } as any })
  return toasts
}

test('a deny is prefixed [mod:refresh-run-guard] and toasts the mod and the reason', async ($, on) => {
  const toasts = toastsOf(on)
  on('tool.call', () => ({ result: { stdout: 'ok', stderr: '', interrupted: false }, text: 'ok' }) as any)
  const r: any = await $.tool.call({ tool: 'Bash', command: 'curl -X POST https://api.webflow.com/v2/sites/abc/publish -d {}' } as any)
  expect(r.deny).toMatch(/^\[mod:refresh-run-guard\] /)
  expect(r.deny).toContain('human click')
  expect(toasts.length).toBe(1)
  expect(toasts[0]).toContain('[mod:refresh-run-guard]')
  expect(toasts[0]).toContain('human click')
})

test('an ask is prefixed [mod:refresh-run-guard] and toasts the mod and the reason', async ($, on) => {
  const toasts = toastsOf(on)
  on('tool.check', () => ({ decision: 'allow' }) as any)
  const r: any = await $.tool.check({
    tool: CMS,
    input: { actions: [{ update_collection_items: { collection_id: BLOG, request: { items: [{ id: 'never-read', fieldData: { intro: '<p>new</p>' } }] } } }] },
  } as any)
  expect(r.decision).toBe('ask')
  expect(r.reason).toMatch(/^\[mod:refresh-run-guard\] /)
  expect(toasts.length).toBe(1)
  expect(toasts[0]).toContain('[mod:refresh-run-guard]')
  expect(toasts[0]).toContain(r.reason.slice('[mod:refresh-run-guard] '.length, 60))
})

test('a throwing toast does not stop a deny or an ask', async ($, on) => {
  on('ui.toast', () => { throw new Error('toast surface is gone') })
  on('tool.call', () => ({ result: { stdout: 'ran', stderr: '', interrupted: false }, text: 'ran' }) as any)
  on('tool.check', () => ({ decision: 'allow' }) as any)
  const denied: any = await $.tool.call({ tool: 'Bash', command: 'curl -X POST https://api.webflow.com/v2/sites/abc/publish -d {}' } as any)
  expect(denied.deny).toMatch(/^\[mod:refresh-run-guard\] /)
  expect(denied.deny).toContain('human click')
  const asked: any = await $.tool.check({
    tool: CMS,
    input: { actions: [{ update_collection_items: { collection_id: BLOG, request: { items: [{ id: 'never-read', fieldData: { intro: '<p>new</p>' } }] } } }] },
  } as any)
  expect(asked.decision).toBe('ask')
  expect(asked.reason).toMatch(/^\[mod:refresh-run-guard\] /)
})

test('an allowed call carries no callout and fires no toast', async ($, on) => {
  const toasts = toastsOf(on)
  on('tool.call', () => ({ result: { stdout: 'ok', stderr: '', interrupted: false }, text: 'ok' }) as any)
  const r: any = await $.tool.call({ tool: 'Bash', command: 'grep -rn publish_collection_items webflow/' } as any)
  expect(r.deny).toBeUndefined()
  expect(toasts.length).toBe(0)
})
