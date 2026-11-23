import { test, expect } from 'claude-code/testing'

import { verdictFor } from '../hooks/logic'

const P = 'mcp__Atlassian_MCP__'
const LIST = `${P}listJiraIssueComments`
const GET = `${P}getJiraIssue`

function world(on: any) {
  const toasts: string[] = []
  const reached: string[] = []
  on('ui.toast', (_$: any, e: any) => { toasts.push(e.text); return { value: undefined } as any })
  on('tool.call', (_$: any, e: any) => { reached.push(e.tool); return { result: 'ok', text: 'ok' } as any })
  return { toasts, reached }
}

const denied = (r: any) => String(r.deny ?? r.text ?? '')

test('logic: a write with no recorded read is denied, naming the call to make first', () => {
  const v = verdictFor(`${P}addOrEditJiraIssueComment`, { issueIdOrKey: 'lc-2118', commentBody: 'x' }, [])
  expect(v!.deny.startsWith('[mod:jira-read-before-write]')).toBe(true)
  expect(v!.deny).toContain('listJiraIssueComments(issueIdOrKey="LC-2118"')
})

test('logic: a write after the read passes; a read of a different key does not count', () => {
  expect(verdictFor(`${P}editJiraIssue`, { issueIdOrKey: 'LC-1' }, ['LC-1'])).toBeUndefined()
  expect(verdictFor(`${P}transitionJiraIssue`, { issueIdOrKey: 'LC-1' }, ['LC-2'])).toBeDefined()
})

test('logic: runner writes are judged by their inner operation and issue key; other runner calls and keyless writes pass', () => {
  const w = (name: string, inputs: any) => ({ name, cloudId: 'c', inputs })
  expect(verdictFor(`${P}executeWrite`, w('editJiraIssue', { issueIdOrKey: 'LC-9' }), [])).toBeDefined()
  expect(verdictFor(`${P}executeDestructive`, w('transitionJiraIssue', { issueIdOrKey: 'LC-9' }), [])).toBeDefined()
  expect(verdictFor(`${P}executeWrite`, w('editJiraIssue', { issueIdOrKey: 'LC-9' }), ['LC-9'])).toBeUndefined()
  expect(verdictFor(`${P}executeWrite`, w('createJiraIssue', { projectKey: 'LC' }), [])).toBeUndefined()
  expect(verdictFor(`${P}executeRead`, w('getIssueLinks', { issueIdOrKey: 'LC-9' }), [])).toBeUndefined()
  expect(verdictFor(`${P}editJiraIssue`, { summary: 'no key' }, [])).toBeUndefined()
})

test('logic: a runner write with missing, array or non-object inputs is denied; a plain-object one still follows the read rule', () => {
  const deniedMsg = (inputs: any) => {
    const input: any = { name: 'editJiraIssue', issueIdOrKey: 'LC-9' }
    if (inputs !== undefined) input.inputs = inputs
    return verdictFor(`${P}executeWrite`, input, ['LC-9'])
  }
  for (const bad of [undefined, null, 'LC-9', [{ issueIdOrKey: 'LC-9' }]]) {
    const v = deniedMsg(bad)
    expect(v!.deny.startsWith('[mod:jira-read-before-write]')).toBe(true)
  }
  expect(verdictFor(`${P}executeDestructive`, { name: ' TransitionJiraIssue ', inputs: [] }, [])).toBeDefined()
  // valid case: plain-object inputs after the read is allowed; a non-write name with odd inputs is not this guard's call
  expect(verdictFor(`${P}executeWrite`, { name: 'editJiraIssue', inputs: { issueIdOrKey: 'LC-9' } }, ['LC-9'])).toBeUndefined()
  expect(verdictFor(`${P}executeWrite`, { name: 'createJiraIssue' }, [])).toBeUndefined()
})

