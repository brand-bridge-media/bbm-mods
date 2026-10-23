import { expect, mock } from 'claude-code/testing'
import { test } from './slow'

import { helperOutput, sqlReply } from './fixture'

// The guard decides whether a receipt write may proceed. It is the half of this mod that
// stops speculative execution, so each verdict below is pinned: a guard that returned
// "no decision" for everything would pass a happy-path-only suite.

type Setup = { planFails?: boolean; activeRuns?: number; states?: Record<string, string>; answer?: string }

async function setup($: any, on: any, s: Setup = {}) {
  mock.store(on)
  mock.clock(on, { now: Date.parse('2026-10-07T12:00:00Z') })
  const ran: string[] = []
  const asked: string[] = []
  on('mcp.call', (_$: any, e: any) => {
    const q: string = e.args.query
    // The list-active query, then the run-row query.
    if (q.includes('limit 5')) {
      const n = s.activeRuns ?? 1
      return { value: sqlReply(Array.from({ length: n }, (_, i) => ({ id: `00000000-0000-4000-8000-00000000000${i}`, article_slug: `slug-${i}`, status: 'in_progress' }))) } as any
    }
    return { value: sqlReply([{ id: '896655cd-59e8-4f99-b127-6a275ab31e18', stages: [] }]) } as any
  })
  on('process.run', () => (s.planFails
    ? ({ value: { exitCode: 1, stdout: '', stderr: 'no module named pydantic' } } as any)
    : ({ value: { exitCode: 0, stdout: helperOutput(s.states), stderr: '' } } as any)))
  // The test's own tool.call stands for the engine beneath the plugin: it only runs when the
  // plugin let the call through, which is how a test sees "allowed".
  on('tool.call', (_$: any, e: any) => {
    if (e.tool === 'AskUserQuestion') {
      // The guard's ask goes through the engine's question dialog; answer it as a person would.
      asked.push(JSON.stringify(e))
      return { result: { answers: { [e.questions?.[0]?.question]: s.answer ?? 'Refuse' } }, text: s.answer ?? 'Refuse' } as any
    }
    ran.push('reached')
    return { result: 'ok', text: 'ok' } as any
  })
  return Object.assign(ran, { asked })
}

const WRITE_READY =
  'python3 write_stage_receipt.py --slug most-comfortable-couches --stage 9 --part c2 --status done'
const WRITE_BLOCKED =
  'python3 write_stage_receipt.py --slug most-comfortable-couches --stage 11 --part c5 --status pass'

test('a receipt write for a READY section is allowed through', async ($, on) => {
  const reached = await setup($, on)
  const out: any = await $.tool.call({ tool: 'Bash', command: WRITE_READY } as any)
  expect(out.isError).not.toBe(true)
  expect(out.deny).toBeUndefined()
  expect(reached).toContain('reached')
})

test('a receipt write for a BLOCKED section is denied, naming the unmet blocker', async ($, on) => {
  const reached = await setup($, on)
  const out: any = await $.tool.call({ tool: 'Bash', command: WRITE_BLOCKED } as any)
  expect(out.isError ?? out.deny).toBeTruthy()
  expect(JSON.stringify(out)).toContain('v2_s11c5')
  expect(JSON.stringify(out)).toContain('Render-integrity check')
  expect(reached).not.toContain('reached')
})

test('the Pass B receipt writer is denied while Pass B is BLOCKED', async ($, on) => {
  const reached = await setup($, on)
  const out: any = await $.tool.call({
    tool: 'Bash', command: 'python3 article_audit.py --slug x --pass b --live --write-receipt',
  } as any)
  expect(JSON.stringify(out)).toContain('v2_s11c5')
  expect(reached).not.toContain('reached')
})

test('an SQL write of a BLOCKED section receipt is denied; a plain SELECT is untouched', async ($, on) => {
  const reached = await setup($, on)
  const denied: any = await $.tool.call({
    tool: 'mcp__supabase__execute_sql',
    query: `update refresh_runs set stages = stages || '[{"stage": 10, "status": "done"}]'::jsonb where id = 'x'`,
  } as any)
  expect(JSON.stringify(denied)).toContain('v2_s10')
  expect(reached).not.toContain('reached')
  const read: any = await $.tool.call({ tool: 'mcp__supabase__execute_sql', query: 'select 1' } as any)
  expect(read.isError).not.toBe(true)
  expect(reached).toContain('reached')
})

test('an unreadable plan asks instead of allowing (fails closed)', async ($, on) => {
  const reached: any = await setup($, on, { planFails: true })
  const out: any = await $.tool.call({ tool: 'Bash', command: WRITE_READY } as any)
  expect(reached.asked.length).toBe(1)
  expect(reached.asked[0]).toContain('cannot read the refresh plan')
  // The person said Refuse, so the write never ran.
  expect(reached).not.toContain('reached')
  expect(JSON.stringify(out)).toContain('refused')
})

test('an unreadable plan lets the write through only when the person allows it', async ($, on) => {
  const reached: any = await setup($, on, { planFails: true, answer: 'Allow this write' })
  await $.tool.call({ tool: 'Bash', command: WRITE_READY } as any)
  expect(reached.asked.length).toBe(1)
  expect(reached).toContain('reached')
})

test('several active runs and no pin asks instead of guessing', async ($, on) => {
  const reached: any = await setup($, on, { activeRuns: 2 })
  const out: any = await $.tool.call({ tool: 'Bash', command: WRITE_READY } as any)
  expect(reached.asked.length).toBe(1)
  expect(reached.asked[0]).toContain('pin one')
  expect(reached).not.toContain('reached')
  expect(JSON.stringify(out)).toContain('refused')
})

test('a command that writes no receipt never touches the plan', async ($, on) => {
  const reached: any = await setup($, on, { planFails: true })
  const out: any = await $.tool.call({ tool: 'Bash', command: 'ls -la' } as any)
  expect(out.isError).not.toBe(true)
  expect(reached.asked.length).toBe(0)
  expect(reached).toContain('reached')
})

test('a non-UUID active run id never reaches SQL', async ($, on) => {
  mock.store(on)
  mock.clock(on, { now: 1 })
  const queries: string[] = []
  on('mcp.call', (_$: any, e: any) => {
    queries.push(e.args.query)
    return { value: sqlReply([{ id: "x'; drop table refresh_runs;--", article_slug: 's', status: 'in_progress' }]) } as any
  })
  on('process.run', () => ({ value: { exitCode: 0, stdout: helperOutput(), stderr: '' } }) as any)
  on('tool.call', (_$: any, e: any) =>
    (e.tool === 'AskUserQuestion' ? { result: {}, text: 'Refuse' } : { result: 'ok', text: 'ok' }) as any)
  await $.tool.call({ tool: 'Bash', command: WRITE_READY } as any)
  expect(queries.some(q => q.includes('drop table'))).toBe(false)
})

test('tools other than Bash and SQL are intentionally not gated (scope, see README)', async ($, on) => {
  const reached: any = await setup($, on)
  await $.tool.call({ tool: 'Write', file_path: '/tmp/receipt.json', content: '{}' } as any)
  expect(reached.asked.length).toBe(0)
  expect(reached).toContain('reached')
})
