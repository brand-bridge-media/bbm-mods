import { test, expect, mock } from 'claude-code/testing'

import { decide, FAST_MS, LONG_MS, NO_RUN_MS, parseDispatch, parseReply, parseReqId, replySql, statusSql } from '../hooks/logic'

const T0 = Date.parse('2026-10-20T18:27:54Z')
const MIN = 60_000
const W = { workflow: 'refresh-run.yml', server: 'Supabase', projectId: 'p', since: new Date(T0 - MIN).toISOString(), startedAt: T0 }
const DISPATCH = "SELECT net.http_post(url := 'https://x.supabase.co/functions/v1/github-dispatch?secret=' || (select 1), " +
  `body := '{"workflow":"refresh-run.yml","inputs":{"run_id":"u"}}'::jsonb)`
const wrap = (rows: unknown) => JSON.stringify({ result: `Below is the result.\n\n<untrusted-data-abc>\n${JSON.stringify(rows)}\n</untrusted-data-abc>\n\nUse this.` })
const runs = (r: Record<string, unknown>[]) => wrap([{ status_code: 200, content: JSON.stringify({ ok: true, runs: r }) }])
const run = (extra: Record<string, unknown>) => ({ id: 7, status: 'completed', conclusion: 'success', html_url: 'https://gh/7',
  created_at: new Date(T0 + 5_000).toISOString(), run_started_at: new Date(T0 + 10_000).toISOString(),
  updated_at: new Date(T0 + 95_000).toISOString(), ...extra })

test('a bridge dispatch is recognised; a status request and other SQL are not', () => {
  expect(parseDispatch(DISPATCH)).toBe('refresh-run.yml')
  expect(parseDispatch(statusSql(W))).toBeNull()
  expect(parseDispatch('select 1')).toBeNull()
  expect(parseDispatch(`select net.http_post(url := 'https://example.com', body := '{"workflow":"refresh-run.yml"}'::jsonb) -- github-dispatch`)).toBeNull()
  expect(parseDispatch(`select '{"workflow":"x.yml"}' from github_dispatch_log`)).toBeNull()
})

test('the status SQL reads the secret inside the statement and asks only for status', () => {
  const q = statusSql(W)
  expect(q).toContain("name = 'edge_function_shared_secret'")
  expect(q).toContain('"action":"status"')
  expect(q).toContain(`"since":"${W.since}"`)
  expect(replySql(42.9)).toContain('where id = 42')
})

test('request ids and replies are read from the MCP result text', () => {
  expect(parseReqId(wrap([{ req_id: 9001 }]))).toBe(9001)
  expect(parseReqId('nonsense')).toBeNull()
  expect(parseReply(wrap([])).kind).toBe('pending')
  expect(parseReply(runs([run({})]))).toEqual({ kind: 'runs', runs: [run({})] as any })
  const err = parseReply(wrap([{ status_code: 401, content: '{"ok":false,"message":"invalid secret"}' }]))
  expect(err.kind).toBe('error')
  expect((err as any).detail).toContain('invalid secret')
})

test('a fast finish wakes with the did-nothing warning; a normal one just reports', () => {
  const fast = decide(W, { kind: 'runs', runs: [run({})] as any }, T0 + 2 * MIN)
  expect(fast.done).toBe(true)
  expect(fast.wake).toMatch(/^\[mod:dispatch-watch\] refresh-run\.yml run 7 finished: success after 85 s/)
  expect(fast.wake).toContain('1440431b')
  const slow = decide(W, { kind: 'runs', runs: [run({ updated_at: new Date(T0 + 10_000 + FAST_MS + 60_000).toISOString() })] as any }, T0 + 9 * MIN)
  expect(slow.wake).not.toContain('1440431b')
  expect(slow.wake).toContain('Read its outcome')
})

test('a running run keeps waiting, and says so once when long', () => {
  const r = [run({ status: 'in_progress', conclusion: null })] as any
  expect(decide(W, { kind: 'runs', runs: r }, T0 + 5 * MIN)).toEqual({ done: false })
  const long = decide(W, { kind: 'runs', runs: r }, T0 + LONG_MS + MIN)
  expect(long.done).toBe(false)
  expect(long.warnedLong).toBe(true)
  expect(long.wake).toContain('still in_progress')
  expect(decide({ ...W, warnedLong: true }, { kind: 'runs', runs: r }, T0 + LONG_MS + 2 * MIN).wake).toBeUndefined()
})

test('no run, an older run only, or a failed check', () => {
  expect(decide(W, { kind: 'runs', runs: [] }, T0 + MIN)).toEqual({ done: false })
  const none = decide(W, { kind: 'runs', runs: [run({ created_at: new Date(T0 - 10 * MIN).toISOString() })] as any }, T0 + NO_RUN_MS + MIN)
  expect(none.done).toBe(true)
  expect(none.wake).toContain('never registered')
  const failed = decide(W, { kind: 'error', detail: 'HTTP 500: boom' }, T0 + MIN)
  expect(failed.done).toBe(true)
  expect(failed.wake).toContain('HTTP 500')
  expect(decide(W, { kind: 'pending' }, T0 + MIN)).toEqual({ done: false })
})

test('end to end: a dispatch is watched, polled through the bridge, and the session is woken', async ($: any, on: any) => {
  const clock = mock.clock(on, { now: T0 })
  const prompts: string[] = []
  const queries: string[] = []
  on('ui.toast', () => ({ value: undefined }) as any)
  on('prompt.submit', (_$: any, e: any) => { prompts.push(e.text); return { text: e.text } as any })
  on('turn.complete', () => ({ text: 'done' }) as any)
  on('mcp.call', (_$: any, e: any) => {
    queries.push(e.args.query)
    const text = /net\.http_post/.test(e.args.query) ? wrap([{ req_id: 5 }]) : runs([run({})])
    return { value: { isError: false, content: [{ type: 'text', text }] } } as any
  })
  on('tool.call', () => ({ result: 'ok', text: wrap([{ http_post: 1 }]) }) as any)

  const r: any = await $.tool.call({ tool: 'mcp__Supabase__execute_sql', project_id: 'p', query: DISPATCH })
  expect(r.context[0]).toMatch(/^\[mod:dispatch-watch\] Watching refresh-run\.yml/)
  await clock.advance(MIN) // tick 1: send the status request
  await clock.advance(MIN) // tick 2: read the reply, wake
  expect(queries.some(q => q.includes('"action":"status"'))).toBe(true)
  expect(queries.some(q => q.includes('net._http_response where id = 5'))).toBe(true)
  await ($ as any).turn.complete({ reason: 'answer', answer: 'done' })
  await clock.advance(1)
  expect(prompts.join('\n')).toContain('run 7 finished: success after 85 s')
})

test('ordinary SQL is passed through untouched', async ($: any, on: any) => {
  on('tool.call', () => ({ result: 'ok', text: '[]' }) as any)
  const r: any = await $.tool.call({ tool: 'mcp__Supabase__execute_sql', project_id: 'p', query: 'select 1' })
  expect(r.context).toBeUndefined()
})
