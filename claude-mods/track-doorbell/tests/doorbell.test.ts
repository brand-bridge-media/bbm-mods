import { test, expect } from 'claude-code/testing'

// The Python check is tested by its own --selftest (claude-mods.yml runs it). These tests pin
// the mod's plumbing: which calls reach the check, what it is sent, how its verdict maps.

const RING = '{"ask_track":{"request_id":7,"ring":{"kind":"session","session_id":"session_DESK","message":"Cross-track request #7"}}}'

export function world(on: any, answer: { exitCode?: number; stdout?: string; throws?: boolean } = {}) {
  const runs: { argv: string[]; stdin: string }[] = []
  const toasts: string[] = []
  on('process.run', (_$: any, e: any) => {
    runs.push({ argv: [...e.argv], stdin: String(e.init?.stdin ?? '') })
    if (answer.throws) throw new Error('spawn failed')
    return { value: { exitCode: answer.exitCode ?? 0, stdout: answer.stdout ?? '', stderr: '' } } as any
  })
  on('ui.toast', (_$: any, e: any) => { toasts.push(e.text); return { value: undefined } as any })
  on('tool.call', () => ({ result: 'ok', text: RING }) as any)
  return { runs, toasts }
}

const note = (text: string) =>
  JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: text } })
const BLOCK = JSON.stringify({ decision: 'block', reason: '[mod:track-doorbell] never messaged session_DESK' })

test('an execute_sql result reaches the check and its ring note is added to the result', async ($: any, on: any) => {
  const w = world(on, { stdout: note('[mod:track-doorbell] Ring now: send_message to session_DESK') })
  const r: any = await $.tool.call({ tool: 'mcp__Supabase__execute_sql', project_id: 'p', query: 'select 1' })
  expect(r.context).toEqual(['[mod:track-doorbell] Ring now: send_message to session_DESK'])
  const sent = JSON.parse(w.runs[0]!.stdin)
  expect(sent.hook_event_name).toBe('PostToolUse')
  expect(sent.tool_name).toBe('mcp__Supabase__execute_sql')
  expect(sent.tool_response).toBe(RING)
})

test('other tools never reach the check', async ($: any, on: any) => {
  const w = world(on, { stdout: note('x') })
  await $.tool.call({ tool: 'mcp__Supabase__list_tables', project_id: 'p' })
  expect(w.runs.length).toBe(0)
})

test('a failed check adds nothing to the SQL result', async ($: any, on: any) => {
  world(on, { throws: true })
  const r: any = await $.tool.call({ tool: 'mcp__Supabase__execute_sql', project_id: 'p', query: 'select 1' })
  expect(r.context).toBeUndefined()
})

test('an unsent ring blocks the stop; the stop payload is forwarded with its event name', async ($: any, on: any) => {
  const w = world(on, { stdout: BLOCK })
  on('classic.Stop', () => ({}))
  const r: any = await $.classic.Stop({ stop_hook_active: false, transcript_path: '/t.jsonl' })
  expect(r.block).toBe('[mod:track-doorbell] never messaged session_DESK')
  expect(w.toasts[0]).toContain('[mod:track-doorbell]')
  const sent = JSON.parse(w.runs[0]!.stdin)
  expect(sent.hook_event_name).toBe('Stop')
  expect(sent.transcript_path).toBe('/t.jsonl')
})

for (const [label, answer] of [['silence', { stdout: '' }], ['a non-zero exit', { exitCode: 1, stdout: BLOCK }],
  ['junk output', { stdout: 'not json' }], ['a spawn failure', { throws: true }]] as const) {
  test(`${label} from the check lets the turn end`, async ($: any, on: any) => {
    world(on, answer as any)
    on('classic.Stop', () => ({}))
    const r: any = await $.classic.Stop({ stop_hook_active: false })
    expect(r.block).toBeUndefined()
  })
}
