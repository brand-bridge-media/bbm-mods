import { test, expect } from 'claude-code/testing'

// The Python check is tested by its own --selftest (claude-mods.yml runs it). These tests pin
// the mod's plumbing: which calls reach the check, what it is sent, how its verdict maps.

function world(on: any, answer: { exitCode?: number; stdout?: string; throws?: boolean } = {}) {
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

const DENY = JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny',
  permissionDecisionReason: '[mod:supabase-guard] REFUSED: CREATE TABLE without ENABLE ROW LEVEL SECURITY' } })
const WARN = JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse',
  additionalContext: '[mod:supabase-guard] WARNING: SECURITY DEFINER' } })
const CREATE = { tool: 'mcp__Supabase__execute_sql', project_id: 'p', query: 'create table public.t (a int)' }

test('a CREATE TABLE the check denies never runs; the reason is toasted', async ($: any, on: any) => {
  const w = world(on, { stdout: DENY })
  const r: any = await $.tool.call(CREATE)
  expect(String(r.deny ?? r.text)).toContain('[mod:supabase-guard] REFUSED')
  expect(w.reached.length).toBe(0)
  expect(w.toasts[0]).toContain('[mod:supabase-guard]')
  expect(w.runs[0]!.argv[2]).toMatch(/hooks\/supabase-guard\.py$/)
  expect(JSON.parse(w.runs[0]!.stdin).tool_input).toEqual({ project_id: 'p', query: 'create table public.t (a int)' })
})

test('a migration-file write starts the check; other writes and non-CREATE SQL do not', async ($: any, on: any) => {
  const w = world(on, { stdout: '' })
  await $.tool.call({ tool: 'Write', file_path: '/r/supabase/migrations/20261020_x.sql', content: 'create table t (a int)' })
  expect(w.runs.length).toBe(1)
  await $.tool.call({ tool: 'Write', file_path: '/r/notes.sql', content: 'create table t (a int)' })
  await $.tool.call({ tool: 'mcp__Supabase__execute_sql', project_id: 'p', query: 'select 1' })
  await $.tool.call({ tool: 'Read', file_path: '/r/supabase/migrations/20261020_x.sql' })
  expect(w.runs.length).toBe(1)
  expect(w.reached.length).toBe(4)
  // A comment between keywords must not slip past the prefilter (CI reviewer, #1921).
  await $.tool.call({ tool: 'mcp__Supabase__execute_sql', project_id: 'p', query: 'create/**/table public.evil (a int)' })
  expect(w.runs.length).toBe(2)
})

test('a warning lets the call run (and the guards beneath it still run)', async ($: any, on: any) => {
  const w = world(on, { stdout: WARN })
  const r: any = await $.tool.call({ ...CREATE, query: 'create function public.f() returns int language sql security definer as $$ select 1 $$' })
  expect(r.deny).toBeUndefined()
  expect(w.reached.length).toBe(1)
})

for (const [label, answer] of [['silence', { stdout: '' }], ['a non-zero exit', { exitCode: 1, stdout: DENY }],
  ['junk output', { stdout: 'not json' }], ['a spawn failure', { throws: true }]] as const) {
  test(`${label} from the check lets the call through (fail open)`, async ($: any, on: any) => {
    const w = world(on, answer as any)
    const r: any = await $.tool.call(CREATE)
    expect(r.deny).toBeUndefined()
    expect(w.reached.length).toBe(1)
  })
}
