import { test, expect } from 'claude-code/testing'

// Decisions are tested by the Python check's own --selftest (claude-mods.yml runs it). These tests pin
// the plumbing: what the check is sent, how its verdict maps to a block, and that every failure fails open.

const T0 = Date.parse('2026-11-03T22:00:00Z')
const ses = (parent?: string) => ({ content: [{ type: 'text', text: JSON.stringify({ ccr: { id: 's1', ...(parent ? { parent_session_id: parent } : {}) } }) }] })
const BLOCKING = JSON.stringify({ verdict: 'BLOCK', reason: '1 open', block: '[mod:idle-backstop-guard] schedule a check-in\nsecond line' })

function world(on: any, o: { out?: any; throws?: boolean; session?: any; children?: string; watching?: Record<string, string> } = {}) {
  const runs: { argv: string[]; payload: any }[] = []
  const toasts: string[] = []
  const logs: string[] = []
  on('clock.now', () => ({ value: T0 }) as any)
  on('ui.toast', (_$: any, e: any) => { toasts.push(e.text); return { value: undefined } as any })
  on('ui.log', (_$: any, e: any) => { logs.push(e.text ?? e.message ?? JSON.stringify(e)); return { value: undefined } as any })
  on('mcp.call', () => ({ value: o.session ?? ses() }) as any)
  on('process.run', (_$: any, e: any) => {
    runs.push({ argv: [...e.argv], payload: JSON.parse(String(e.init?.stdin ?? '{}')) })
    if (o.throws) throw new Error('spawn failed')
    return { value: o.out ?? { exitCode: 0, stdout: BLOCKING, stderr: '' } } as any
  })
  on('tool.call', (_$: any, e: any) => {
    if (e.tool === 'mcp__fleet-tracker__open_children') return o.children === undefined ? { isError: true, result: 'no such tool' } : { result: o.children }
    const m = String(e.tool).match(/^mcp__(.+)__watching$/)
    if (m) return o.watching?.[m[1]!] === undefined ? { isError: true, result: 'no such tool' } : { result: o.watching[m[1]!] }
    return { result: 'ok' }
  })
  on('classic.Stop', () => ({}))
  return { runs, toasts, logs }
}

test('Stop sends the check what it needs and a BLOCK ends in a block with the check\'s text', async ($: any, on: any) => {
  const w = world(on, { children: 'Open fleet children: 1\n- LC-1 (x) WORKING session_a', watching: { 'pr-ci-watch': '{"active":[],"finished":[]}' } })
  await $.tool.call({ tool: 'mcp__claude-code-remote__send_later', delay_minutes: 30, message: 'm' })
  const s: any = await $.classic.Stop({ stop_hook_active: false })
  expect(s.block).toContain('[mod:idle-backstop-guard] schedule a check-in')
  expect(w.runs[0]!.argv.slice(0, 2)).toEqual(['python3', '-I'])
  expect(w.runs[0]!.argv[2]).toMatch(/hooks\/idle-backstop-guard\.py$/)
  const p = w.runs[0]!.payload
  expect(p.now_ms).toBe(T0)
  expect(p.children).toContain('LC-1')
  expect(p.watchers['pr-ci-watch']).toBe('{"active":[],"finished":[]}')
  expect(p.watchers['dispatch-watch']).toBeNull() // a watcher that is not loaded is null, not "empty"
  expect(JSON.parse(JSON.stringify(p.session)) ?? '').toContain('s1')
  expect(p.calls).toEqual([{ tool: 'mcp__claude-code-remote__send_later', input: { delay_minutes: 30, message: 'm' }, result: 'ok', at_ms: T0 }])
  expect(w.toasts[0]).toBe('[mod:idle-backstop-guard] schedule a check-in') // first line only
  expect(w.logs.join(' ')).toContain('receipt: BLOCK')
})

test('a PASS or NOT CHECKED verdict lets the turn end; NOT CHECKED is toasted', async ($: any, on: any) => {
  const w = world(on, { out: { exitCode: 0, stdout: JSON.stringify({ verdict: 'NOT CHECKED', reason: 'could not read fleet-tracker', block: null }) } })
  expect((await $.classic.Stop({ stop_hook_active: false })).block).toBeUndefined()
  expect(w.toasts[0]).toContain('NOT CHECKED: could not read fleet-tracker')
})

