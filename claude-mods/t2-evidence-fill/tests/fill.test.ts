import { test, expect, mock } from 'claude-code/testing'

// The decisions (what counts, which tier, which slot, when to refuse) live in hooks/t2-evidence-fill.py and are
// proven by its --selftest (claude-mods.yml runs it; mutation floor shard). These tests pin the plumbing: what reaches
// the helper, how its answer rewrites, refuses or passes the call, and that every failure lets the call through.

const NOW = Date.parse('2026-11-16T18:00:00Z')

type W = { fill?: unknown; capture?: unknown; helperExit?: number; helperThrows?: boolean; pr?: unknown; prError?: boolean;
  engineError?: boolean; stored?: unknown }

function world(on: any, w: W = {}) {
  mock.store(on)
  const clock = mock.clock(on, { now: NOW })
  const toasts: string[] = []
  const sent: any[] = []
  const reached: any[] = []
  const mcp: any[] = []
  on('ui.toast', (_$: any, e: any) => { toasts.push(e.text); return { value: undefined } as any })
  on('process.run', (_$: any, e: any) => {
    const payload = JSON.parse(String(e.init?.stdin ?? '{}'))
    sent.push({ argv: [...e.argv], payload, timeoutMs: e.init?.timeoutMs })
    if (w.helperThrows) throw new Error('spawn failed')
    const answer = payload.mode === 'capture' ? (w.capture ?? {}) : (w.fill ?? { applicable: false })
    return { value: { exitCode: w.helperExit ?? 0, stdout: JSON.stringify(answer), stderr: '' } } as any
  })
  on('mcp.call', (_$: any, e: any) => {
    mcp.push(e)
    if (w.prError) return { value: { isError: true, content: [{ type: 'text', text: 'no' }] } } as any
    return { value: { isError: false, content: [{ type: 'text', text: JSON.stringify(w.pr ?? {}) }] } } as any
  })
  on('tool.call', (_$: any, e: any) => {
    reached.push(e)
    return (w.engineError ? { result: 'x', text: 'x', isError: true } : { result: 'ok', text: 'ok' }) as any
  })
  return { toasts, sent, reached, mcp, clock }
}

const CREATE = (over: Record<string, unknown> = {}) => ({ tool: 'mcp__github__create_pull_request', owner: 'brand-bridge-media',
  repo: 'bbm-infrastructure', head: 'lc1-x', base: 'main', title: 't', body: 'B', draft: true, ...over }) as any
const UPDATE = (over: Record<string, unknown> = {}) => ({ tool: 'mcp__github__update_pull_request', owner: 'brand-bridge-media',
  repo: 'bbm-infrastructure', pullNumber: 7, ...over }) as any
const FILLED = { applicable: true, tier: 'tier:T2', body: 'B\n\n## Evidence\n- **Tests:** a.py: 3 passed\n',
  changed: ['added the `## Evidence` section'], result: 'BLOCK', missing: [['What it does', 'empty', 'one sentence']], deny: false }

test('a draft T2 PR is sent with the filled body, and the model is told what is still empty', async ($: any, on: any) => {
  const w = world(on, { fill: FILLED })
  const r: any = await $.tool.call(CREATE())
  expect(w.reached.length).toBe(1)
  expect(w.reached[0].body).toBe(FILLED.body)
  expect(w.reached[0].title).toBe('t')
  const fill = w.sent.find(s => s.payload.mode === 'fill')!
  expect(fill.argv.slice(0, 2)).toEqual(['python3', '-I'])
  expect(fill.argv[2]).toMatch(/hooks\/t2-evidence-fill\.py$/)
  expect(fill.payload).toMatchObject({ owner: 'brand-bridge-media', repo: 'bbm-infrastructure', head: 'lc1-x', body: 'B', ready: false })
  const ctx = (r.context ?? []).join('\n')
  expect(ctx).toContain('[mod:t2-evidence-fill] Evidence section (tier:T2): added the `## Evidence` section')
  expect(ctx).toContain('- What it does: empty. How: one sentence')
  expect(w.toasts.some(t => t.startsWith('[mod:t2-evidence-fill]'))).toBe(true)
})

