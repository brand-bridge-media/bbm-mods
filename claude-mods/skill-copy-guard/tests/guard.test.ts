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

const DENY = "{\"hookSpecificOutput\": {\"hookEventName\": \"PreToolUse\", \"permissionDecision\": \"deny\", \"permissionDecisionReason\": \"[mod:skill-copy-guard] REFUSED: test\"}}"

test('a call the check denies never reaches the tool; the reason is toasted', async ($: any, on: any) => {
  const w = world(on, { stdout: DENY })
  const r: any = await $.tool.call({ tool: 'Write', file_path: '/r/.claude/skills/x/SKILL.md', content: 'x' })
  expect(String(r.deny ?? r.text)).toContain('[mod:skill-copy-guard] REFUSED')
  expect(w.reached.length).toBe(0)
  expect(w.toasts[0]).toContain('[mod:skill-copy-guard]')
  expect(w.runs[0]!.argv.slice(0, 2)).toEqual(['python3', '-I'])
  expect(w.runs[0]!.argv[2]).toMatch(/hooks\/skill-copy-guard\.py$/)
  const sent = JSON.parse(w.runs[0]!.stdin)
  expect(sent.tool_input).toEqual({ file_path: '/r/.claude/skills/x/SKILL.md', content: 'x' })
})

for (const [label, answer] of [['silence', { stdout: '' }], ['a non-zero exit', { exitCode: 1, stdout: DENY }],
  ['junk output', { stdout: 'not json' }], ['a spawn failure', { throws: true }]] as const) {
  test(`${label} from the check lets the call through (fail open)`, async ($: any, on: any) => {
    const w = world(on, answer as any)
    const r: any = await $.tool.call({ tool: 'Write', file_path: '/r/.claude/skills/x/SKILL.md', content: 'x' })
    expect(r.deny).toBeUndefined()
    expect(w.reached.length).toBe(1)
  })
}

test('an unrelated call never starts the check', async ($: any, on: any) => {
  const w = world(on, { stdout: DENY })
  const r: any = await $.tool.call({ tool: 'Write', file_path: '/r/notes.md', content: 'x' })
  expect(r.deny).toBeUndefined()
  expect(w.runs.length).toBe(0)
  expect(w.reached.length).toBe(1)
})
