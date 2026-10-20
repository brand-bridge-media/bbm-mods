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
  on('tool.call', (_$: any, e: any) => { reached.push(e); return { result: 'ok', text: '[{\"id\":\"x\"}]' } as any })
  return { runs, toasts, reached }
}

const NOTE = JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: '[mod:knowledge-superseded-check] superseded' } })
const Q = { tool: 'mcp__Supabase__execute_sql', project_id: 'p', query: 'select * from knowledge_memories' }

test('a knowledge read gets the check\'s note after its result; the result is what the check reads', async ($: any, on: any) => {
  const w = world(on, { stdout: NOTE })
  const r: any = await $.tool.call(Q)
  expect(r.context).toEqual(['[mod:knowledge-superseded-check] superseded'])
  expect(w.reached.length).toBe(1)
  const sent = JSON.parse(w.runs[0]!.stdin)
  expect(sent.tool_input.query).toBe('select * from knowledge_memories')
  expect(sent.tool_response).toBe('[{"id":"x"}]')
})

test('SQL that names no knowledge table never starts the check', async ($: any, on: any) => {
  const w = world(on, { stdout: NOTE })
  const r: any = await $.tool.call({ ...Q, query: 'select 1' })
  expect(r.context).toBeUndefined()
  expect(w.runs.length).toBe(0)
})

for (const [label, answer] of [['silence', { stdout: '' }], ['a spawn failure', { throws: true }]] as const) {
  test(`${label} from the check adds nothing`, async ($: any, on: any) => {
    world(on, answer as any)
    const r: any = await $.tool.call(Q)
    expect(r.context).toBeUndefined()
  })
}
