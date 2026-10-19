import { test, expect } from 'claude-code/testing'

// LC-1711 callout convention: a deny carries `[mod:draft-session]` in the text the model reads AND
// fires a toast that names the mod and the reason. Both halves are asserted.

const RUN = '11111111-1111-4111-8111-111111111111'
const ART = '22222222-2222-4222-8222-222222222222'
const OPTS = { runId: RUN, articleId: ART, slug: 'best-sofas', templateVariant: 'v1', contractPath: '/contract/v2_s6_draft.md' }
const RECEIPT = `python3 webflow/bulk-operations/refresh-receipt-writer/write_stage_receipt.py --run-id ${RUN} --stage 6 --status done --summary "Draft done"`

function setup(on: any, toastThrows = false) {
  const toasts: string[] = []
  on('fs.read', (_$: any, e: any) => {
    if (e.path === '/contract/v2_s6_draft.md') return { value: '# contract' } as any
    throw new Error(`ENOENT ${e.path}`)
  })
  on('tool.call', () => ({ result: { text: 'ran' } }) as any)
  on('ui.status', () => ({ value: undefined }) as any)
  on('ui.toast', (_$: any, e: any) => {
    if (toastThrows) throw new Error('toast surface is gone')
    toasts.push(e.text)
    return { value: undefined } as any
  })
  return toasts
}

test('the Draft receipt block is prefixed [mod:draft-session] and toasts the mod and the reason', { options: OPTS }, async ($, on) => {
  const toasts = setup(on)
  const r: any = await $.tool.call({ tool: 'Bash', command: RECEIPT } as any)
  expect(r.deny).toMatch(/^\[mod:draft-session\] /)
  expect(r.deny).toContain('Draft receipt blocked')
  expect(toasts.length).toBe(1)
  expect(toasts[0]).toContain('[mod:draft-session]')
  expect(toasts[0]).toContain('Draft receipt blocked')
})

test('a write to another article is denied with the prefix and a toast', { options: OPTS }, async ($, on) => {
  const toasts = setup(on)
  const r: any = await $.tool.call({ tool: 'Write', file_path: '/work/bbm-content/other-article.md', content: 'x' } as any)
  expect(r.deny).toMatch(/^\[mod:draft-session\] /)
  expect(toasts.length).toBe(1)
  expect(toasts[0]).toContain('[mod:draft-session]')
})

test('a call the guard has no quarrel with carries no callout', { options: OPTS }, async ($, on) => {
  const toasts = setup(on)
  const r: any = await $.tool.call({ tool: 'Bash', command: 'ls' } as any)
  expect(r.deny).toBeUndefined()
  expect(toasts.length).toBe(0)
})

test('/draft-start with an unreadable contract toasts the block and prefixes the text and context', async ($, on) => {
  const toasts: string[] = []
  on('fs.read', () => { throw new Error('ENOENT') })
  on('ui.status', () => ({ value: undefined }) as any)
  on('ui.toast', (_$: any, e: any) => { toasts.push(e.text); return { value: undefined } as any })
  const r: any = await $.command.run({ command: 'draft-start', args: `${RUN} ${ART} best-sofas v1` } as any)
  expect(r.text).toMatch(/^\[mod:draft-session\] /)
  expect(r.text).toContain('CONTRACT IS UNREADABLE')
  expect(r.context.join(' ')).toContain('[mod:draft-session]')
  expect(toasts.length).toBe(1)
  expect(toasts[0].startsWith('[mod:draft-session] session pinned to run')).toBe(true)
  expect(toasts[0]).toContain('CONTRACT IS UNREADABLE')
})

test('a throwing toast does not stop a deny', { options: OPTS }, async ($, on) => {
  setup(on, true)
  const r: any = await $.tool.call({ tool: 'Bash', command: RECEIPT } as any)
  expect(r.deny).toMatch(/^\[mod:draft-session\] /)
  expect(r.deny).toContain('Draft receipt blocked')
})

test('the contract-unreadable toast stays up 15 s', { options: OPTS }, async ($, on) => {
  const seen: { text: string; timeoutMs?: number }[] = []
  on('fs.read', () => { throw new Error('ENOENT') })
  on('prompt.compose', () => ({ sections: [] }) as any)
  on('ui.toast', (_$: any, e: any) => { seen.push({ text: e.text, timeoutMs: e.timeoutMs }); return { value: undefined } as any })
  await $.prompt.compose({ model: 'm', promptModel: 'm', outputStyle: null, traits: [], tools: [], surfaces: [] } as any)
  const t = seen.find(s => s.text.includes('contract unreadable'))
  expect(t).toBeDefined()
  expect(t!.timeoutMs).toBe(15_000)
})
