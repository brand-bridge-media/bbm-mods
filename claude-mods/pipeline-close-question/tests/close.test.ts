import { test, expect } from 'claude-code/testing'

const T = 'mcp__Atlassian__transitionJiraIssue'

test('an LCH transition gets the closing questions after it runs', async ($: any, on: any) => {
  const reached: any[] = []
  on('tool.call', (_$: any, e: any) => { reached.push(e); return { result: 'ok' } })
  const r: any = await $.tool.call({ tool: T, cloudId: 'x', issueIdOrKey: 'lch-685', transition: { id: '31' } })
  expect(reached.length).toBe(1)
  expect(String(r.context ?? '')).toContain('[mod:pipeline-close-question] If LCH-685')
  expect(String(r.context ?? '')).toContain('will this issue recur')
})

for (const key of ['LC-2014', 'BBM-3', '', 'LCH-x']) {
  test(`${key || 'no key'} gets nothing`, async ($: any, on: any) => {
    on('tool.call', () => ({ result: 'ok' }))
    const r: any = await $.tool.call({ tool: T, cloudId: 'x', issueIdOrKey: key, transition: { id: '31' } })
    expect(r.context).toBeUndefined()
  })
}

test('a failed transition gets nothing', async ($: any, on: any) => {
  on('tool.call', () => ({ isError: true, result: 'no' }))
  const r: any = await $.tool.call({ tool: T, cloudId: 'x', issueIdOrKey: 'LCH-1', transition: { id: '31' } })
  expect(r.context).toBeUndefined()
})

test('other Jira tools never fire it', async ($: any, on: any) => {
  on('tool.call', () => ({ result: 'ok' }))
  const r: any = await $.tool.call({ tool: 'mcp__Atlassian__addCommentToJiraIssue', cloudId: 'x', issueIdOrKey: 'LCH-1', commentBody: 'x' })
  expect(r.context).toBeUndefined()
})
