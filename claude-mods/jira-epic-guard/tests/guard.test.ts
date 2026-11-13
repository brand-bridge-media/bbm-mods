import { test, expect } from 'claude-code/testing'

// The Python check (decisions, epic list, data file) is tested by its own --selftest (claude-mods.yml
// runs it). These tests pin the mod's plumbing: which calls reach the check, what it is sent, how its
// verdict maps.

export function world(on: any, answer: { exitCode?: number; stdout?: string; throws?: boolean } = {}) {
  const runs: { argv: string[]; stdin: string }[] = []
  const toasts: string[] = []
  const reached: any[] = []
  on('process.run', (_$: any, e: any) => {
    runs.push({ argv: [...e.argv], stdin: String(e.init?.stdin ?? '') })
    if (answer.throws) throw new Error('spawn failed')
    return { value: { exitCode: answer.exitCode ?? 0, stdout: answer.stdout ?? '', stderr: '' } } as any
  })
  on('ui.toast', (_$: any, e: any) => { toasts.push(e.text); return { value: undefined } as any })
  on('tool.call', (_$: any, e: any) => { reached.push(e); return { result: 'ok', text: 'ok' } as any })
  return { runs, toasts, reached }
}

const DENY = "{\"hookSpecificOutput\": {\"hookEventName\": \"PreToolUse\", \"permissionDecision\": \"deny\", \"permissionDecisionReason\": \"[mod:jira-epic-guard] Every LC ticket needs an epic\"}}"
const CREATE = { projectKey: 'LC', issueTypeName: 'Task', summary: 's', cloudId: 'c' }

for (const tool of ['mcp__Atlassian__createJiraIssue', 'mcp__Atlassian_MCP__createJiraIssue', 'mcp__Renamed__createJiraIssue']) {
  test(`${tool}: a call the check denies never reaches the tool; the reason is toasted`, async ($: any, on: any) => {
    const w = world(on, { stdout: DENY })
    const r: any = await $.tool.call({ tool, ...CREATE })
    expect(String(r.deny ?? r.text)).toContain('[mod:jira-epic-guard] Every LC ticket needs an epic')
    expect(w.reached.length).toBe(0)
    expect(w.toasts[0]).toContain('[mod:jira-epic-guard]')
    expect(w.runs[0]!.argv.slice(0, 2)).toEqual(['python3', '-I'])
    expect(w.runs[0]!.argv[2]).toMatch(/hooks\/jira-epic-guard\.py$/)
    const sent = JSON.parse(w.runs[0]!.stdin)
    expect(sent.tool_name).toBe(tool)
    expect(sent.tool_input).toEqual(CREATE)
  })
}

test('the executeWrite runner reaches the check with its name and inputs', async ($: any, on: any) => {
  const w = world(on, { stdout: DENY })
  const call = { name: 'createJiraIssue', cloudId: 'c', inputs: { projectKey: 'LC', issueTypeName: 'Task', summary: 's' } }
  const r: any = await $.tool.call({ tool: 'mcp__Atlassian_MCP__executeWrite', ...call })
  expect(String(r.deny ?? r.text)).toContain('[mod:jira-epic-guard]')
  expect(w.reached.length).toBe(0)
  expect(JSON.parse(w.runs[0]!.stdin).tool_input).toEqual(call)
})

test('a call the check allows (silence) reaches the tool with no toast', async ($: any, on: any) => {
  const w = world(on, { stdout: '' })
  const r: any = await $.tool.call({ tool: 'mcp__Atlassian__createJiraIssue', ...CREATE, parent: 'LC-429' })
  expect(r.deny).toBeUndefined()
  expect(w.reached.length).toBe(1)
  expect(w.toasts.length).toBe(0)
})

for (const [label, answer] of [['a non-zero exit', { exitCode: 1, stdout: DENY }],
  ['junk output', { stdout: 'not json' }], ['a spawn failure', { throws: true }]] as const) {
  test(`${label} from the check lets the call through (fail open)`, async ($: any, on: any) => {
    const w = world(on, answer as any)
    const r: any = await $.tool.call({ tool: 'mcp__Atlassian__createJiraIssue', ...CREATE })
    expect(r.deny).toBeUndefined()
    expect(w.reached.length).toBe(1)
  })
}

test('unrelated Atlassian and other tools never start the check', async ($: any, on: any) => {
  const w = world(on, { stdout: DENY })
  for (const tool of ['mcp__Atlassian__editJiraIssue', 'mcp__Atlassian_MCP__executeRead', 'mcp__Atlassian__getJiraIssue',
    'mcp__Other__executeWrite', 'Bash']) {
    const r: any = await $.tool.call({ tool, name: 'createJiraIssue', projectKey: 'LC' })
    expect(r.deny).toBeUndefined()
  }
  expect(w.runs.length).toBe(0)
  expect(w.reached.length).toBe(5)
})