test('a PASS is silent', async ($: any, on: any) => {
  const w = world(on, { out: { exitCode: 0, stdout: JSON.stringify({ verdict: 'PASS', reason: 'no open', block: null }) } })
  expect((await $.classic.Stop({ stop_hook_active: false })).block).toBeUndefined()
  expect(w.toasts).toEqual([])
})

for (const [label, o] of [
  ['a spawn failure', { throws: true }],
  ['a non-zero exit', { out: { exitCode: 1, stdout: BLOCKING } }],
  ['junk output', { out: { exitCode: 0, stdout: 'not json' } }],
  ['silence', { out: { exitCode: 0, stdout: '' } }],
  ['an unknown verdict string', { out: { exitCode: 0, stdout: JSON.stringify({ verdict: 'pass', reason: 'x', block: null }) } }],
  ['a BLOCK with no text', { out: { exitCode: 0, stdout: JSON.stringify({ verdict: 'BLOCK', reason: 'x', block: null }) } }],
  ['a BLOCK with empty text', { out: { exitCode: 0, stdout: JSON.stringify({ verdict: 'BLOCK', reason: 'x', block: '' }) } }],
] as const) {
  test(`${label} from the check fails open with a NOT CHECKED toast`, async ($: any, on: any) => {
    const w = world(on, o as any)
    expect((await $.classic.Stop({ stop_hook_active: false })).block).toBeUndefined()
    expect(w.toasts[0]).toContain('NOT CHECKED')
  })
}

test('a malformed BLOCK does not count as a refusal', async ($: any, on: any) => {
  const w = world(on, { out: { exitCode: 0, stdout: JSON.stringify({ verdict: 'BLOCK', reason: 'x', block: null }) } })
  for (let i = 0; i < 4; i++) await $.classic.Stop({ stop_hook_active: i > 0 })
  expect(w.runs.map(r => r.payload.blocks)).toEqual([0, 0, 0, 0])
})

test('the refusal count rises on BLOCK and is sent to the check; PASS resets it', async ($: any, on: any) => {
  const w = world(on)
  await $.classic.Stop({ stop_hook_active: false })
  await $.classic.Stop({ stop_hook_active: true })
  expect(w.runs.map(r => r.payload.blocks)).toEqual([0, 1])
})

test('a released turn re-arms the guard: the count returns to zero', async ($: any, on: any) => {
  const o: any = {}
  const w = world(on, o)
  await $.classic.Stop({ stop_hook_active: false }) // BLOCK -> count 1
  await $.classic.Stop({ stop_hook_active: true }) // BLOCK -> count 2
  o.out = { exitCode: 0, stdout: JSON.stringify({ verdict: 'NOT CHECKED', reason: 'released after 3 refusals', block: null, released: true }) }
  await $.classic.Stop({ stop_hook_active: true }) // released -> count 0
  o.out = undefined
  await $.classic.Stop({ stop_hook_active: false })
  expect(w.runs.map(r => r.payload.blocks)).toEqual([0, 1, 2, 0])
})

test('a check-in call that failed is not recorded', async ($: any, on: any) => {
  // The more specific handler goes first, as in unwatched-job-guard's own test.
  on('tool.call', { tool: /send_later$/ }, () => ({ isError: true, result: 'permission denied' }))
  const w = world(on)
  await $.tool.call({ tool: 'mcp__claude-code-remote__send_later', delay_minutes: 30, message: 'm' })
  await $.classic.Stop({ stop_hook_active: false })
  expect(w.runs[0]!.payload.calls).toEqual([])
})

test('create_trigger arguments reach the check as given', async ($: any, on: any) => {
  const w = world(on)
  await $.tool.call({ tool: 'mcp__claude-code-remote__create_trigger', name: 'n', prompt: 'p', run_once_at: '2026-11-03T22:20:00Z', initiation: 'own_followup' })
  await $.classic.Stop({ stop_hook_active: false })
  expect(w.runs[0]!.payload.calls[0].input).toEqual({ name: 'n', prompt: 'p', run_once_at: '2026-11-03T22:20:00Z', initiation: 'own_followup' })
  expect(w.runs[0]!.payload.calls[0].tool).toBe('mcp__claude-code-remote__create_trigger')
})

test('other tools are not recorded as check-ins', async ($: any, on: any) => {
  const w = world(on)
  await $.tool.call({ tool: 'ScheduleWakeup', delaySeconds: 600 })
  await $.tool.call({ tool: 'mcp__claude-code-remote__list_triggers' })
  await $.classic.Stop({ stop_hook_active: false })
  expect(w.runs[0]!.payload.calls).toEqual([])
})
