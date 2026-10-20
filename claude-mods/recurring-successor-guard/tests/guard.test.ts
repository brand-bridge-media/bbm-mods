import { test, expect } from 'claude-code/testing'

// The Python check is tested by its own --selftest (claude-mods.yml runs it). These tests pin
// the mod's plumbing: which calls reach the check, what it is sent, how its verdict maps.

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

const DENY = "{\"hookSpecificOutput\": {\"hookEventName\": \"PreToolUse\", \"permissionDecision\": \"deny\", \"permissionDecisionReason\": \"[mod:recurring-successor-guard] REFUSED: test\"}}"

test('a call the check denies never reaches the tool; the reason is toasted', async ($: any, on: any) => {
  const w = world(on, { stdout: DENY })
  const r: any = await $.tool.call({ tool: 'mcp__Atlassian__transitionJiraIssue', cloudId: 'c', issueIdOrKey: 'LC-5', transition: { id: '41' } })
  expect(String(r.deny ?? r.text)).toContain('[mod:recurring-successor-guard] REFUSED')
  expect(w.reached.length).toBe(0)
  expect(w.toasts[0]).toContain('[mod:recurring-successor-guard]')
  expect(w.runs[0]!.argv.slice(0, 2)).toEqual(['python3', '-I'])
  expect(w.runs[0]!.argv[2]).toMatch(/hooks\/recurring-successor-guard\.py$/)
  const sent = JSON.parse(w.runs[0]!.stdin)
  expect(sent.tool_input).toEqual({ cloudId: 'c', issueIdOrKey: 'LC-5', transition: { id: '41' } })
})

for (const [label, answer] of [['silence', { stdout: '' }], ['a non-zero exit', { exitCode: 1, stdout: DENY }],
  ['junk output', { stdout: 'not json' }], ['a spawn failure', { throws: true }]] as const) {
  test(`${label} from the check lets the call through (fail open)`, async ($: any, on: any) => {
    const w = world(on, answer as any)
    const r: any = await $.tool.call({ tool: 'mcp__Atlassian__transitionJiraIssue', cloudId: 'c', issueIdOrKey: 'LC-5', transition: { id: '41' } })
    expect(r.deny).toBeUndefined()
    expect(w.reached.length).toBe(1)
  })
}

test('an unrelated call never starts the check', async ($: any, on: any) => {
  const w = world(on, { stdout: DENY })
  const r: any = await $.tool.call({ tool: 'mcp__Atlassian__editJiraIssue', cloudId: 'c', issueIdOrKey: 'LC-5' })
  expect(r.deny).toBeUndefined()
  expect(w.runs.length).toBe(0)
  expect(w.reached.length).toBe(1)
})

test('the ticket and transitions the session read are handed to the check as transcript rows', async ($: any, on: any) => {
  const w = world(on, { stdout: '' })
  await $.tool.call({ tool: 'mcp__Atlassian__getJiraIssue', cloudId: 'c', issueIdOrKey: 'LC-5' })
  await $.tool.call({ tool: 'mcp__Atlassian__getTransitionsForJiraIssue', cloudId: 'c', issueIdOrKey: 'LC-5' })
  await $.tool.call({ tool: 'mcp__Atlassian__transitionJiraIssue', cloudId: 'c', issueIdOrKey: 'LC-5', transition: { id: '41' } })
  const sent = JSON.parse(w.runs[0]!.stdin)
  expect(sent.transcript_rows.length).toBe(4)
  expect(sent.transcript_rows[0].message.content[0].name).toBe('mcp__Atlassian__getJiraIssue')
  expect(sent.transcript_rows[1].message.content[0].content).toBe('ok')
  expect(w.reached.length).toBe(3)
})
