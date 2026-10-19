import { test, expect, mock } from 'claude-code/testing'

import { helperOutput, sqlReply } from './fixture'

// LC-1711 callout convention: a deny or ask carries `[mod:run-state]` in the text the model reads AND
// fires a toast that names the mod and the reason. Both halves are asserted.

function setup(on: any, planFails = false, toastThrows = false) {
  mock.store(on)
  mock.clock(on, { now: Date.parse('2026-10-07T12:00:00Z') })
  const toasts: string[] = []
  const asked: string[] = []
  on('ui.toast', (_$: any, e: any) => {
    if (toastThrows) throw new Error('toast surface is gone')
    toasts.push(e.text)
    return { value: undefined } as any
  })
  on('mcp.call', (_$: any, e: any) =>
    ({ value: String(e.args.query).includes('limit 5')
      ? sqlReply([{ id: '00000000-0000-4000-8000-000000000000', article_slug: 'slug-0', status: 'in_progress' }])
      : sqlReply([{ id: '896655cd-59e8-4f99-b127-6a275ab31e18', stages: [] }]) }) as any)
  on('process.run', () => (planFails
    ? ({ value: { exitCode: 1, stdout: '', stderr: 'no module named pydantic' } } as any)
    : ({ value: { exitCode: 0, stdout: helperOutput(), stderr: '' } } as any)))
  on('tool.call', (_$: any, e: any) => {
    if (e.tool === 'AskUserQuestion') {
      asked.push(JSON.stringify(e))
      return { result: { answers: { [e.questions?.[0]?.question]: 'Refuse' } }, text: 'Refuse' } as any
    }
    return { result: 'ok', text: 'ok' } as any
  })
  return { toasts, asked }
}

const BLOCKED = 'python3 write_stage_receipt.py --slug most-comfortable-couches --stage 11 --part c5 --status pass'
const READY = 'python3 write_stage_receipt.py --slug most-comfortable-couches --stage 9 --part c2 --status done'

test('a deny is prefixed [mod:run-state] and toasts the mod and the reason', async ($, on) => {
  const { toasts } = setup(on)
  const out = JSON.stringify(await $.tool.call({ tool: 'Bash', command: BLOCKED } as any))
  expect(out).toContain('[mod:run-state]')
  expect(out).toContain('v2_s11c5')
  expect(toasts.length).toBe(1)
  expect(toasts[0]).toContain('[mod:run-state]')
  expect(toasts[0]).toContain('v2_s11c5')
})

test('an ask is prefixed [mod:run-state] and toasts the mod and the reason', async ($, on) => {
  const { toasts, asked } = setup(on, true)
  await $.tool.call({ tool: 'Bash', command: READY } as any)
  expect(asked.length).toBe(1)
  expect(asked[0]).toContain('[mod:run-state]')
  expect(asked[0]).toContain('cannot read the refresh plan')
  expect(toasts.length).toBe(1)
  expect(toasts[0]).toContain('[mod:run-state]')
  expect(toasts[0]).toContain('cannot read the refresh plan')
})

test('a write for a READY section carries no callout and fires no toast', async ($, on) => {
  const { toasts } = setup(on)
  const out = JSON.stringify(await $.tool.call({ tool: 'Bash', command: READY } as any))
  expect(out).not.toContain('[mod:')
  expect(toasts.length).toBe(0)
})

// A toast is for Stan's eyes only; if the toast surface throws, the guard must still decide.
test('a throwing toast does not stop an ask (plan unreadable, write refused)', async ($, on) => {
  const { asked } = setup(on, true, true)
  const out = JSON.stringify(await $.tool.call({ tool: 'Bash', command: READY } as any))
  expect(asked.length).toBe(1)
  expect(asked[0]).toContain('[mod:run-state]')
  expect(out).toContain('refused')
})

test('a throwing toast does not stop a real deny from the plan', async ($, on) => {
  setup(on, false, true)
  const out: any = await $.tool.call({ tool: 'Bash', command: BLOCKED } as any)
  expect(JSON.stringify(out)).toContain('[mod:run-state]')
  expect(JSON.stringify(out)).toContain('v2_s11c5')
})