test('logic: a write whose key field is present but not a usable string is denied; an absent key still passes', () => {
  for (const bad of [10001, { k: 'LC-1' }, ['LC-1'], '', '  ', true]) {
    const v = verdictFor(`${P}editJiraIssue`, { issueIdOrKey: bad }, ['LC-1'])
    expect(v!.deny.startsWith('[mod:jira-read-before-write]')).toBe(true)
  }
  expect(verdictFor(`${P}executeWrite`, { name: 'editJiraIssue', inputs: { issueIdOrKey: 10001 } }, [])).toBeDefined()
  // valid: string key after the read, keyless write, null key field
  expect(verdictFor(`${P}editJiraIssue`, { issueIdOrKey: 'LC-1' }, ['LC-1'])).toBeUndefined()
  expect(verdictFor(`${P}editJiraIssue`, { summary: 'no key' }, [])).toBeUndefined()
  expect(verdictFor(`${P}editJiraIssue`, { issueIdOrKey: null }, [])).toBeUndefined()
})

test('a write after listJiraIssueComments of the same key reaches the tool, silently', async ($: any, on: any) => {
  const w = world(on)
  await $.tool.call({ tool: LIST, issueIdOrKey: 'LC-2118', cloudId: 'c' })
  await $.tool.call({ tool: `${P}addOrEditJiraIssueComment`, issueIdOrKey: 'lc-2118', commentBody: 'x', cloudId: 'c' })
  expect(w.reached).toEqual([LIST, `${P}addOrEditJiraIssueComment`])
  expect(w.toasts.length).toBe(0)
})

test('a write with no read is denied before the tool runs, prefixed and toasted', async ($: any, on: any) => {
  const w = world(on)
  for (const tool of ['addOrEditJiraIssueComment', 'editJiraIssue', 'transitionJiraIssue']) {
    const r: any = await $.tool.call({ tool: `${P}${tool}`, issueIdOrKey: 'LC-2118', cloudId: 'c' })
    expect(denied(r)).toContain('[mod:jira-read-before-write] REFUSED')
  }
  const rr: any = await $.tool.call({ tool: `${P}executeWrite`, name: 'editJiraIssue', cloudId: 'c', inputs: { issueIdOrKey: 'LC-2118' } })
  expect(denied(rr)).toContain('[mod:jira-read-before-write]')
  expect(w.reached.length).toBe(0)
  expect(w.toasts.length).toBe(4)
  expect(w.toasts.every(t => t.startsWith('[mod:jira-read-before-write]'))).toBe(true)
})

test('a read of a different key does not count', async ($: any, on: any) => {
  const w = world(on)
  await $.tool.call({ tool: LIST, issueIdOrKey: 'LC-1', cloudId: 'c' })
  const r: any = await $.tool.call({ tool: `${P}transitionJiraIssue`, issueIdOrKey: 'LC-2', cloudId: 'c' })
  expect(denied(r)).toContain('LC-2')
  expect(w.reached).toEqual([LIST])
})

test('getJiraIssue alone does not count, even asking for comments', async ($: any, on: any) => {
  const w = world(on)
  await $.tool.call({ tool: GET, issueIdOrKey: 'LC-2118', fields: ['comment'], cloudId: 'c' })
  const r: any = await $.tool.call({ tool: `${P}addOrEditJiraIssueComment`, issueIdOrKey: 'LC-2118', commentBody: 'x', cloudId: 'c' })
  expect(denied(r)).toContain('REFUSED')
  expect(w.reached).toEqual([GET])
})

test('a runner-wrapped comment read counts', async ($: any, on: any) => {
  const w = world(on)
  await $.tool.call({ tool: `${P}executeRead`, name: 'listJiraIssueComments', cloudId: 'c', inputs: { issueIdOrKey: 'LC-5' } })
  await $.tool.call({ tool: `${P}editJiraIssue`, issueIdOrKey: 'LC-5', cloudId: 'c' })
  expect(w.reached.length).toBe(2)
})

test('other tools and other connectors are ignored', async ($: any, on: any) => {
  const w = world(on)
  await $.tool.call({ tool: `${P}searchJiraIssuesUsingJql`, jql: 'x', cloudId: 'c' })
  await $.tool.call({ tool: 'mcp__github__add_issue_comment', body: 'x' })
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(w.reached.length).toBe(3)
  expect(w.toasts.length).toBe(0)
})
