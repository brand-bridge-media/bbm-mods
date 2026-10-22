import { test, expect } from 'claude-code/testing'

import { world, JIRA, DIAG, TICKET_TRIGGER, DIAG_TRIGGER } from './fixture'

// The logic (what triggers, what each source says, the verdict) is tested by the .py files' own --selftest
// (claude-mods.yml runs them). These tests pin the plumbing: when a lookup runs, what it reads, how many
// cards a session gets, and that no failure ever reaches the tool call.

test('a trigger runs the lookup and the card rides on the tool result, prefixed and toasted', async ($: any, on: any) => {
  const w = world(on, { trigger: TICKET_TRIGGER, tickets: ['LC-1345'], prs: [694] })
  const r: any = await $.tool.call(JIRA)
  expect(r.context).toHaveLength(1)
  expect(r.context[0]).toMatch(/^\[mod:where-we-stand\] WHERE WE STAND — x/)
  expect(w.toasts).toEqual(['[mod:where-we-stand] card for LC-1345: conflict'])
  const render = w.cmds.find(c => c.cmd === 'render')
  expect(Object.keys(render.evidence).sort()).toEqual(['github', 'jira', 'knowledge', 'production'])
  expect(render.tickets).toEqual(['LC-1345'])
  // discover runs twice: once for the tickets to read, once more with their comments for the PRs to check.
  const looks = w.cmds.filter(c => c.cmd === 'discover')
  expect(looks).toHaveLength(2)
  expect(looks[0].jira).toBeUndefined()
  expect(looks[1].jira).toBeDefined()
  expect(w.mcp.some(m => m.tool === 'pull_request_read' && m.args.pullNumber === 694 && m.args.owner === 'brand-bridge-media')).toBe(true)
})

test('every query the lookup sends is read-only SQL built by the Python side', async ($: any, on: any) => {
  const w = world(on, { trigger: TICKET_TRIGGER, tickets: ['LC-1345'] })
  await $.tool.call(JIRA)
  const sent = w.mcp.filter(m => m.tool === 'execute_sql').map(m => m.args.query)
  expect(sent).toEqual(['SQL:knowledge', 'SQL:production', 'SQL:fire', 'select pg_sleep(3)', 'SQL:collect'])
  expect(w.mcp.every(m => ['execute_sql', 'list_edge_functions', 'pull_request_read'].includes(m.tool))).toBe(true)
  const parsed = w.cmds.find(c => c.cmd === 'parse_jira')
  expect(parsed.collected).toEqual([{ id: 7 }, { id: 8 }])
})

test('a topic gets one card per session', async ($: any, on: any) => {
  const w = world(on, { trigger: DIAG_TRIGGER })
  const first: any = await $.tool.call(DIAG)
  const again: any = await $.tool.call(DIAG)
  expect(first.context).toHaveLength(1)
  expect(again.context).toBeUndefined()
  expect(w.cmds.filter(c => c.cmd === 'render')).toHaveLength(1)
})

test('three cards per session, then nothing', async ($: any, on: any) => {
  const topic = (n: string) => ({ kind: 'diagnosis', topic: n, tickets: [], terms: [n] })
  world(on, { triggers: ['aa-1', 'bb-2', 'cc-3', 'dd-4'].map(topic) })
  const out: any[] = []
  for (let i = 0; i < 4; i++) out.push(await $.tool.call(DIAG))
  expect(out.map(r => (r.context ?? []).length)).toEqual([1, 1, 1, 0])
})

test('a topic the session already read in the knowledge tables is not carded', async ($: any, on: any) => {
  const w = world(on, { triggers: [{ seen: ['catalog-ingest'] }, DIAG_TRIGGER] })
  await $.tool.call({ ...DIAG, query: "select * from knowledge_memories where 'catalog-ingest' = any(topics)" })
  const r: any = await $.tool.call(DIAG)
  expect(r.context).toBeUndefined()
  expect(w.mcp).toHaveLength(0)
})

test('a call that is not a trigger reads nothing', async ($: any, on: any) => {
  const w = world(on, { trigger: {} })
  const r: any = await $.tool.call(DIAG)
  expect(r.context).toBeUndefined()
  expect(w.mcp).toHaveLength(0)
  expect(w.toasts).toHaveLength(0)
})

test('one failing source does not stop the card; it reaches the Python side as an error', async ($: any, on: any) => {
  const w = world(on, { trigger: TICKET_TRIGGER, tickets: ['LC-1345'], failSql: 'SQL:fire' })
  const r: any = await $.tool.call(JIRA)
  expect(r.context).toHaveLength(1)
  const parsed = w.cmds.find(c => c.cmd === 'parse_jira')
  expect(parsed.error).toBe('execute_sql returned an error')
  expect(w.cmds.find(c => c.cmd === 'parse_knowledge').rows).toBeDefined()
})

test('a failed knowledge read is passed on as an error, not hidden', async ($: any, on: any) => {
  const w = world(on, { trigger: DIAG_TRIGGER, failSql: 'SQL:knowledge' })
  const r: any = await $.tool.call(DIAG)
  expect(r.context).toHaveLength(1)
  expect(w.cmds.find(c => c.cmd === 'parse_knowledge').error).toBe('execute_sql returned an error')
})

test('a Python failure, or silence, leaves the tool result untouched', async ($: any, on: any) => {
  world(on, { throwProcess: true })
  const r: any = await $.tool.call(JIRA)
  expect(r.context).toBeUndefined()
  expect(r.result).toBe('ok')
})

test('no card from the renderer means no context and no toast', async ($: any, on: any) => {
  const w = world(on, { trigger: DIAG_TRIGGER, noCard: true })
  const r: any = await $.tool.call(DIAG)
  expect(r.context).toBeUndefined()
  expect(w.toasts).toHaveLength(0)
})

