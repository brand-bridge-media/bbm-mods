import { test, expect } from 'claude-code/testing'

// LC-1729 callout convention: the merge-time instruction and the Stop block both carry
// [mod:jira-closer] (for the model) and fire the same text as a toast (for the operator).

const toastsOf = (on: any) => {
  const toasts: string[] = []
  on('ui.toast', (_$: any, e: any) => { toasts.push(e.text); return { value: undefined } as any })
  return toasts
}

test('merge context and Stop block are prefixed and toasted; an untagged merge is silent', async ($: any, on: any) => {
  const toasts = toastsOf(on)
  on('tool.call', () => ({ result: 'ok', text: 'ok' }))
  on('classic.Stop', () => ({}))
  on('mcp.call', () => ({ value: { content: [{ type: 'text', text: JSON.stringify({ title: 'chore: deps', head: { ref: 'deps' }, body: '' }) }] } }))

  const quiet = await $.tool.call({ tool: 'mcp__gh__merge_pull_request', owner: 'o', repo: 'r', pullNumber: 1, commit_title: 'chore: deps' })
  expect(quiet.context).toBeUndefined()
  expect(toasts.length).toBe(0)

  const r = await $.tool.call({ tool: 'mcp__gh__merge_pull_request', owner: 'o', repo: 'r', pullNumber: 2, commit_title: 'LC-1 thing' })
  expect(String(r.context?.[0] ?? '').startsWith('[mod:jira-closer]')).toBe(true)
  const s = await $.classic.Stop({ stop_hook_active: false })
  expect(String(s.block ?? '').startsWith('[mod:jira-closer]')).toBe(true)
  expect(toasts.length).toBe(2)
  expect(toasts.every(t => t.startsWith('[mod:jira-closer]'))).toBe(true)
})
