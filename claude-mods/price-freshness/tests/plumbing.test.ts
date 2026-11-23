import { test, expect, mock } from 'claude-code/testing'

// Decisions are tested in ./logic.test.ts. These pin the plumbing: what reaches the queue, when the session is woken,
// and that no failure changes a prompt or a tool call.

const NOW = Date.parse('2026-11-18T20:00:00Z')
const ID = 'a1b2c3d4-0000-0000-0000-000000000001'
const env = (rows: unknown[]) => ({ isError: false, content: [{ type: 'text', text: 'Below...\n<untrusted-data-x>\n' + JSON.stringify(rows) + '\n</untrusted-data-x>' }] })

type W = { request?: unknown[]; requestError?: string; status?: unknown[][]; statusError?: boolean; throws?: boolean }

function world(on: any, w: W = {}) {
  mock.store(on)
  const clock = mock.clock(on, { now: NOW })
  const sql: string[] = []
  const prompts: string[] = []
  const toasts: string[] = []
  on('ui.toast', (_$: any, e: any) => { toasts.push(e.text); return { value: undefined } as any })
  on('tool.list', () => ({ value: [{ name: 'mcp__uuid-s__execute_sql', description: '', mcp: true }] }) as any)
  on('mcp.call', (_$: any, e: any) => {
    if (w.throws) throw new Error('engine gone')
    const q = String(e.args?.query ?? '')
    sql.push(q)
    if (q.includes('request_price_refresh')) {
      if (w.requestError) return { value: { isError: true, content: [{ type: 'text', text: w.requestError }] } } as any
      return { value: env(w.request ?? []) } as any
    }
    if (w.statusError) return { value: { isError: true, content: [{ type: 'text', text: 'boom' }] } } as any
    return { value: env(w.status?.shift() ?? []) } as any
  })
  on('prompt.submit', (_$: any, e: any) => { prompts.push(e.text); return { text: e.text, context: e.context } as any })
  on('tool.call', (_$: any, e: any) => ({ result: 'ok', text: 'ok' }) as any)
  return { sql, prompts, toasts, clock }
}

const queued = [
  { request_id: ID, public_code: 'P-00001', status: 'queued' },
  { request_id: ID, public_code: 'P-00002', status: 'already_fresh' },
]
const done = [
  { request_id: ID, public_code: 'P-00001', status: 'refreshed', cms_staged_at: '2026-11-18T20:08:00Z' },
  { request_id: ID, public_code: 'P-00002', status: 'already_fresh' },
]

test('a normal prompt never reaches the queue', async ($: any, on: any) => {
  const w = world(on, { request: queued })
  const r: any = await $.prompt.submit({ text: 'how are prices doing?' })
  expect(w.sql).toHaveLength(0)
  expect(r.context).toBeUndefined()
})

test('"refresh prices for <article>" queues it and says REQUESTED', async ($: any, on: any) => {
  const w = world(on, { request: queued })
  const r: any = await $.prompt.submit({ text: 'refresh prices for best-deep-sofas' })
  expect(w.sql[0]).toContain("request_price_refresh(p_article_slug => 'best-deep-sofas'")
  expect(w.sql[0]).toContain("p_source => 'on_demand'")
  expect(r.context[0]).toMatch(/^\[mod:price-freshness\] REQUESTED: price refresh for best-deep-sofas/)
})

test('the session is woken once, with the per-PRID result, when every PRID is final', async ($: any, on: any) => {
  const w = world(on, { request: queued, status: [queued, done] })
  await $.prompt.submit({ text: 'refresh prices for best-deep-sofas' })
  await w.clock.advance(2 * 60_000)
  expect(w.prompts.some(p => p.includes('PRICES READY'))).toBe(false)
  await w.clock.advance(2 * 60_000)
  await new Promise(r => setTimeout(r, 0))
  const wake = w.prompts.find(p => p.includes('PRICES READY for best-deep-sofas'))
  expect(wake).toBeDefined()
  expect(wake).toContain('- P-00001: refreshed, staged in CMS')
  await w.clock.advance(4 * 60_000)
  await new Promise(r => setTimeout(r, 0))
  expect(w.prompts.filter(p => p.includes('PRICES READY'))).toHaveLength(1)
})

test('a queue that does not exist yet is NOT CHECKED, with the reason and the ticket', async ($: any, on: any) => {
  world(on, { requestError: 'function public.request_price_refresh does not exist' })
  const r: any = await $.prompt.submit({ text: 'refresh prices for best-deep-sofas' })
  expect(r.context[0]).toMatch(/^\[mod:price-freshness\] NOT CHECKED: .*does not exist.*LC-2246/)
})

test('an article with no products is NOT CHECKED, never "ready"', async ($: any, on: any) => {
  world(on, { request: [] })
  const r: any = await $.prompt.submit({ text: 'refresh prices for best-deep-sofas' })
  expect(r.context[0]).toContain('NOT CHECKED')
  expect(r.context[0]).toContain('no products')
})

test('a request already final at once reports at once and starts no watch', async ($: any, on: any) => {
  const w = world(on, { request: done })
  const r: any = await $.tool.call({ tool: 'mcp__price-freshness__request', article: 'https://www.livingcozy.com/best/deep-sofas' })
  expect(r.result).toMatch(/^\[mod:price-freshness\] PRICES READY for deep-sofas/)
  expect(w.sql[0]).toContain("p_source => 'on_demand', p_requested_by => 'session (tool)'")
  await w.clock.advance(10 * 60_000)
  expect(w.sql).toHaveLength(1)
})

test('five failed status reads stop the watch with NOT CHECKED', async ($: any, on: any) => {
  const w = world(on, { request: queued, statusError: true })
  await $.prompt.submit({ text: 'refresh prices for best-deep-sofas' })
  for (let i = 0; i < 6; i++) await w.clock.advance(2 * 60_000)
  await new Promise(r => setTimeout(r, 0))
  expect(w.prompts.some(p => p.startsWith('[mod:price-freshness] NOT CHECKED: 5 reads'))).toBe(true)
})

test('a hand price check in a refresh session is warned about, never denied', async ($: any, on: any) => {
  world(on)
  await $.tool.call({ tool: 'mcp__uuid-s__execute_sql', query: 'select status from refresh_runs' })
  const r: any = await $.tool.call({ tool: 'WebFetch', url: 'https://www.dreamsofa.com/landon', prompt: 'what is the from price' })
  expect(r.deny).toBeUndefined()
  expect(r.context[0]).toMatch(/^\[mod:price-freshness\] WARN:/)
})

test('outside a refresh the same fetch is left alone', async ($: any, on: any) => {
  world(on)
  const r: any = await $.tool.call({ tool: 'WebFetch', url: 'https://www.dreamsofa.com/landon', prompt: 'what is the from price' })
  expect(r.context).toBeUndefined()
})

test('a crash never changes the prompt', async ($: any, on: any) => {
  world(on, { throws: true })
  const r: any = await $.prompt.submit({ text: 'refresh prices for best-deep-sofas' })
  expect(r.text).toBe('refresh prices for best-deep-sofas')
  expect(r.context[0]).toContain('NOT CHECKED')
})
