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

// LC-2203: since the Mergify cutover most PRs are handed over without a merge or auto-merge call.
test('marking a PR ready counts as queued (the router queues it), never as merged', async ($: any, on: any) => {
  on('tool.call', () => ({ result: { number: 5 } }))
  on('classic.Stop', () => ({}))
  await $.tool.call({ tool: 'mcp__github__create_pull_request', owner: 'o', repo: 'r', title: 'LC-2203 closer', head: 'b', draft: true })
  const r = await $.tool.call({ tool: 'mcp__github__update_pull_request', owner: 'o', repo: 'r', pullNumber: 5, draft: false })
  const ctx = String(r.context ?? '')
  expect(ctx).toContain('QUEUED to merge (marked ready')
  expect(ctx).toContain('LC-2203')
  const block = String((await $.classic.Stop({ stop_hook_active: false })).block ?? '')
  expect(block).toContain('NOT merged yet')
  expect(block).toContain('LC-2203 (o/r#5)')
})

for (const label of ['queue', 'merge-train', { name: 'Queue' }]) {
  test(`adding the ${JSON.stringify(label)} label counts as queued`, async ($: any, on: any) => {
    on('tool.call', () => ({ result: { content: [] } }))
    on('mcp.call', () => ({ value: prJson({ title: 'LCH-700 fix', head: { ref: 'b' }, body: '' }) }))
    on('classic.Stop', () => ({}))
    const r = await $.tool.call({ tool: 'mcp__github__issue_write', method: 'update', owner: 'o', repo: 'r', issue_number: 8, labels: ['route:queue', label] })
    expect(String(r.context ?? '')).toContain('label added')
    const block = String((await $.classic.Stop({ stop_hook_active: false })).block ?? '')
    expect(block).toContain('LCH-700 (o/r#8)')
  })
}

test('other labels, or an update that keeps the PR a draft, change nothing', async ($: any, on: any) => {
  on('tool.call', () => ({ result: { content: [] } }))
  on('mcp.call', () => ({ value: prJson({ title: 'LC-9 x', head: { ref: 'b' }, body: '' }) }))
  on('classic.Stop', () => ({}))
  const a = await $.tool.call({ tool: 'mcp__github__issue_write', method: 'update', owner: 'o', repo: 'r', issue_number: 9, labels: ['needs-operator', 'route:queue'] })
  const b = await $.tool.call({ tool: 'mcp__github__update_pull_request', owner: 'o', repo: 'r', pullNumber: 9, title: 'LC-9 renamed' })
  const c = await $.tool.call({ tool: 'mcp__github__update_pull_request', owner: 'o', repo: 'r', pullNumber: 9, draft: true })
  expect(a.context).toBeUndefined()
  expect(b.context).toBeUndefined()
  expect(c.context).toBeUndefined()
  expect((await $.classic.Stop({ stop_hook_active: false })).block).toBeUndefined()
})

// LC-2118: the v2 Atlassian server (mcp__Atlassian_MCP__) must settle a ticket exactly as v1 does.
test('v2 addOrEditJiraIssueComment settles the ticket, as v1 addCommentToJiraIssue does', async ($: any, on: any) => {
  engineBeneath(on)
  await $.tool.call({ ...merge, commit_title: 'LC-2118 move to v2' })
  await $.tool.call({ tool: 'mcp__Atlassian_MCP__addOrEditJiraIssueComment', cloudId: 'x', issueIdOrKey: 'LC-2118', commentBody: 'state' })
  expect((await $.classic.Stop({ stop_hook_active: false })).block).toBeUndefined()
})

test('v2 executeWrite{editJiraIssue} settles the ticket; a runner call for another operation does not', async ($: any, on: any) => {
  engineBeneath(on)
  await $.tool.call({ ...merge, commit_title: 'LC-2118 move to v2' })
  await $.tool.call({ tool: 'mcp__Atlassian_MCP__executeWrite', cloudId: 'x', name: 'createIssueLink', inputs: { issueIdOrKey: 'LC-2118' } })
  const held = await $.classic.Stop({ stop_hook_active: false })
  expect(String(held.block ?? '')).toContain('LC-2118')
  await $.tool.call({ tool: 'mcp__Atlassian_MCP__executeWrite', cloudId: 'x', name: 'editJiraIssue', inputs: { issueIdOrKey: 'LC-2118' } })
  expect((await $.classic.Stop({ stop_hook_active: false })).block).toBeUndefined()
})

test('v2 comment on a different ticket leaves the merged PR ticket pending (bad case still caught)', async ($: any, on: any) => {
  engineBeneath(on)
  await $.tool.call({ ...merge, commit_title: 'LC-2118 move to v2' })
  await $.tool.call({ tool: 'mcp__Atlassian_MCP__addOrEditJiraIssueComment', cloudId: 'x', issueIdOrKey: 'LC-1', commentBody: 'x' })
  expect(String((await $.classic.Stop({ stop_hook_active: false })).block ?? '')).toContain('LC-2118')
})

