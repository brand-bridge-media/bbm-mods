import { test, expect } from 'claude-code/testing'

// The Python check is tested by its own --selftest (claude-mods.yml runs it). These tests pin the
// mod's plumbing: which calls reach the check, and that a note passes through but nothing else can.

export function world(on: any, answer: { exitCode?: number; stdout?: string; throws?: boolean } = {}) {
  const runs: { argv: string[]; stdin: string }[] = []
  const reached: any[] = []
  on('process.run', (_$: any, e: any) => {
    runs.push({ argv: [...e.argv], stdin: String(e.init?.stdin ?? '') })
    if (answer.throws) throw new Error('spawn failed')
    return { value: { exitCode: answer.exitCode ?? 0, stdout: answer.stdout ?? '', stderr: '' } } as any
  })
  on('tool.call', (_$: any, e: any) => { reached.push(e); return { result: 'ok', text: 'ok' } as any })
  return { runs, reached }
}

const NOTE = "{\"hookSpecificOutput\": {\"hookEventName\": \"PreToolUse\", \"additionalContext\": \"[mod:oversized-file-nudge] x.py is already 1600 lines\"}}"
const DENY = "{\"hookSpecificOutput\": {\"hookEventName\": \"PreToolUse\", \"permissionDecision\": \"deny\", \"permissionDecisionReason\": \"[mod:oversized-file-nudge] no\"}}"
const ASK = DENY.replace('deny', 'ask')

test('a source-file edit reaches the check with its tool input, and the call still runs', async ($: any, on: any) => {
  const w = world(on, { stdout: NOTE })
  const r: any = await $.tool.call({ tool: 'Edit', file_path: '/r/x.py', old_string: 'a', new_string: 'b' })
  expect(r.deny).toBeUndefined()
  expect(w.reached.length).toBe(1) // the note rides along; the note text itself is pinned by the check's --selftest
  expect(w.runs[0]!.argv.slice(0, 2)).toEqual(['python3', '-I'])
  expect(w.runs[0]!.argv[2]).toMatch(/hooks\/oversized-file-nudge\.py$/)
  expect(JSON.parse(w.runs[0]!.stdin).tool_input).toEqual({ file_path: '/r/x.py', old_string: 'a', new_string: 'b' })
})

// Advisory by construction: even if the check ever emitted a deny or an ask, the mod lets the call through.
for (const [label, answer] of [['a deny', { stdout: DENY }], ['an ask', { stdout: ASK }], ['silence', { stdout: '' }],
  ['a non-zero exit', { exitCode: 1, stdout: NOTE }], ['junk output', { stdout: 'not json' }], ['a spawn failure', { throws: true }]] as const) {
  test(`${label} from the check never stops the call`, async ($: any, on: any) => {
    const w = world(on, answer as any)
    const r: any = await $.tool.call({ tool: 'Write', file_path: '/r/x.ts', content: 'x' })
    expect(r.deny).toBeUndefined()
    expect(r.ask).toBeUndefined()
    expect(w.reached.length).toBe(1)
  })
}

for (const path of ['/r/notes.md', '/r/data.json', '/r/x.sql']) {
  test(`${path} never starts the check`, async ($: any, on: any) => {
    const w = world(on, { stdout: NOTE })
    await $.tool.call({ tool: 'Edit', file_path: path, old_string: 'a', new_string: 'b' })
    expect(w.runs.length).toBe(0)
    expect(w.reached.length).toBe(1)
  })
}
