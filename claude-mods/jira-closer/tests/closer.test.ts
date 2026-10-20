import { test, expect } from 'claude-code/testing'

const merge = { tool: 'mcp__github__merge_pull_request', owner: 'o', repo: 'r', pullNumber: 7 } as const

function engineBeneath(on: any) {
  on('tool.call', { tool: /^mcp__/ }, () => ({ result: { content: [{ type: 'text', text: 'ok' }] } }))
  on('classic.Stop', () => ({}))
}

test('merge with a Jira key adds context, Stop blocks once, then lets go', async ($: any, on: any) => {
  engineBeneath(on)
  const r = await $.tool.call({ ...merge, commit_title: 'LC-1537 flip brands (#7)' })
  expect(String(r.context ?? '')).toContain('LC-1537')

  const first = await $.classic.Stop({ stop_hook_active: false })
  expect(String(first.block ?? '')).toContain('LC-1537')

  const second = await $.classic.Stop({ stop_hook_active: true })
  expect(second.block).toBeUndefined()
})

test('touching the ticket clears it, so Stop does not block', async ($: any, on: any) => {
  engineBeneath(on)
  await $.tool.call({ ...merge, commit_title: 'LC-1551 fix probe' })
  await $.tool.call({ tool: 'mcp__claude_ai_Atlassian__transitionJiraIssue', cloudId: 'x', issueIdOrKey: 'LC-1551', transition: { id: '19' } })
  const r = await $.classic.Stop({ stop_hook_active: false })
  expect(r.block).toBeUndefined()
})

test('a merge with no Jira key anywhere changes nothing', async ($: any, on: any) => {
  engineBeneath(on)
  on('mcp.call', () => ({ value: { content: [{ type: 'text', text: JSON.stringify({ title: 'chore: bump deps', head: { ref: 'deps' }, body: 'Refs: LC-9' }) }] } }))
  const r = await $.tool.call({ ...merge, commit_title: 'chore: bump deps' })
  expect(r.context).toBeUndefined()
  const s = await $.classic.Stop({ stop_hook_active: false })
  expect(s.block).toBeUndefined()
})

test('auto-merge counts as a merge, and the key is matched case-insensitively on the Jira side', async ($: any, on: any) => {
  on('tool.call', () => ({ result: { content: [] } }))
  on('classic.Stop', () => ({}))
  await $.tool.call({ tool: 'mcp__GitHub_Custom__enable_pr_auto_merge', owner: 'o', repo: 'r', pullNumber: 9, commit_title: 'LCH-12 alert fix' })
  await $.tool.call({ tool: 'mcp__Atlassian__addCommentToJiraIssue', cloudId: 'x', issueIdOrKey: 'lch-12', commentBody: 'state' })
  const s = await $.classic.Stop({ stop_hook_active: false })
  expect(s.block).toBeUndefined()
})

test('auto-merge is reported as queued, never as merged, and asks for no Done yet (LC-1884)', async ($: any, on: any) => {
  on('tool.call', () => ({ result: { content: [] } }))
  on('classic.Stop', () => ({}))
  const r = await $.tool.call({ tool: 'mcp__github__enable_pr_auto_merge', owner: 'o', repo: 'r', pullNumber: 21, commit_title: 'LCH-531 rules' })
  const ctx = String(r.context ?? '')
  expect(ctx).toContain('QUEUED to merge')
  expect(ctx).toContain('Do not transition to Done')
  const s = await $.classic.Stop({ stop_hook_active: false })
  const block = String(s.block ?? '')
  expect(block).toContain('NOT merged yet')
  expect(block).toContain('LCH-531 (o/r#21)')
  expect(block).not.toContain('merged PR(s) left')
})