// LCH-794: a PR that names a bbm-health-issues issue is closed out on GitHub, never through a Jira close.
test('a PR with `Fixes brand-bridge-media/bbm-health-issues#N` says the project closes the GitHub issue, and Stop does not hold', async ($: any, on: any) => {
  on('tool.call', () => ({ result: 'ok', text: 'ok' }))
  on('mcp.call', () => ({ value: prJson({ title: 'chore: fix probe', head: { ref: 'b' }, body: 'Fixes brand-bridge-media/bbm-health-issues#31' }) }))
  on('classic.Stop', () => ({}))
  const r = await $.tool.call({ tool: 'mcp__github__merge_pull_request', owner: 'o', repo: 'r', pullNumber: 31 })
  const ctx = String(r.context ?? '')
  expect(ctx).toContain('bbm-health-issues#31')
  expect(ctx).toContain('this project verifies and closes the GitHub issue')
  expect(ctx).toContain('[mod:jira-closer]')
  expect(ctx).not.toContain('transition it to Done')
  expect((await $.classic.Stop({ stop_hook_active: false })).block).toBeUndefined()
})

test('a bare `bbm-health-issues#N` and the full issue URL are both recognised', async ($: any, on: any) => {
  on('tool.call', () => ({ result: 'ok', text: 'ok' }))
  on('classic.Stop', () => ({}))
  let body = 'See bbm-health-issues#12 for context'
  on('mcp.call', () => ({ value: prJson({ title: 'x', head: { ref: 'b' }, body }) }))
  expect(String((await $.tool.call({ tool: 'mcp__github__merge_pull_request', owner: 'o', repo: 'r', pullNumber: 40 })).context ?? '')).toContain('bbm-health-issues#12')
  body = 'https://github.com/brand-bridge-media/bbm-health-issues/issues/77'
  expect(String((await $.tool.call({ tool: 'mcp__github__merge_pull_request', owner: 'o', repo: 'r', pullNumber: 41 })).context ?? '')).toContain('bbm-health-issues#77')
})

test('a PR with a Jira key AND a health issue keeps the Jira hold and adds the health line', async ($: any, on: any) => {
  engineBeneath(on)
  on('mcp.call', () => ({ value: prJson({ title: 'LC-2376 SLA clock', head: { ref: 'b' }, body: 'Fixes bbm-health-issues#5' }) }))
  const r = await $.tool.call({ ...merge, pullNumber: 8 })
  const ctx = String(r.context ?? '')
  expect(ctx).toContain('LC-2376')
  expect(ctx).toContain('this project verifies and closes the GitHub issue')
  expect(String((await $.classic.Stop({ stop_hook_active: false })).block ?? '')).toContain('LC-2376')
})

test('a queued PR naming a health issue says to close it once the merge lands', async ($: any, on: any) => {
  on('tool.call', () => ({ result: { content: [] } }))
  on('classic.Stop', () => ({}))
  on('mcp.call', () => ({ value: prJson({ title: 'fix probe', head: { ref: 'b' }, body: 'Fixes bbm-health-issues#3' }) }))
  const r = await $.tool.call({ tool: 'mcp__github__enable_pr_auto_merge', owner: 'o', repo: 'r', pullNumber: 9 })
  expect(String(r.context ?? '')).toContain('once the merge lands')
})

test('a PR this session opened keeps its body reference through the title fetch', async ($: any, on: any) => {
  on('mcp.call', () => ({ value: prJson({ title: 'chore: fix probe', head: { ref: 'b' }, body: 'no reference here' }) }))
  on('tool.call', { tool: /^mcp__/ }, (_$: any, e: any) => ({ result: { content: [{ type: 'text', text: /create_pull_request$/.test(e.tool) ? 'https://github.com/o/r/pull/52' : 'ok' }] } }))
  on('classic.Stop', () => ({}))
  await $.tool.call({ tool: 'mcp__github__create_pull_request', owner: 'o', repo: 'r', title: 'chore: fix probe', head: 'b', body: 'See https://github.com/brand-bridge-media/bbm-health-issues/issues/52' })
  const r = await $.tool.call({ tool: 'mcp__github__merge_pull_request', owner: 'o', repo: 'r', pullNumber: 52 })
  expect(String(r.context ?? '')).toContain('bbm-health-issues#52')
})

test('the repo name alone, with no issue number, is not a health issue reference', async ($: any, on: any) => {
  engineBeneath(on)
  on('mcp.call', () => ({ value: prJson({ title: 'chore: x', head: { ref: 'b' }, body: 'files go to bbm-health-issues now' }) }))
  const r = await $.tool.call({ ...merge, pullNumber: 10 })
  expect(r.context).toBeUndefined()
})
