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
  on('tool.call', (_$: any, e: any) => { reached.push(e); return { result: 'ok', text: '{\"key\":\"LCH-9\"}' } as any })
  return { runs, toasts, reached }
}

const note = (event: string, text: string) =>
  JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text } })

test('session start carries the naming convention', async ($: any, on: any) => {
  const w = world(on, { stdout: note('SessionStart', '[mod:session-title-nudge] Name this session') })
  on('classic.SessionStart', () => ({}))
  const r: any = await $.classic.SessionStart({ source: 'startup' })
  expect(r.additionalContext).toEqual(['[mod:session-title-nudge] Name this session'])
  expect(JSON.parse(w.runs[0]!.stdin)).toEqual({ hook_event_name: 'SessionStart' })
})

test('a new ticket gets the rename reminder, read from the create result', async ($: any, on: any) => {
  const w = world(on, { stdout: note('PostToolUse', '[mod:session-title-nudge] LCH-9 now exists') })
  const r: any = await $.tool.call({ tool: 'mcp__Atlassian__createJiraIssue', cloudId: 'c', projectKey: 'LCH' })
  expect(r.context).toEqual(['[mod:session-title-nudge] LCH-9 now exists'])
  expect(JSON.parse(w.runs[0]!.stdin).tool_response).toBe('{"key":"LCH-9"}')
})

test('a failed check adds nothing', async ($: any, on: any) => {
  world(on, { throws: true })
  const r: any = await $.tool.call({ tool: 'mcp__Atlassian__createJiraIssue', cloudId: 'c', projectKey: 'LCH' })
  expect(r.context).toBeUndefined()
})
