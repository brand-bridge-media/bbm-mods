import { test, expect, mock } from 'claude-code/testing'

import { deadLinkProven, deadLinkSql, deadLinkSqlIds } from '../hooks/register'

// LCH-370 (operator decision 2026-11-25): a Products card whose product is dead (no redirect_slug, no
// affiliate_url, brand inactive and not affiliated) may have its product-link CLEARED, on proof from the
// session's own canonical read. Everything else about rule 4's go-link check stays: a raw URL is refused.

const CMS = 'mcp__webflow__data_cms_tool'
const SQL = 'mcp__Supabase__execute_sql'
const PRODUCTS = '65fa33419d90d967c68a0963'
const TILE = '65fa33419d90d967c68a1432'
const OTHER = 'aaaaaaaaaaaaaaaaaaaaaaa1'
const NOW = Date.parse('2026-11-25T03:00:00Z')

const deadRow = (o: object = {}) => ({ webflow_id: TILE, redirect_slug: null, affiliate_url: null, partnership_status: 'inactive', is_affiliated: false, ...o })
const sqlText = (rows: object[]) => JSON.stringify({ result: `Below is the result.\n<untrusted-data-1>\n${JSON.stringify(rows)}\n</untrusted-data-1>\nUse this data.` })
const link = (v: unknown, id = TILE, key = 'update_collection_items') =>
  ({ tool: CMS, actions: [{ [key]: { collection_id: PRODUCTS, request: { items: [{ id, fieldData: { 'product-link': v } }] } } }] })

function world(on: any, rows: object[]) {
  const reached: any[] = []
  mock.clock(on, { now: NOW })
  on('tool.call', (_$: any, e: any) => {
    reached.push(e)
    if (e.tool === SQL) return { result: 'ok', text: sqlText(rows) } as any
    return { result: 'ok', text: 'ok' } as any
  })
  return reached
}
const wrote = (reached: any[]) => reached.some(e => e.tool === CMS)

test('bad case: a cleared link with no dead-link read is refused, and the refusal hands over the exact query', async ($: any, on: any) => {
  const reached = world(on, [deadRow()])
  const r: any = await $.tool.call(link(null) as any)
  expect(r.deny).toContain('LCH-370')
  expect(r.deny).toContain(deadLinkSql([TILE]))
  expect(wrote(reached)).toBe(false)
})

test('valid case: after the exact dead-link read, clearing the Tile Mat link goes through (null and "")', async ($: any, on: any) => {
  const reached = world(on, [deadRow()])
  await $.tool.call({ tool: SQL, project_id: 'x', query: deadLinkSql([TILE]) } as any)
  const r: any = await $.tool.call(link(null) as any)
  expect(r.deny).toBeUndefined()
  const r2: any = await $.tool.call(link('') as any)
  expect(r2.deny).toBeUndefined()
  expect(wrote(reached)).toBe(true)
})

test('tool.check agrees with the call: denied before the read, allowed after it', async ($: any, on: any) => {
  world(on, [deadRow()])
  on('tool.check', () => ({ decision: 'allow' }) as any)
  const before: any = await $.tool.check({ tool: CMS, input: { actions: link(null).actions } } as any)
  expect(before.decision).toBe('deny')
  await $.tool.call({ tool: SQL, project_id: 'x', query: deadLinkSql([TILE]) } as any)
  const after: any = await $.tool.check({ tool: CMS, input: { actions: link(null).actions } } as any)
  expect(after.decision).toBe('allow')
})

test('still refused with proof in hand: a raw brand URL, a create, and another item id', async ($: any, on: any) => {
  world(on, [deadRow()])
  await $.tool.call({ tool: SQL, project_id: 'x', query: deadLinkSql([TILE]) } as any)
  const raw: any = await $.tool.call(link('https://letterfolk.com/products/tile-mat') as any)
  expect(raw.deny).toContain('go.livingcozy.com')
  const created: any = await $.tool.call(link(null, TILE, 'create_collection_items') as any)
  expect(created.deny).toContain('LCH-370')
  const other: any = await $.tool.call(link(null, OTHER) as any)
  expect(other.deny).toContain('LCH-370')
})

test('a row that is not dead is no proof: active brand, a redirect_slug, an affiliate_url, affiliated', async ($: any, on: any) => {
  for (const o of [{ partnership_status: 'active' }, { redirect_slug: 'tile-mat' }, { affiliate_url: 'https://x.y/z' }, { is_affiliated: true }]) {
    expect(deadLinkProven({ row: deadRow(o), readAt: NOW }, NOW)).toBe(false)
  }
  world(on, [deadRow({ partnership_status: 'active' })])
  await $.tool.call({ tool: SQL, project_id: 'x', query: deadLinkSql([TILE]) } as any)
  const r: any = await $.tool.call(link(null) as any)
  expect(r.deny).toContain('LCH-370')
})

test('a hand-made query is not evidence; duplicate rows for one id are not evidence', async ($: any, on: any) => {
  world(on, [deadRow(), deadRow()])
  await $.tool.call({ tool: SQL, project_id: 'x', query: `select '${TILE}' as webflow_id, null as redirect_slug` } as any)
  await $.tool.call({ tool: SQL, project_id: 'x', query: deadLinkSql([TILE]) } as any)
  const r: any = await $.tool.call(link(null) as any)
  expect(r.deny).toContain('LCH-370')
})

test('the proof expires after 60 minutes, and the query is matched exactly, ids aside', () => {
  expect(deadLinkProven({ row: deadRow(), readAt: NOW }, NOW)).toBe(true)
  expect(deadLinkProven({ row: deadRow(), readAt: NOW - 60 * 60 * 1000 - 1 }, NOW)).toBe(false)
  expect(deadLinkProven({ row: { webflow_id: TILE, partnership_status: 'inactive', is_affiliated: false }, readAt: NOW }, NOW)).toBe(false)
  expect(deadLinkProven(undefined, NOW)).toBe(false)
  expect(deadLinkSqlIds(deadLinkSql([TILE, OTHER]))).toEqual([TILE, OTHER])
  expect(deadLinkSqlIds(deadLinkSql([TILE]).toUpperCase().replace(TILE.toUpperCase(), TILE) + ';')).toEqual([TILE])
  expect(deadLinkSqlIds(deadLinkSql([TILE]).replace('b.is_affiliated', "true as is_affiliated"))).toBeNull()
  expect(deadLinkSqlIds(deadLinkSql([TILE]) + ' or 1=1')).toBeNull()
})

test('the Products publish check is handed the dead-link proof, so a cleared card can go out on PASS', async ($: any, on: any) => {
  const runs: any[] = []
  world(on, [deadRow()])
  on('process.run', (_$: any, e: any) => {
    runs.push(JSON.parse(String(e.init?.stdin ?? '{}')))
    return { value: { exitCode: 0, stderr: '', stdout: JSON.stringify({ allow: false, receipts: [{ collection: 'Products', id: TILE, verdict: 'BLOCK', reason: 'x' }] }) } } as any
  })
  await $.tool.call({ tool: SQL, project_id: 'x', query: deadLinkSql([TILE]) } as any)
  await $.tool.call({ tool: CMS, actions: [{ publish_collection_items: { collection_id: PRODUCTS, request: { itemIds: [TILE] } } }] } as any)
  expect(runs[0].dead[TILE]).toEqual({ row: deadRow(), readAt: NOW })
})
