import { test, expect } from 'claude-code/testing'

import { world, iso, DAY, RUN } from './fixture'

// LC-1711 callout convention: a deny or ask carries `[mod:pillar-brief-guard]` in the text the model
// reads AND fires a toast with the same text. Both halves are asserted, so dropping either fails.

const d = (extra = {}) => ({ tool: 'mcp__github__actions_run_trigger', method: 'run_workflow', workflow_id: 'run-heading-research.yml', inputs: { run_id: RUN, step: 'shortlist', apply: true }, ...extra }) as any

test('a deny is prefixed and toasted', async ($, on) => {
  const w = world(on, { brief: null })
  const r: any = await $.tool.call(d())
  expect(r.deny).toMatch(/^\[mod:pillar-brief-guard\] /)
  expect(w.toasts.length).toBe(1)
  expect(w.toasts[0]).toBe(r.deny)
})

test('an ask is prefixed and toasted', async ($, on) => {
  const w = world(on, { brief: { approved_at: iso(400 * DAY), approved_by: 'The operator' } })
  await $.tool.call(d())
  expect(w.asked.length).toBe(1)
  expect(w.asked[0]).toContain('[mod:pillar-brief-guard]')
  expect(w.toasts.length).toBe(1)
  expect(w.toasts[0]).toMatch(/^\[mod:pillar-brief-guard\] .*400 days old/)
})

test('the article-idea next steps (a changed state) are prefixed and toasted', async ($, on) => {
  const w = world(on)
  const r: any = await $.tool.call({ tool: 'mcp__a__createJiraIssue', projectKey: 'LCC', description: 'Parent article: best-sofas', additional_fields: { labels: ['article-idea'] } } as any)
  expect(String(r.context?.[0])).toMatch(/^\[mod:pillar-brief-guard\] /)
  expect(w.toasts).toEqual([r.context[0]])
})

test('an allowed call carries no callout and fires no toast', async ($, on) => {
  const w = world(on)
  const r: any = await $.tool.call(d())
  expect(r.deny).toBeUndefined()
  expect(r.context).toBeUndefined()
  expect(w.toasts.length).toBe(0)
})