test('the mod ignores tools it does not hook', async ($: any, on: any) => {
  const w = world(on, { trigger: DIAG_TRIGGER })
  await $.tool.call({ tool: 'Bash', command: 'ls' } as any)
  expect(w.cmds).toHaveLength(0)
})

test('the session\'s own ticket (from its branch) gets a card at session start', async ($: any, on: any) => {
  const w = world(on, { branch: 'lc1893-where-we-stand', ownTicket: 'LC-1893' })
  on('classic.SessionStart', () => ({}))
  const r: any = await $.classic.SessionStart({})
  expect(r.additionalContext).toHaveLength(1)
  expect(r.additionalContext[0]).toMatch(/^\[mod:where-we-stand\] WHERE WE STAND/)
  expect(w.cmds.find(c => c.cmd === 'branch_ticket').branch).toBe('lc1893-where-we-stand')
  expect(w.cmds.find(c => c.cmd === 'sql_knowledge').tickets).toEqual(['LC-1893'])
})

test('a branch that names no ticket gets no card and no reads', async ($: any, on: any) => {
  const w = world(on, { branch: 'main' })
  on('classic.SessionStart', () => ({}))
  const r: any = await $.classic.SessionStart({})
  expect(r.additionalContext).toBeUndefined()
  expect(w.mcp).toHaveLength(0)
})

test('the session ticket is not carded a second time by a later Jira read of it', async ($: any, on: any) => {
  const w = world(on, { ownTicket: 'LC-1345', trigger: TICKET_TRIGGER })
  on('classic.SessionStart', () => ({}))
  await $.classic.SessionStart({})
  const r: any = await $.tool.call(JIRA)
  expect(r.context).toBeUndefined()
  expect(w.cmds.filter(c => c.cmd === 'render')).toHaveLength(1)
})

test('the lookup tool answers on demand, and is not held to the three-card limit', async ($: any, on: any) => {
  const w = world(on)
  const out: any[] = []
  for (const n of ['a-1', 'b-2', 'c-3', 'd-4', 'e-5']) out.push(await $.tool.call({ tool: 'mcp__where-we-stand__lookup', terms: [n] } as any))
  expect(out.every(r => /^\[mod:where-we-stand\] WHERE WE STAND/.test(r.result))).toBe(true)
  expect(w.cmds.filter(c => c.cmd === 'render')).toHaveLength(5)
})

test('the lookup tool refuses an empty request instead of reading everything', async ($: any, on: any) => {
  const w = world(on)
  const r: any = await $.tool.call({ tool: 'mcp__where-we-stand__lookup' } as any)
  expect(r.result).toMatch(/^\[mod:where-we-stand\] Give at least one/)
  expect(w.mcp).toHaveLength(0)
})

test('every card is recorded for the gate: the tickets it read, the terms it searched, the PRs it checked', async ($: any, on: any) => {
  const w = world(on, { trigger: TICKET_TRIGGER, tickets: ['LC-1345', 'LC-1307'], prs: [694, 770] })
  on('classic.Stop', () => ({}))
  await $.tool.call(JIRA)
  w.cmds.length = 0
  await $.classic.Stop({ stop_hook_active: false, transcript_path: '/t.jsonl' })
  const gate = w.cmds.find(c => c.cmd === 'gate')
  expect(gate.cards).toEqual([{ topic: 'LC-1345', tickets: ['LC-1345', 'LC-1307'], terms: [], prs: [694, 770] }])
  expect(gate.transcript_path).toBe('/t.jsonl')
})

test('the gate blocks a reply that states a status with no card, prefixed and toasted', async ($: any, on: any) => {
  const BLOCK = '[mod:where-we-stand] This reply states a status with no where-we-stand card for: LC-9.'
  const w = world(on, { gate: { block: BLOCK } })
  on('classic.Stop', () => ({}))
  const r: any = await $.classic.Stop({ stop_hook_active: false, transcript_path: '/t.jsonl' })
  expect(r.block).toBe(BLOCK)
  expect(w.toasts).toEqual([BLOCK])
})

test('the gate lets a covered reply, and the stop after a block, through', async ($: any, on: any) => {
  const w = world(on, { gate: {} })
  on('classic.Stop', () => ({ ok: true }) as any)
  const r: any = await $.classic.Stop({ stop_hook_active: true, transcript_path: '/t.jsonl' })
  expect(r.block).toBeUndefined()
  expect(w.toasts).toHaveLength(0)
  expect(w.cmds.find(c => c.cmd === 'gate').stop_hook_active).toBe(true)
})

test('the gate fails open when the checker cannot run', async ($: any, on: any) => {
  world(on, { throwProcess: true })
  on('classic.Stop', () => ({ ok: true }) as any)
  const r: any = await $.classic.Stop({ stop_hook_active: false, transcript_path: '/t.jsonl' })
  expect(r.block).toBeUndefined()
})

test('a lookup that produced no card does not silence the topic: it is retried once, then left alone', async ($: any, on: any) => {
  const w = world(on, { trigger: DIAG_TRIGGER, noCard: true })
  const out: any[] = []
  for (let i = 0; i < 4; i++) out.push(await $.tool.call(DIAG))
  expect(out.every(r => r.context === undefined)).toBe(true)
  expect(w.cmds.filter(c => c.cmd === 'render')).toHaveLength(2)
})

test('a topic whose first lookup failed gets its card on the retry', async ($: any, on: any) => {
  const w = world(on, { trigger: DIAG_TRIGGER })
  w.fail.noCardOnce = true
  const first: any = await $.tool.call(DIAG)
  const second: any = await $.tool.call(DIAG)
  expect(first.context).toBeUndefined()
  expect(second.context).toHaveLength(1)
})
