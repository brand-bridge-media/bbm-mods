import { test, expect, mock } from 'claude-code/testing'

import { helperOutput, sqlReply } from './fixture'
import { bandText, decide, receiptWritesInBash, receiptWritesInSql, rowsFromMcp } from '../hooks/logic'

// The band must show the five things the ticket names, and must move after a receipt write
// (a band that only drew once would read as correct until the first write).

async function run($: any, on: any, after: Record<string, string> = { v2_s9c2: 'DONE' }) {
  mock.store(on)
  mock.clock(on, { now: Date.parse('2026-10-07T12:00:00Z') })
  let plans = 0
  on('mcp.call', (_$: any, e: any) =>
    ({ value: e.args.query.includes('limit 5')
      ? sqlReply([{ id: '896655cd-59e8-4f99-b127-6a275ab31e18', article_slug: 'x', status: 'in_progress' }])
      : sqlReply([{ id: '896655cd-59e8-4f99-b127-6a275ab31e18' }]) }) as any)
  // First plan: v2_s9c2 READY. After the write lands: it is DONE and v2_s9c6 is next.
  on('process.run', () => {
    plans += 1
    const states = plans === 1 ? {} : after
    return { value: { exitCode: 0, stdout: helperOutput(states), stderr: '' } } as any
  })
  on('tool.call', () => ({ result: 'ok', text: 'ok' }) as any)
  return () => plans
}

test('the band shows run, stage, next READY, Pass A age and missing receipts, and shows live state', async ($, on) => {
  await run($, on, {})
  const surface = 'terminal' as const
  await $.tool.call({ tool: 'Bash', command: 'python3 write_stage_receipt.py --stage 9 --part c1 --status done' } as any)
  const ui = await $.ui.mount({ plugin: 'run-state', surface, component: 'AbovePrompt', props: {} } as any)
  const text = JSON.stringify(await ui.find({ type: 'Text', text: /run 896655cd/ }))
  expect(text).toContain('most-comfortable-couches')
  expect(text).toContain('stage 9')
  expect(text).toContain('next READY: v2_s9c2')
  expect(text).toContain('Pass A: BLOCK 44h ago')
  expect(text).toContain('missing 5')
  await ui.unmount()
})

test('after a receipt write the band re-reads the plan and moves on', async ($, on) => {
  const plans = await run($, on)
  await $.tool.call({ tool: 'Bash', command: 'python3 write_stage_receipt.py --stage 9 --part c2 --status done' } as any)
  // one plan read to judge the write, one more after it ran
  expect(plans()).toBe(2)
  const ui = await $.ui.mount({ plugin: 'run-state', surface: 'terminal', component: 'AbovePrompt', props: {} } as any)
  const text = JSON.stringify(await ui.find({ type: 'Text', text: /run 896655cd/ }))
  expect(text).not.toContain('next READY: v2_s9c2')
  expect(text).toContain('next READY: v2_s9c6')
  await ui.unmount()
})

// Pure edges of the guard that the end-to-end cases above do not reach.
const view = JSON.parse(helperOutput({ v2_s9c1: 'DONE' }))
const v = {
  runId: 'r', slug: 's', status: 'in_progress', pipelineVersion: 2, fetchedAt: 0, passA: null, table: view.table,
  sections: view.plan.sections.map((s: any) => ({ ...s })),
}

test('a section that is already DONE asks (a re-write supersedes its receipt)', () => {
  const [t] = receiptWritesInBash('python3 write_stage_receipt.py --stage 9 --part c1 --status done')
  expect(decide(v as any, t).action).toBe('ask')
})

test('a stage the plan does not know asks instead of passing', () => {
  const [t] = receiptWritesInBash('python3 write_stage_receipt.py --stage 42 --status done')
  expect(decide(v as any, t).action).toBe('ask')
})

test('a dry-run or selftest is not a write', () => {
  expect(receiptWritesInBash('python3 write_stage_receipt.py --stage 9 --part c2 --dry-run')).toEqual([])
  expect(receiptWritesInBash('python3 write_stage_receipt.py --selftest')).toEqual([])
})

test('bandText with everything DONE says so', () => {
  const done = { ...v, sections: v.sections.map((s: any) => ({ ...s, state: 'DONE' })) }
  expect(bandText(done as any, 0)).toContain('all sections DONE')
})

test('an unrecognised section state asks instead of falling through to allow', () => {
  const odd = { ...v, sections: v.sections.map((x: any) => (x.id === 'v2_s9c2' ? { ...x, state: 'PENDING' } : x)) }
  const [t] = receiptWritesInBash('python3 write_stage_receipt.py --stage 9 --part c2 --status done')
  expect(decide(odd as any, t).action).toBe('ask')
})

test('COPY / MERGE / TRUNCATE on the receipt tables count as writes', () => {
  for (const q of ['copy refresh_run_sections from stdin', 'merge into refresh_run_sections t using x', 'truncate refresh_run_sections'])
    expect(receiptWritesInSql('mcp__s__execute_sql', q, []).length).toBe(1)
})

test('a look-alike flag (--dry-runner) is still a write; the real --dry-run is not', () => {
  expect(receiptWritesInBash('python3 write_stage_receipt.py --stage 11 --part c5 --dry-runner').length).toBe(1)
  expect(receiptWritesInBash('python3 write_stage_receipt.py --stage 11 --part c5 --dry-run-log /tmp/x').length).toBe(1)
  expect(receiptWritesInBash('python3 write_stage_receipt.py --stage 11 --part c5 --dry-run').length).toBe(0)
})

test('rows are read from inside the envelope even when prose before it has brackets', () => {
  const text = 'Result [see below] ok\n<untrusted-data-x>\n[{"id":"a"}]\n</untrusted-data-x>\nnote [1]'
  expect(rowsFromMcp([{ type: 'text', text }])).toEqual([{ id: 'a' }])
})

test('rows are read from a JSON-wrapped reply ({"result":"..."}) with escaped quotes inside', () => {
  const inner = 'Below is the result\n<untrusted-data-x>\n[{"id":"a","n":1}]\n</untrusted-data-x>\nnote'
  expect(rowsFromMcp([{ type: 'text', text: JSON.stringify({ result: inner }) }])).toEqual([{ id: 'a', n: 1 }])
})

test('a wrapped or plain reply with no row array still throws (callers fail closed)', () => {
  expect(() => rowsFromMcp([{ type: 'text', text: JSON.stringify({ result: 'no rows' }) }])).toThrow()
  expect(() => rowsFromMcp([{ type: 'text', text: '{"other":1}' }])).toThrow()
  expect(() => rowsFromMcp([{ type: 'text', text: 'boom' }])).toThrow()
})