test('a real merge and a queued one in the same turn are each named for what they are', async ($: any, on: any) => {
  on('tool.call', () => ({ result: { content: [] } }))
  on('classic.Stop', () => ({}))
  await $.tool.call({ tool: 'mcp__github__merge_pull_request', owner: 'o', repo: 'r', pullNumber: 1, commit_title: 'LC-1 a' })
  await $.tool.call({ tool: 'mcp__github__enable_pr_auto_merge', owner: 'o', repo: 'r', pullNumber: 2, commit_title: 'LC-2 b' })
  const block = String((await $.classic.Stop({ stop_hook_active: false })).block ?? '')
  expect(block).toMatch(/merged PR\(s\) left these Jira tickets untouched: LC-1 \(o\/r#1\)\./)
  expect(block).toMatch(/NOT merged yet\) left these Jira tickets untouched: LC-2 \(o\/r#2\)\./)
})

const prJson = (pr: object) => ({ content: [{ type: 'text', text: JSON.stringify(pr) }] })

test('a PR opened elsewhere: title and Closes lines count, Refs lines do not', async ($: any, on: any) => {
  on('tool.call', () => ({ result: 'ok', text: 'ok' }))
  on('mcp.call', () => ({ value: prJson({ title: 'chore: x', head: { ref: 'b' }, body: 'Closes LC-77.\n\nRefs: LC-88' }) }))
  on('classic.Stop', () => ({}))
  const r = await $.tool.call({ tool: 'mcp__github__merge_pull_request', owner: 'o', repo: 'r', pullNumber: 3 })
  const ctx = String(r.context ?? '')
  expect(ctx).toContain('LC-77')
  expect(ctx).not.toContain('LC-88')
})

test('an unreadable PR is said out loud and holds Stop once, until any Jira touch', async ($: any, on: any) => {
  on('tool.call', () => ({ result: 'ok', text: 'ok' }))
  on('mcp.call', () => { throw new Error('boom') })
  on('classic.Stop', () => ({}))
  const r = await $.tool.call({ tool: 'mcp__github__merge_pull_request', owner: 'o', repo: 'r', pullNumber: 4 })
  expect(String(r.context ?? '')).toContain('could not read')
  const s = await $.classic.Stop({ stop_hook_active: false })
  expect(String(s.block ?? '')).toContain('o/r#4')
})

test('an unreadable PR is settled by touching a Jira ticket', async ($: any, on: any) => {
  on('tool.call', () => ({ result: 'ok', text: 'ok' }))
  on('mcp.call', () => ({ value: { content: [] } }))
  on('classic.Stop', () => ({}))
  await $.tool.call({ tool: 'mcp__github__merge_pull_request', owner: 'o', repo: 'r', pullNumber: 5 })
  await $.tool.call({ tool: 'mcp__Atlassian__addCommentToJiraIssue', issueIdOrKey: 'LC-5', commentBody: 'x' })
  const s = await $.classic.Stop({ stop_hook_active: false })
  expect(s.block).toBeUndefined()
})

test('a fetch that answers but is not a PR counts as unread, not as no-key', async ($: any, on: any) => {
  on('tool.call', () => ({ result: 'ok', text: 'ok' }))
  on('mcp.call', () => ({ value: { content: [{ type: 'text', text: 'rate limited' }] } }))
  on('classic.Stop', () => ({}))
  const r = await $.tool.call({ tool: 'mcp__github__merge_pull_request', owner: 'o', repo: 'r', pullNumber: 6 })
  expect(String(r.context ?? '')).toContain('could not read')
})

test('a lower-case key in the title still arms the hold, stored upper-case', async ($: any, on: any) => {
  on('tool.call', () => ({ result: 'ok', text: 'ok' }))
  on('classic.Stop', () => ({}))
  await $.tool.call({ tool: 'mcp__github__merge_pull_request', owner: 'o', repo: 'r', pullNumber: 7, commit_title: 'lc-1537 fix' })
  const s = await $.classic.Stop({ stop_hook_active: false })
  expect(String(s.block ?? '')).toContain('LC-1537')
})

test('a Jira touch that names no real ticket does not settle an unreadable PR', async ($: any, on: any) => {
  on('tool.call', () => ({ result: 'ok', text: 'ok' }))
  on('mcp.call', () => ({ value: { content: [] } }))
  on('classic.Stop', () => ({}))
  await $.tool.call({ tool: 'mcp__github__merge_pull_request', owner: 'o', repo: 'r', pullNumber: 8 })
  await $.tool.call({ tool: 'mcp__Atlassian__addCommentToJiraIssue', issueIdOrKey: 'not-a-key', commentBody: 'x' })
  const s = await $.classic.Stop({ stop_hook_active: false })
  expect(String(s.block ?? '')).toContain('o/r#8')
})

test('a PR this session opened keeps its Closes lines for the merge', async ($: any, on: any) => {
  on('tool.call', (_$: any, e: any) => (e.tool.endsWith('create_pull_request')
    ? { result: { number: 9, html_url: 'https://github.com/o/r/pull/9' }, text: 'ok' }
    : { result: 'ok', text: 'ok' }))
  on('classic.Stop', () => ({}))
  await $.tool.call({ tool: 'mcp__github__create_pull_request', owner: 'o', repo: 'r', title: 'LC-1 thing', head: 'b', body: 'Closes LC-2\nRefs: LC-3' })
  const r = await $.tool.call({ tool: 'mcp__github__merge_pull_request', owner: 'o', repo: 'r', pullNumber: 9 })
  const ctx = String(r.context ?? '')
  expect(ctx).toContain('LC-1')
  expect(ctx).toContain('LC-2')
  expect(ctx).not.toContain('LC-3')
})
