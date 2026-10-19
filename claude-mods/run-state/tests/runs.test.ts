import { test, expect, mock } from 'claude-code/testing'

import { helperOutput, sqlReply } from './fixture'
import { decide, receiptWritesInBash } from '../hooks/logic'

// Which run a write is judged against, what a human barrier does, and what the guard does when no
// run is active or its own refresh fails (orchestrator review of PR #1581).

const A = '00000000-0000-4000-8000-00000000000a' // the only active run
const B = '00000000-0000-4000-8000-00000000000b' // another run, named by the write
const WRITE = (run: string) =>
  `python3 write_stage_receipt.py --run-id ${run} --stage 9 --part c2 --status done`

// A write that names no run: it is judged against the pinned / only active run, or not at all.
const UNNAMED = 'python3 write_stage_receipt.py --stage 9 --part c2 --status done'

type World = {
  active: string[]
  // per run id: conductor state overrides, or 'missing' for a run the table does not have
  runs: Record<string, Record<string, string> | 'missing'>
  answer?: string
  processThrowsAfter?: number
  badTable?: boolean
}

async function world($: any, on: any, w: World) {
  mock.store(on)
  mock.clock(on, { now: Date.parse('2026-10-07T12:00:00Z') })
  const log = { queries: [] as string[], listQueries: 0, plans: 0, asked: [] as string[], engine: 0 }
  let lastRow = ''
  on('mcp.call', (_$: any, e: any) => {
    const q: string = e.args.query
    log.queries.push(q)
    if (q.includes('limit 5')) {
      log.listQueries += 1
      return { value: sqlReply(w.active.map(id => ({ id, article_slug: `slug-${id.slice(-1)}`, status: 'in_progress' }))) } as any
    }
    const id = (/'([0-9a-f-]{36})'/.exec(q) ?? [])[1] ?? ''
    lastRow = id
    return { value: sqlReply(w.runs[id] === undefined || w.runs[id] === 'missing' ? [] : [{ id }]) } as any
  })
  on('process.run', () => {
    log.plans += 1
    if (w.processThrowsAfter !== undefined && log.plans > w.processThrowsAfter) throw new Error('process died')
    const over = w.runs[lastRow]
    // A real plan carries the id of the run it was computed for.
    const plan = JSON.parse(helperOutput(over && over !== 'missing' ? over : {}))
    plan.plan.run_id = lastRow
    if (w.badTable) plan.table = [null]
    return { value: { exitCode: 0, stdout: JSON.stringify(plan), stderr: '' } } as any
  })
  on('tool.call', (_$: any, e: any) => {
    if (e.tool === 'AskUserQuestion') {
      log.asked.push(JSON.stringify(e))
      const ans = w.answer ?? 'Refuse'
      return { result: { answers: { [e.questions?.[0]?.question]: ans } }, text: ans } as any
    }
    log.engine += 1
    return { result: 'ok', text: 'ok' } as any
  })
  return log
}

test('a write naming a different run is judged against THAT run, not the active one', async ($, on) => {
  // A: v2_s9c2 READY. B: v2_s9c2 BLOCKED. The write names B, so it must be denied.
  const log = await world($, on, { active: [A], runs: { [A]: {}, [B]: { v2_s9c2: 'BLOCKED' } } })
  const out: any = await $.tool.call({ tool: 'Bash', command: WRITE(B) } as any)
  expect(JSON.stringify(out)).toContain('v2_s9c2')
  expect(JSON.stringify(out)).toContain('BLOCKED')
  expect(log.engine).toBe(0)
  // And the same write naming the active run A is allowed.
  await $.tool.call({ tool: 'Bash', command: WRITE(A) } as any)
  expect(log.engine).toBe(1)
})

test('a write naming a run whose plan cannot be read asks', async ($, on) => {
  const log = await world($, on, { active: [A], runs: { [A]: {}, [B]: 'missing' } })
  const out: any = await $.tool.call({ tool: 'Bash', command: WRITE(B) } as any)
  expect(log.asked.length).toBe(1)
  expect(log.asked[0]).toContain('cannot read the plan for run')
  expect(log.engine).toBe(0)
  expect(JSON.stringify(out)).toContain('refused')
})