test('a create without draft:true is a ready PR: the helper is told ready, and its deny stops the call', async ($: any, on: any) => {
  const w = world(on, { fill: { ...FILLED, deny: true } })
  const r: any = await $.tool.call(CREATE({ draft: undefined }))
  expect(w.sent.find(s => s.payload.mode === 'fill')!.payload.ready).toBe(true)
  expect(w.reached.length).toBe(0)
  expect(String(r.deny)).toContain('[mod:t2-evidence-fill]')
  expect(String(r.deny)).toContain('- What it does: empty. How: one sentence')
  expect(String(r.deny)).toContain('n/a: <reason>')
  expect(w.toasts[0]).toContain('[mod:t2-evidence-fill]')
})

test('not applicable (another repo, a T1 PR): the call goes through untouched, silently', async ($: any, on: any) => {
  const w = world(on, { fill: { applicable: false, why: 'tier:T1' } })
  const r: any = await $.tool.call(CREATE())
  expect(w.reached[0].body).toBe('B')
  expect(r.context ?? []).toEqual([])
  expect(w.toasts).toEqual([])
})

test('a filled body that needs nothing passes untouched with no note', async ($: any, on: any) => {
  const w = world(on, { fill: { applicable: true, tier: 'tier:T2', body: 'B', changed: [], result: 'PASS', missing: [], deny: false } })
  const r: any = await $.tool.call(CREATE())
  expect(w.reached[0].body).toBe('B')
  expect(r.context ?? []).toEqual([])
  expect(w.toasts).toEqual([])
})

for (const [name, w] of [['helper exits non-zero', { helperExit: 1, fill: FILLED }], ['helper throws', { helperThrows: true }],
  ['helper prints junk', { fill: 'nope' }]] as const) {
  test(`fails open: ${name}`, async ($: any, on: any) => {
    const x = world(on, w as W)
    const r: any = await $.tool.call(CREATE())
    expect(x.reached.length).toBe(1)
    expect(x.reached[0].body).toBe('B')
    expect(r.deny).toBeUndefined()
  })
}

test('GitHub_Custom server matches too', async ($: any, on: any) => {
  const w = world(on, { fill: FILLED })
  await $.tool.call(CREATE({ tool: 'mcp__GitHub_Custom__create_pull_request' }))
  expect(w.reached[0].body).toBe(FILLED.body)
})

test('update that only renames is never looked at', async ($: any, on: any) => {
  const w = world(on, { fill: FILLED })
  await $.tool.call(UPDATE({ title: 'new' }))
  expect(w.sent.length).toBe(0)
  expect(w.mcp.length).toBe(0)
  expect(w.reached.length).toBe(1)
})

test('update marking a draft ready reads the PR, sends its body and head, and is ready', async ($: any, on: any) => {
  const w = world(on, { pr: { head: { ref: 'lc1-y' }, body: 'OLD', draft: true }, fill: { ...FILLED, deny: true } })
  const r: any = await $.tool.call(UPDATE({ draft: false }))
  expect(w.mcp[0].args).toMatchObject({ method: 'get', pullNumber: 7 })
  expect(w.sent[0].payload).toMatchObject({ head: 'lc1-y', body: 'OLD', ready: true })
  expect(w.reached.length).toBe(0)
  expect(String(r.deny)).toContain('[mod:t2-evidence-fill]')
})

test('a body edit on a draft is filled, never refused, and keeps the session-written body as input', async ($: any, on: any) => {
  const w = world(on, { pr: { head: { ref: 'lc1-y' }, body: 'OLD', draft: true }, fill: FILLED })
  await $.tool.call(UPDATE({ body: 'NEW' }))
  expect(w.sent[0].payload).toMatchObject({ body: 'NEW', ready: false })
  expect(w.reached[0].body).toBe(FILLED.body)
})

test('draft:false on a PR that is already ready is not a transition', async ($: any, on: any) => {
  const w = world(on, { pr: { head: { ref: 'lc1-y' }, body: 'OLD', draft: false }, fill: FILLED })
  await $.tool.call(UPDATE({ draft: false }))
  expect(w.sent[0].payload.ready).toBe(false)
})

