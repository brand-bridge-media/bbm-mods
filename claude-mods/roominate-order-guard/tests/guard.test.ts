import { test, expect } from 'claude-code/testing'

import { claimOf, costOf, inputOf, judge, roominateTool } from '../hooks/logic'

const OID = '11111111-2222-3333-4444-555555555555'
const CID = '66666666-7777-8888-9999-000000000000'
const CLAIM_SQL = "select * from public.claim_refresh_order('pick_images', 'roominate-image-task');"
// What the Supabase connector really returns: JSON inside untrusted-data text, quotes escaped.
const claimText = (tokens: string) => `Below is the result of the SQL query. <untrusted-data-x>[{\\"order_id\\":\\"${OID}\\",` +
  `\\"claim_id\\":\\"${CID}\\",\\"payload\\":{\\"picks\\":[{\\"prid\\":\\"P-1\\"}],\\"approval\\":{\\"quote\\":\\"yes\\",` +
  `\\"limits\\":{${tokens}}}}}]</untrusted-data-x>`
const SQL = 'mcp__Supabase__execute_sql'
const GEN = 'mcp__Roominate__create_from_product'

function world(on: any, sqlText = '[]') {
  const reached: string[] = []
  const toasts: string[] = []
  on('ui.toast', (_$: any, e: any) => { toasts.push(e.text); return { value: undefined } as any })
  on('tool.call', (_$: any, e: any) => {
    reached.push(e.tool)
    return (e.tool === SQL ? { result: sqlText, text: sqlText } : { result: 'ok', text: 'ok' }) as any
  })
  return { reached, toasts }
}

// --- pure logic

test('only Roominate servers are judged, any casing', () => {
  expect(roominateTool('mcp__Roominate__create_scene')).toBe('create_scene')
  expect(roominateTool('mcp__claude_ai_Roominate__edit_image')).toBe('edit_image')
  expect(roominateTool('mcp__Supabase__execute_sql')).toBeUndefined()
  expect(roominateTool('mcp__Webflow__roominate_x')).toBeUndefined()
  expect(roominateTool('Bash')).toBeUndefined()
})

test('read-only tools and free intake are always allowed', () => {
  for (const t of ['get_token_balance', 'list_products', 'list_library', 'list_spaces', 'list_styles', 'get_image',
    'check_video', 'find_store_product', 'create_product']) expect(judge(t, {}, undefined)).toEqual({ allow: true, cost: 0 })
})

test('every other writer is refused even inside an order', () => {
  const o = { orderId: OID, claimId: CID, ceiling: 100, spent: 0 }
  for (const t of ['create_scene', 'add_product_to_room', 'edit_image', 'make_video', 'publish_to_store', 'brand_new_tool']) {
    const v: any = judge(t, {}, o)
    expect(v.allow).toBe(false)
    expect(v.reason).toMatch(/^\[mod:roominate-order-guard\] REFUSED/)
  }
})

test('create_from_product: refused with no order, no ceiling, or past the ceiling; allowed within it', () => {
  expect((judge('create_from_product', {}, undefined) as any).reason).toContain('no queued image order')
  expect((judge('create_from_product', {}, { orderId: OID, claimId: CID, ceiling: null, spent: 0 }) as any).reason)
    .toContain('no token ceiling')
  expect((judge('create_from_product', { resolution: '2K' }, { orderId: OID, claimId: CID, ceiling: 20, spent: 20 }) as any).reason)
    .toContain('ceiling')
  expect(judge('create_from_product', { resolution: '1K' }, { orderId: OID, claimId: CID, ceiling: 20, spent: 15 }))
    .toEqual({ allow: true, cost: 5 })
  expect(judge('create_from_product', {}, { orderId: OID, claimId: CID, ceiling: 10, spent: 0 })).toEqual({ allow: true, cost: 10 })
})

test('cost: 1K 5, 2K 10 (also the default), 4K 15, unknown charged at the top price', () => {
  expect(costOf({ resolution: '1K' })).toBe(5)
  expect(costOf({})).toBe(10)
  expect(costOf({ resolution: '4k' })).toBe(15)
  expect(costOf({ resolution: '8K' })).toBe(15)
})

test('a claim is read from the escaped result; an empty queue or another order type is no claim', () => {
  expect(claimOf(SQL, CLAIM_SQL, claimText('\\"tokens\\":40'))).toEqual({ orderId: OID, claimId: CID, ceiling: 40, spent: 0 })
  expect(claimOf(SQL, CLAIM_SQL, claimText(''))?.ceiling).toBeNull()
  expect(claimOf(SQL, CLAIM_SQL, '[]')).toBeUndefined()
  expect(claimOf(SQL, "select * from claim_refresh_order('price_refresh', 'x')", claimText('\\"tokens\\":40'))).toBeUndefined()
  expect(claimOf('mcp__Other__execute_sql', CLAIM_SQL, claimText('\\"tokens\\":40'))).toBeUndefined()
})