test('a SQL write that names a run by id is judged against that run too', async ($, on) => {
  const log = await world($, on, { active: [A], runs: { [A]: {}, [B]: { v2_s9c2: 'BLOCKED' } } })
  const out: any = await $.tool.call({
    tool: 'mcp__Supabase__execute_sql',
    query: `update refresh_run_sections set status = 'done' where run_id = '${B}' and section_key = 'v2_s9c2'`,
  } as any)
  expect(JSON.stringify(out)).toContain('BLOCKED')
  expect(log.engine).toBe(0)
})

test('a human barrier (WAITING_STAN) asks, it does not deny', async ($, on) => {
  const log = await world($, on, { active: [A], runs: { [A]: { v2_s9c2: 'WAITING_STAN' } }, answer: 'Allow this write' })
  await $.tool.call({ tool: 'Bash', command: WRITE(A) } as any)
  expect(log.asked.length).toBe(1)
  expect(log.asked[0]).toContain('human barrier')
  expect(log.engine).toBe(1)
})

test('decide: BLOCKED denies, WAITING_STAN asks', () => {
  const view: any = {
    slug: 's', runId: 'r', table: [{ id: 'x', stage: 9, part: 'c2' }],
    sections: [{ id: 'x', label: 'x', state: 'WAITING_STAN', unmet: [] }],
  }
  const [t] = receiptWritesInBash('python3 write_stage_receipt.py --stage 9 --part c2')
  expect(decide(view, t).action).toBe('ask')
  view.sections[0].state = 'BLOCKED'
  expect(decide(view, t).action).toBe('deny')
})

test('with no active run the guard is inert (no ask) and the idle result is cached', async ($, on) => {
  const log = await world($, on, { active: [], runs: {} })
  await $.tool.call({ tool: 'Bash', command: UNNAMED } as any)
  await $.tool.call({ tool: 'Bash', command: UNNAMED } as any)
  expect(log.asked.length).toBe(0)
  expect(log.engine).toBe(2) // both writes went through
  expect(log.listQueries).toBe(1) // the second one reused the cached "no active run"
  expect(log.plans).toBe(0)
})

test('a failing post-write refresh runs the write exactly once', async ($, on) => {
  // The guard's own plan read works (first process.run); the refresh after the write dies.
  const log = await world($, on, { active: [A], runs: { [A]: {} }, processThrowsAfter: 1 })
  const out: any = await $.tool.call({ tool: 'Bash', command: WRITE(A) } as any)
  expect(out.isError).not.toBe(true)
  expect(log.engine).toBe(1)
})

test('an exception inside the guard body fails closed: the write is refused, not run', async ($, on) => {
  // badTable: the conductor's answer carries a null table row, so decide() throws AFTER the plan was
  // read, inside the guard's try block.
  const log = await world($, on, { active: [A], runs: { [A]: {} }, badTable: true })
  const out: any = await $.tool.call({ tool: 'Bash', command: WRITE(A) } as any)
  expect(log.engine).toBe(0)
  expect(JSON.stringify(out)).toContain('guard failed')
})

test('with no active run, a write that NAMES a run is still judged against that run', async ($, on) => {
  // Nothing is in_progress, but run B exists and its v2_s9c2 is BLOCKED: naming B must deny.
  const log = await world($, on, { active: [], runs: { [B]: { v2_s9c2: 'BLOCKED' } } })
  const out: any = await $.tool.call({ tool: 'Bash', command: WRITE(B) } as any)
  expect(JSON.stringify(out)).toContain('BLOCKED')
  expect(log.engine).toBe(0)
  // A named run whose plan cannot be read asks.
  const out2: any = await $.tool.call({ tool: 'Bash', command: WRITE(A) } as any)
  expect(log.asked.length).toBe(1)
  expect(JSON.stringify(out2)).toContain('refused')
})
