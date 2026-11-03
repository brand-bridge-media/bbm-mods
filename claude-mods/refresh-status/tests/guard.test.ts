import { test, expect } from 'claude-code/testing'

// The Python check has its own --selftest (claude-mods.yml runs it). These tests pin the plumbing:
// which prompts reach the Supabase read, what the check is sent, and that a failure never blocks a prompt.

function world(on: any, opts: { py?: (stdin: any) => string; sql?: { text?: string; isError?: boolean; throws?: boolean } } = {}) {
  const runs: any[] = []
  const calls: any[] = []
  on('process.run', (_$: any, e: any) => {
    const stdin = JSON.parse(String(e.init?.stdin ?? '{}'))
    runs.push(stdin)
    return { value: { exitCode: 0, stdout: opts.py ? opts.py(stdin) : '', stderr: '' } } as any
  })
  on('tool.list', () => ({ value: [{ name: 'mcp__uuid-1__execute_sql' }] }) as any)
  on('mcp.call', (_$: any, e: any) => {
    calls.push(e)
    if (opts.sql?.throws) throw new Error('mcp down')
    return { value: { isError: !!opts.sql?.isError, content: [{ type: 'text', text: opts.sql?.text ?? '[]' }] } } as any
  })
  return { runs, calls }
}

const fake = (s: any) =>
  s.rows !== undefined || s.error !== undefined
    ? JSON.stringify({ hookSpecificOutput: { additionalContext: `CTX rows=${JSON.stringify(s.rows ?? null)} error=${s.error ?? ''}` } })
    : /^refresh status/i.test(s.prompt) ? JSON.stringify({ match: true, sql: 'select 1' }) : ''

test('a non-matching prompt never reaches the database', async ($: any, on: any) => {
  const w = world(on, { py: fake })
  on('prompt.submit', (_$: any, e: any) => ({ text: e.text, context: e.context }))
  const r: any = await $.prompt.submit({ text: 'hello there' })
  expect(w.calls.length).toBe(0)
  expect(r.context).toBeUndefined()
})

test('"refresh status" reads the view and attaches the context', async ($: any, on: any) => {
  const w = world(on, { py: fake, sql: { text: '<untrusted-data-x>[{"run_id":"r1"}]</untrusted-data-x>' } })
  on('prompt.submit', (_$: any, e: any) => ({ text: e.text, context: e.context }))
  const r: any = await $.prompt.submit({ text: 'Refresh Status' })
  expect(w.calls[0].tool).toBe('execute_sql')
  expect(w.calls[0].args.query).toBe('select 1')
  expect(r.context[0]).toContain('rows=[{"run_id":"r1"}]')
})

test('a failed read is handed on as an error, so the model says NOT CHECKED', async ($: any, on: any) => {
  world(on, { py: fake, sql: { isError: true } })
  on('prompt.submit', (_$: any, e: any) => ({ text: e.text, context: e.context }))
  const r: any = await $.prompt.submit({ text: 'refresh status' })
  expect(r.context[0]).toContain('error=execute_sql returned an error')
})

test('a check that cannot even match lets the prompt through unchanged', async ($: any, on: any) => {
  world(on, { py: () => '' })
  on('prompt.submit', (_$: any, e: any) => ({ text: e.text, context: e.context }))
  const r: any = await $.prompt.submit({ text: 'refresh status' })
  expect(r.text).toBe('refresh status')
  expect(r.context).toBeUndefined()
})

test('a match whose second check call returns nothing attaches NOT CHECKED', async ($: any, on: any) => {
  const w = world(on, { py: (s: any) => (s.rows !== undefined || s.error !== undefined ? '' : JSON.stringify({ match: true, sql: 'select 1' })),
                        sql: { text: '[{"status_table_md":"| Stage |"}]' } })
  on('prompt.submit', (_$: any, e: any) => ({ text: e.text, context: e.context }))
  const r: any = await $.prompt.submit({ text: 'refresh status' })
  expect(w.calls.length).toBe(1)
  expect(r.context[0]).toContain('NOT CHECKED')
})
