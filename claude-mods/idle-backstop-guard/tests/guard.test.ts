import { test, expect } from 'claude-code/testing'

// Decisions are tested by the Python check's own --selftest (claude-mods.yml runs it). These tests pin
// the plumbing: what the check is sent, how its verdict maps to a block, and that every failure fails open.

const T0 = Date.parse('2026-11-03T22:00:00Z')
const ses = (parent?: string) => ({ content: [{ type: 'text', text: JSON.stringify({ ccr: { id: 's1', ...(parent ? { parent_session_id: parent } : {}) } }) }] })
const BLOCKING = JSON.stringify({ verdict: 'BLOCK', reason: '1 open', block: '[mod:idle-backstop-guard] schedule a check-in\nsecond line' })

function world(on: any, o: { out?: any; outs?: any[]; throws?: boolean; session?: any; children?: string; watching?: Record<string, string>; triggers?: string[] } = {}) {
  const listed: any[] = []
  const runs: { argv: string[]; payload: any }[] = []
  const toasts: string[] = []
  const logs: string[] = []
  on('clock.now', () => ({ value: T0 }) as any)
  on('ui.toast', (_$: any, e: any) => { toasts.push(e.text); return { value: undefined } as any })
  on('ui.log', (_$: any, e: any) => { logs.push(e.text ?? e.message ?? JSON.stringify(e)); return { value: undefined } as any })
  on('mcp.call', (_$: any, e: any) => {
    if (e.tool !== 'list_triggers') return { value: o.session ?? ses() } as any
    listed.push(e.args)
    const page = o.triggers?.[listed.length - 1]
    return { value: page === undefined ? { isError: true, content: [{ type: 'text', text: 'no' }] } : { content: [{ type: 'text', text: page }] } } as any
  })
  on('process.run', (_$: any, e: any) => {
    runs.push({ argv: [...e.argv], payload: JSON.parse(String(e.init?.stdin ?? '{}')) })
    if (o.throws) throw new Error('spawn failed')
    const scripted = o.outs?.[runs.length - 1]
    return { value: scripted ?? o.out ?? { exitCode: 0, stdout: BLOCKING, stderr: '' } } as any
  })
  on('tool.call', (_$: any, e: any) => {
    if (e.tool === 'mcp__fleet-tracker__open_children') return o.children === undefined ? { isError: true, result: 'no such tool' } : { result: o.children }
    const m = String(e.tool).match(/^mcp__(.+)__watching$/)
    if (m) return o.watching?.[m[1]!] === undefined ? { isError: true, result: 'no such tool' } : { result: o.watching[m[1]!] }
    return { result: 'ok' }
  })
  on('classic.Stop', () => ({}))
  return { runs, toasts, logs, listed }
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

// LC-2167 owner rule plumbing. The rule itself is pinned by the Python selftest; these pin what the mod does with it.
test('the transcript path reaches the check (the owner rule reads the final reply from it)', async ($: any, on: any) => {
  const w = world(on)
  await $.classic.Stop({ stop_hook_active: false, transcript_path: '/tmp/t.jsonl' })
  expect(w.runs[0]!.payload.transcript_path).toBe('/tmp/t.jsonl')
  await $.classic.Stop({ stop_hook_active: false })
  expect(w.runs[1]!.payload.transcript_path).toBeNull()
})

test('shadow mode: a would-block is toasted and logged, and the turn still ends', async ($: any, on: any) => {
  const shadow = '[mod:idle-backstop-guard] SHADOW owner rule would block: 1 open deliverable(s) and the final reply names no next owner'
  const w = world(on, { out: { exitCode: 0, stdout: JSON.stringify({ verdict: 'PASS', reason: 'no open', block: null,
    owner: { verdict: 'MISS', reason: '1 open' }, shadow }) } })
  expect((await $.classic.Stop({ stop_hook_active: false })).block).toBeUndefined()
  expect(w.toasts).toEqual([shadow])
  expect(w.logs.join(' ')).toContain('owner rule MISS: 1 open')
  expect(w.runs.length).toBe(1)
  await $.classic.Stop({ stop_hook_active: false })
  expect(w.runs[1]!.payload.blocks).toBe(0) // a shadow miss is never a refusal
})

test('an owner-rule BLOCK in enforce mode blocks with its own text', async ($: any, on: any) => {
  const block = '[mod:idle-backstop-guard] Owner rule (LC-2167): this session leaves 1 open deliverable(s)'
  const w = world(on, { out: { exitCode: 0, stdout: JSON.stringify({ verdict: 'BLOCK', reason: 'owner rule: 1 open', block,
    owner: { verdict: 'MISS', reason: '1 open' } }) } })
  expect((await $.classic.Stop({ stop_hook_active: false })).block).toBe(block)
  expect(w.toasts).toEqual([block])
})

// LC-2061: a check-in armed before a restart (or in an earlier turn) is not in `calls`; the server's list has it.
const PASSING = { exitCode: 0, stdout: JSON.stringify({ verdict: 'PASS', reason: '1 open; server-side check-in fires 22:25Z (25 min)', block: null }), stderr: '' }
const pageOf = (rows: unknown[], next?: string) => JSON.stringify({ data: rows, ...(next ? { next_cursor: next } : {}) })

test('a BLOCK is re-asked with the server\'s scheduled tasks, and that answer stands', async ($: any, on: any) => {
  const w = world(on, { outs: [{ exitCode: 0, stdout: BLOCKING, stderr: '' }, PASSING], triggers: [pageOf([{ id: 't1' }])] })
  const s: any = await $.classic.Stop({ stop_hook_active: false })
  expect(s.block).toBeUndefined()
  expect(w.runs.length).toBe(2)
  expect(w.runs[0]!.payload.triggers).toBeUndefined()
  expect(w.runs[1]!.payload.triggers).toEqual([pageOf([{ id: 't1' }])])
  expect(w.listed[0]).toEqual({ enabled: true, limit: 100 })
})

test('the task list is read page by page, following next_cursor, up to three pages', async ($: any, on: any) => {
  const w = world(on, { outs: [{ exitCode: 0, stdout: BLOCKING, stderr: '' }, PASSING],
    triggers: [pageOf([{ id: 'a' }], 'c1'), pageOf([{ id: 'b' }], 'c2'), pageOf([{ id: 'c' }], 'c3'), pageOf([{ id: 'd' }])] })
  await $.classic.Stop({ stop_hook_active: false })
  expect(w.listed.map((a: any) => a.cursor)).toEqual([undefined, 'c1', 'c2'])
  expect(w.runs[1]!.payload.triggers.length).toBe(3)
})

test('a PASS costs no task-list read', async ($: any, on: any) => {
  const w = world(on, { out: PASSING, triggers: [pageOf([])] })
  await $.classic.Stop({ stop_hook_active: false })
  expect(w.listed).toEqual([])
  expect(w.runs.length).toBe(1)
})

test('an unreadable task list leaves the first BLOCK standing', async ($: any, on: any) => {
  const w = world(on, {})
  const s: any = await $.classic.Stop({ stop_hook_active: false })
  expect(s.block).toContain('[mod:idle-backstop-guard] schedule a check-in')
  expect(w.listed.length).toBe(1)
  expect(w.runs.length).toBe(1)
})

test('a re-ask that does not answer keeps the first BLOCK', async ($: any, on: any) => {
  const w = world(on, { outs: [{ exitCode: 0, stdout: BLOCKING, stderr: '' }, { exitCode: 1, stdout: '', stderr: 'x' }], triggers: [pageOf([])] })
  const s: any = await $.classic.Stop({ stop_hook_active: false })
  expect(s.block).toContain('schedule a check-in')
  expect(w.runs.length).toBe(2)
})
