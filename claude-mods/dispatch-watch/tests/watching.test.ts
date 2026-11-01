import { test, expect } from 'claude-code/testing'

import { watchKey } from '../hooks/logic'

// LC-1975: unwatched-job-guard asks dispatch-watch what it holds through the `watching` tool.
const FN = 'https://tlcbwwgfqnasmiipgmmd.supabase.co/functions/v1/github-dispatch'
const dispatch = `select net.http_post(url := '${FN}?secret=' || (select 1), body := '{"workflow":"refresh-run.yml","inputs":{}}'::jsonb)`

test('the key is the workflow, lower-cased', () => {
  expect(watchKey('Refresh-Run.yml')).toBe('dispatch:refresh-run.yml')
})

test('end to end: a bridge dispatch shows as active in `watching`', async ($: any, on: any) => {
  on('clock.now', () => ({ value: Date.parse('2026-11-01T00:00:00Z') }) as any)
  on('clock.every', () => ({ value: undefined }) as any)
  on('tool.call', { tool: /execute_sql$/ }, () => ({ result: { content: [{ type: 'text', text: '[{"http_post":1}]' }] } }))
  const before: any = await $.tool.call({ tool: 'mcp__dispatch-watch__watching' })
  expect(JSON.parse(String(before.result))).toEqual({ active: [], finished: [] })
  const r: any = await $.tool.call({ tool: 'mcp__Supabase__execute_sql', project_id: 'p', query: dispatch })
  expect(String(r.context ?? '')).toContain('Watching refresh-run.yml')
  const after: any = await $.tool.call({ tool: 'mcp__dispatch-watch__watching' })
  expect(JSON.parse(String(after.result))).toEqual({ active: ['dispatch:refresh-run.yml'], finished: [] })
})