// --- through the engine

test('a direct image call with no claimed order never reaches Roominate', async ($: any, on: any) => {
  const w = world(on)
  const r: any = await $.tool.call({ tool: GEN, productId: 'p', roomType: 'Living Room', resolution: '2K' })
  expect(String(r.deny ?? r.text)).toContain('[mod:roominate-order-guard] REFUSED')
  expect(w.reached).not.toContain(GEN)
  expect(w.toasts[0]).toContain('[mod:roominate-order-guard]')
})

test('read-only calls pass with no order', async ($: any, on: any) => {
  const w = world(on)
  await $.tool.call({ tool: 'mcp__Roominate__get_token_balance' })
  await $.tool.call({ tool: 'mcp__Roominate__list_products', search: 'Dawson' })
  expect(w.reached).toEqual(['mcp__Roominate__get_token_balance', 'mcp__Roominate__list_products'])
})

test('after a claim the order spends up to its ceiling and no further; finishing closes it', async ($: any, on: any) => {
  const w = world(on, claimText('\\"tokens\\":20'))
  await $.tool.call({ tool: SQL, project_id: 'x', query: CLAIM_SQL })
  const a: any = await $.tool.call({ tool: GEN, productId: 'p1', resolution: '2K' })
  const b: any = await $.tool.call({ tool: GEN, productId: 'p2', resolution: '2K' })
  const c: any = await $.tool.call({ tool: GEN, productId: 'p3', resolution: '1K' })
  expect(a.deny).toBeUndefined()
  expect(b.deny).toBeUndefined()
  expect(String(c.deny ?? c.text)).toContain('ceiling')
  expect(w.reached.filter(t => t === GEN).length).toBe(2)
  await $.tool.call({ tool: SQL, project_id: 'x', query: `select public.finish_refresh_order('${OID}', '${CID}', 'done', 'ok');` })
  const d: any = await $.tool.call({ tool: GEN, productId: 'p4', resolution: '1K' })
  expect(String(d.deny ?? d.text)).toContain('no queued image order')
})

test('an empty-queue claim leaves image calls refused', async ($: any, on: any) => {
  const w = world(on, '[]')
  await $.tool.call({ tool: SQL, project_id: 'x', query: CLAIM_SQL })
  const r: any = await $.tool.call({ tool: GEN, productId: 'p', resolution: '2K' })
  expect(String(r.deny ?? r.text)).toContain('no queued image order')
  expect(w.reached).not.toContain(GEN)
})

test('edit_image is refused even with a claimed order', async ($: any, on: any) => {
  const w = world(on, claimText('\\"tokens\\":40'))
  await $.tool.call({ tool: SQL, project_id: 'x', query: CLAIM_SQL })
  const r: any = await $.tool.call({ tool: 'mcp__Roominate__edit_image', imageId: 'i', prompt: 'x' })
  expect(String(r.deny ?? r.text)).toContain('never used for our images')
  expect(w.reached).not.toContain('mcp__Roominate__edit_image')
})

test('a claim counts only when the whole statement is the call (review finding 1)', () => {
  const t = claimText('\\"tokens\\":9999')
  for (const sql of ["select 1 -- claim_refresh_order('pick_images', 'x')",
    "select 'claim_refresh_order(''pick_images'', ''x'')'",
    "select * from claim_refresh_order('pick_images', 'x'); select 1",
    "select * from claim_refresh_order('price_refresh', 'x')"]) expect(claimOf(SQL, sql, t)).toBeUndefined()
  expect(claimOf(SQL, "SELECT * FROM claim_refresh_order('pick_images','roominate-image-task')", t)?.ceiling).toBe(9999)
})

test('finishing needs the real call, not a mention', async ($: any, on: any) => {
  world(on, claimText('\\"tokens\\":40'))
  await $.tool.call({ tool: SQL, project_id: 'x', query: CLAIM_SQL })
  await $.tool.call({ tool: SQL, project_id: 'x', query: 'select 1 -- finish_refresh_order(' })
  const r: any = await $.tool.call({ tool: GEN, productId: 'p', resolution: '2K' })
  expect(r.deny).toBeUndefined()
})

test('a nested input object is read for the resolution (review finding 2)', () => {
  expect(costOf(inputOf({ tool: GEN, input: { resolution: '4K' } }))).toBe(15)
  expect(costOf(inputOf({ tool: GEN, resolution: '1K' }))).toBe(5)
})
