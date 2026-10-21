import { test, expect } from 'claude-code/testing'

import { askFor, DESTRUCTIVE_TOOLS, MONEY_TOOLS } from '../hooks/logic'

test('money tools and every Stripe tool ask, naming money', () => {
  for (const t of [...MONEY_TOOLS, 'mcp__Stripe__create_refund']) expect(askFor(t)).toMatch(/^\[mod:spend-delete-ask\] .*moves money/)
})

test('destructive tools ask, naming the delete', () => {
  for (const t of DESTRUCTIVE_TOOLS) expect(askFor(t)).toMatch(/^\[mod:spend-delete-ask\] .*deletes something/)
})

test('reads and reversible cleanup do not ask', () => {
  for (const t of ['mcp__Mercury__listTransactions', 'mcp__PayPal__list_invoices', 'mcp__claude-code-remote__delete_trigger',
    'mcp__Supabase__execute_sql', 'mcp__Stripeish__x', 'Bash', '']) expect(askFor(t)).toBeUndefined()
})

test('an asking tool is toasted for the operator; a plain one passes untouched', async ($: any, on: any) => {
  const toasts: string[] = []
  const reached: string[] = []
  on('ui.toast', (_$: any, e: any) => { toasts.push(e.text); return { value: undefined } as any })
  on('tool.call', (_$: any, e: any) => { reached.push(e.tool); return { result: 'ok', text: 'ok' } as any })
  await $.tool.call({ tool: 'mcp__PayPal__list_invoices' })
  expect(toasts.length).toBe(0)
  await $.tool.call({ tool: 'mcp__PayPal__send_invoice', invoice_id: 'i' }).catch(() => undefined)
  expect(toasts[0]).toContain('mcp__PayPal__send_invoice')
  expect(reached).toContain('mcp__PayPal__list_invoices')
})
