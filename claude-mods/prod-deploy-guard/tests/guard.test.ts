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

const DENY = JSON.stringify({ hookSpecificOutput: {
  hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: '[mod:prod-deploy-guard] REFUSED: wrangler deploy' } })

test('a deploy the check denies never reaches the tool; the reason is toasted', async ($: any, on: any) => {
  const w = world(on, { stdout: DENY })
  const r: any = await $.tool.call({ tool: 'Bash', command: 'npx wrangler deploy' })
  expect(String(r.deny ?? r.text)).toContain('[mod:prod-deploy-guard] REFUSED')
  expect(w.reached.length).toBe(0)
  expect(w.toasts[0]).toContain('[mod:prod-deploy-guard]')
  expect(w.runs[0]!.argv[0]).toBe('python3')
  expect(w.runs[0]!.argv[2]).toMatch(/hooks\/prod-deploy-guard\.py$/)
  const sent = JSON.parse(w.runs[0]!.stdin)
  expect(sent.tool_name).toBe('Bash')
  expect(sent.tool_input).toEqual({ command: 'npx wrangler deploy' })
})

// One test per failure shape: the kit takes a test's hooks before its first call.
for (const [label, answer] of [['silence', { stdout: '' }], ['a non-zero exit', { exitCode: 1, stdout: DENY }],
  ['junk output', { stdout: 'not json' }], ['a spawn failure', { throws: true }]] as const) {
  test(`${label} from the check lets the call through (fail open)`, async ($: any, on: any) => {
    const w = world(on, answer as any)
    const r: any = await $.tool.call({ tool: 'Bash', command: 'ls' })
    expect(r.deny).toBeUndefined()
    expect(w.reached.length).toBe(1)
  })
}

test('the check runs for Supabase SQL and deploy tools, not for unrelated tools', async ($: any, on: any) => {
  const w = world(on)
  await $.tool.call({ tool: 'mcp__Supabase__execute_sql', project_id: 'p', query: 'select 1' })
  await $.tool.call({ tool: 'mcp__Supabase__deploy_edge_function', name: 'f' })
  expect(w.runs.length).toBe(2)
  await $.tool.call({ tool: 'mcp__Supabase__list_tables' })
  await $.tool.call({ tool: 'Read', file_path: '/x' })
  expect(w.runs.length).toBe(2)
})

test('an ask from the check is not turned into a deny', async ($: any, on: any) => {
  const ASK = JSON.stringify({ hookSpecificOutput: { permissionDecision: 'ask', permissionDecisionReason: '[mod:prod-deploy-guard] apply_migration' } })
  const w = world(on, { stdout: ASK })
  const r: any = await $.tool.call({ tool: 'mcp__Supabase__apply_migration', name: 'm', query: 'alter table t add c int' })
  expect(r.deny).toBeUndefined()
  expect(w.toasts[0]).toContain('apply_migration')
})
