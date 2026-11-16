import { test, expect } from 'claude-code/testing'

// The Python check (what counts as a correction, what closes it) is tested by its own --selftest (claude-mods.yml runs
// it). These tests pin the mod's plumbing: which calls reach the check, what it is sent, and that a note passes through
// while nothing else can stop a call.

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

const NOTE = "{\"hookSpecificOutput\": {\"hookEventName\": \"PreToolUse\", \"additionalContext\": \"[mod:correction-needs-check] name the check\"}}"
const DENY = "{\"hookSpecificOutput\": {\"hookEventName\": \"PreToolUse\", \"permissionDecision\": \"deny\", \"permissionDecisionReason\": \"[mod:correction-needs-check] no\"}}"
const ASK = DENY.replace('deny', 'ask')
const INSERT = { tool: 'mcp__Supabase__execute_sql', project_id: 'p', query: "INSERT INTO public.knowledge_memories (content, memory_type) VALUES ('x', 'lesson')" }

test('a knowledge memory insert reaches the check with its query, and the insert still runs', async ($: any, on: any) => {
  const w = world(on, { stdout: NOTE })
  const r: any = await $.tool.call(INSERT)
  expect(r.deny).toBeUndefined()
  expect(w.reached.length).toBe(1)
  expect(w.runs[0]!.argv.slice(0, 2)).toEqual(['python3', '-I'])
  expect(w.runs[0]!.argv[2]).toMatch(/hooks\/correction-needs-check\.py$/)
  const sent = JSON.parse(w.runs[0]!.stdin)
  expect(sent.tool_name).toBe('mcp__Supabase__execute_sql')
  expect(sent.tool_input.query).toBe(INSERT.query)
})

for (const path of ['/r/CLAUDE.md', '/s/living-cozy/skills/x/SKILL.md', '/tmp/claude/memory/team/silo/x.md', 'C:\\r\\CLAUDE.md']) {
  test(`a write to ${path} reaches the check, and the write still runs`, async ($: any, on: any) => {
    const w = world(on, { stdout: NOTE })
    const r: any = await $.tool.call({ tool: 'Edit', file_path: path, old_string: 'a', new_string: 'b' })
    expect(r.deny).toBeUndefined()
    expect(w.runs.length).toBe(1)
    expect(JSON.parse(w.runs[0]!.stdin).tool_input).toEqual({ file_path: path, old_string: 'a', new_string: 'b' })
    expect(w.reached.length).toBe(1)
  })
}

for (const call of [
  { tool: 'Edit', file_path: '/r/README.md', old_string: 'a', new_string: 'b' },
  { tool: 'Write', file_path: '/r/x.py', content: 'x' },
  { tool: 'mcp__Supabase__execute_sql', project_id: 'p', query: 'select * from knowledge_memories' },
  { tool: 'mcp__Supabase__execute_sql', project_id: 'p', query: "insert into products values ('x')" },
]) {
  test(`${call.tool} ${'file_path' in call ? call.file_path : call.query.slice(0, 30)} never starts the check`, async ($: any, on: any) => {
    const w = world(on, { stdout: NOTE })
    await $.tool.call(call)
    expect(w.runs.length).toBe(0)
    expect(w.reached.length).toBe(1)
  })
}

// Advisory by construction: even if the check ever emitted a deny or an ask, the mod lets the call through.
for (const [label, answer] of [['a deny', { stdout: DENY }], ['an ask', { stdout: ASK }], ['silence', { stdout: '' }],
  ['a non-zero exit', { exitCode: 1, stdout: NOTE }], ['junk output', { stdout: 'not json' }], ['a spawn failure', { throws: true }]] as const) {
  for (const call of [INSERT, { tool: 'Write', file_path: '/r/CLAUDE.md', content: 'x' }]) {
    test(`${label} from the check never stops ${call.tool}`, async ($: any, on: any) => {
      const w = world(on, answer as any)
      const r: any = await $.tool.call(call)
      expect(r.deny).toBeUndefined()
      expect(r.ask).toBeUndefined()
      expect(w.reached.length).toBe(1)
    })
  }
}