test('an unreadable PR on update lets the call through untouched', async ($: any, on: any) => {
  const w = world(on, { prError: true, fill: { ...FILLED, deny: true } })
  const r: any = await $.tool.call(UPDATE({ draft: false }))
  expect(w.sent.length).toBe(0)
  expect(w.reached.length).toBe(1)
  expect(r.deny).toBeUndefined()
})

test('a test run is captured, and its counts are sent with the next PR', async ($: any, on: any) => {
  const w = world(on, { capture: { entry: { source: 'mutate.py', line: '31 killed' } }, fill: FILLED })
  await $.tool.call({ tool: 'Bash', command: 'python3 scripts/delegation/mutate.py x.py' } as any)
  const cap = w.sent.find(s => s.payload.mode === 'capture')!
  expect(cap.payload).toEqual({ mode: 'capture', command: 'python3 scripts/delegation/mutate.py x.py', output: 'ok' })
  await $.tool.call(CREATE())
  const fill = w.sent.find(s => s.payload.mode === 'fill')!
  expect(fill.payload.counts).toEqual([{ source: 'mutate.py', line: '31 killed', at: NOW }])
})

test('counts older than six hours are dropped; a re-run replaces its own source', async ($: any, on: any) => {
  const w = world(on, { capture: { entry: { source: 'a.py', line: '1 passed' } }, fill: FILLED })
  await $.tool.call({ tool: 'Bash', command: 'python3 a.py --selftest' } as any)
  await w.clock.advance(7 * 60 * 60 * 1000)
  await $.tool.call(CREATE())
  expect(w.sent.find(s => s.payload.mode === 'fill')!.payload.counts).toEqual([])
  await $.tool.call({ tool: 'Bash', command: 'python3 a.py --selftest' } as any)
  await $.tool.call({ tool: 'Bash', command: 'python3 a.py --selftest' } as any)
  await $.tool.call(CREATE())
  expect(w.sent.filter(s => s.payload.mode === 'fill')[1]!.payload.counts.length).toBe(1)
})

test('ordinary commands never start the helper', async ($: any, on: any) => {
  const w = world(on, { capture: { entry: { source: 'x', line: '1 passed' } } })
  await $.tool.call({ tool: 'Bash', command: 'git status' } as any)
  expect(w.sent.length).toBe(0)
})

test('a failed test run is not captured', async ($: any, on: any) => {
  const w = world(on, { engineError: true, capture: { entry: { source: 'x', line: '1 passed' } } })
  await $.tool.call({ tool: 'Bash', command: 'pytest -q' } as any)
  expect(w.sent.length).toBe(0)
})

// LC-2310: the capture carries the command's cwd (the helper stamps branch and sha from it), and a run the helper
// left out of Tests is reported, never silent.
test('the capture payload carries the session cwd when the event has one', async ($: any, on: any) => {
  const w = world(on, { capture: { entry: { source: 'a.py', line: '1 passed' } } })
  await $.tool.call({ tool: 'Bash', command: 'python3 a.py --selftest', cwd: '/work/tree' } as any)
  expect(w.sent.find(s => s.payload.mode === 'capture')!.payload.cwd).toBe('/work/tree')
})

test('skipped runs are reported as NOT CHECKED with the reason on a draft', async ($: any, on: any) => {
  world(on, { fill: { ...FILLED, skipped: ['a.py: ran on branch lc9-other, not lc1-x'] } })
  const r: any = await $.tool.call(CREATE())
  const ctx = (r.context ?? []).join('\n')
  expect(ctx).toContain('[mod:t2-evidence-fill] NOT CHECKED')
  expect(ctx).toContain('- a.py: ran on branch lc9-other, not lc1-x')
})

test('skipped runs are named in a refusal too', async ($: any, on: any) => {
  world(on, { fill: { ...FILLED, deny: true, skipped: ['a.py: ran on branch lc9-other, not lc1-x'] } })
  const d: any = await $.tool.call(CREATE({ draft: false }))
  expect(String(d.deny)).toContain('- a.py: ran on branch lc9-other, not lc1-x')
})

test('nothing skipped, no NOT CHECKED note', async ($: any, on: any) => {
  world(on, { fill: { ...FILLED, skipped: [] } })
  const r: any = await $.tool.call(CREATE())
  expect((r.context ?? []).join('\n')).not.toContain('NOT CHECKED')
})
