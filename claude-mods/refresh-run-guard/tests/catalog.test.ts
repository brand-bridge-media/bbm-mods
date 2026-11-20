import { test, expect, mock } from 'claude-code/testing'

import { catalogPublishItems, contextSql, contextSqlIds, parseCatalogVerdict } from '../hooks/register'

// Rule 5 (LC-2297): Catalog & Prices may publish Products and Brands items on a PASS receipt per item;
// every other publish stays a human click. The decision itself lives in hooks/catalog_publish.py and is
// proven by its --selftest (claude-mods.yml runs it; this harness cannot spawn a real process). These
// tests pin the plumbing: which reads are recorded as evidence, what the check is handed, and how its
// verdict maps to allow or deny.

const CMS = 'mcp__webflow__data_cms_tool'
const SQL = 'mcp__Supabase__execute_sql'
const PRODUCTS = '65fa33419d90d967c68a0963'
const BRANDS = '65fa33419d90d967c68a0965'
const BLOG = '65fa33419d90d967c68a0964'
const BPD = '66148a432b8b6c7bed3c0eb7'
const P1 = 'aaaaaaaaaaaaaaaaaaaaaaa1'
const B1 = 'bbbbbbbbbbbbbbbbbbbbbbb1'
const NOW = Date.parse('2026-11-20T12:00:00Z')

const goodBrand = { name: 'Sabai', 'brand-url': 'https://sabai.design', 'full-size-image': { url: 'https://x/s.webp' }, 'full-size-image-alt-text': 'Sabai sofa in a sunlit room' }
const goodProduct = { name: 'Albany Sofa', prid: 'P-12345' }
const ctxRow = (verifiedAt: string) => ({
  webflow_id: P1, public_code: 'P-12345', review_id: null, lc_reviewed: false, product_line_id: null, price_verified_at: verifiedAt,
  line_id: null, line_webflow_id: null, line_review_id: null, card_row_found: true, card_sale_price: null,
})
// The Supabase MCP answers with the rows inside a `result` string, wrapped in untrusted-data markers.
const sqlText = (rows: object[]) => JSON.stringify({ result: `Below is the result.\n<untrusted-data-1>\n${JSON.stringify(rows)}\n</untrusted-data-1>\nUse this data.` })
const listText = (items: object[]) => JSON.stringify({ label: 'r', action: 'list_collection_items', result: { items, pagination: {} } })

const PASS = (id: string, coll = 'Brands') => ({ exitCode: 0, stdout: JSON.stringify({ allow: true, receipts: [{ collection: coll, id, verdict: 'PASS', reason: 'ok' }] }) })
const BLOCKED = (id: string, reason: string) => ({ exitCode: 0, stdout: JSON.stringify({ allow: false, receipts: [{ collection: 'Brands', id, verdict: 'BLOCK', reason }] }) })

type World = { reached: any[]; runs: any[]; toasts: string[] }
function world(on: any, opts: { list?: Record<string, object[]>; sql?: object[]; check?: { exitCode: number; stdout: string }; header?: string } = {}): World {
  const w: World = { reached: [], runs: [], toasts: [] }
  mock.clock(on, { now: NOW })
  on('ui.toast', (_$: any, e: any) => { w.toasts.push(e.text); return { value: undefined } as any })
  on('process.run', (_$: any, e: any) => {
    w.runs.push({ argv: [...e.argv], payload: JSON.parse(String(e.init?.stdin ?? '{}')) })
    return { value: { ...(opts.check ?? PASS(B1)), stderr: '' } } as any
  })
  on('tool.call', (_$: any, e: any) => {
    w.reached.push(e)
    const a = e.actions?.[0] ?? {}
    if (e.tool === SQL) return { result: 'ok', text: sqlText(opts.sql ?? []) } as any
    if (a.list_collection_items) {
      const items = opts.list?.[a.list_collection_items.collection_id] ?? []
      return { result: 'ok', text: (opts.header ?? '') + listText(items) } as any
    }
    if (a.publish_collection_items) return { result: 'ok', text: '{"publishedItemIds":["x"]}' } as any
    return { result: 'ok', text: 'ok' } as any
  })
  return w
}
const read = (collection: string) => ({ tool: CMS, actions: [{ label: 'r', list_collection_items: { collection_id: collection, request: { limit: 10 } } }] })
const publish = (collection: string, ids: string[]) => ({ tool: CMS, actions: [{ label: 'p', publish_collection_items: { collection_id: collection, request: { itemIds: ids } } }] })
const published = (w: World) => w.reached.some(e => e.actions?.some((a: any) => a.publish_collection_items || a.publish_site))

test('a PASS verdict lets a Brands publish through; the check got the staged read and the receipt is returned', async ($: any, on: any) => {
  const w = world(on, { list: { [BRANDS]: [{ id: B1, isArchived: false, fieldData: goodBrand }] } })
  await $.tool.call(read(BRANDS) as any)
  const r: any = await $.tool.call(publish(BRANDS, [B1]) as any)
  expect(r.deny).toBeUndefined()
  expect(published(w)).toBe(true)
  expect(String(r.context)).toContain(`PASS Brands ${B1}`)
  expect(String(r.context)).toContain('publishedItemIds')
  expect(w.runs.length).toBe(1)
  expect(w.runs[0].argv.slice(0, 2)).toEqual(['python3', '-I'])
  expect(w.runs[0].argv[2]).toMatch(/hooks\/catalog_publish\.py$/)
  const p = w.runs[0].payload
  expect(p.now_ms).toBe(NOW)
  expect(p.items).toEqual([{ collection: BRANDS, id: B1 }])
  expect(p.seen[B1]).toEqual({ collection: BRANDS, fieldData: goodBrand, isArchived: false, readAt: NOW })
})

test('a real Webflow answer, with its session header line before the JSON, is read', async ($: any, on: any) => {
  const w = world(on, {
    list: { [BRANDS]: [{ id: B1, isArchived: false, isDraft: false, fieldData: goodBrand }] },
    header: "[session_id issued — see this tool's session_id parameter description]\nsession_id: ses_x\nThis is the first-call issuance.",
  })
  await $.tool.call(read(BRANDS) as any)
  await $.tool.call(publish(BRANDS, [B1]) as any)
  expect(w.runs[0].payload.seen[B1]?.fieldData).toEqual(goodBrand)
})

test('a BLOCK verdict refuses the publish, names the receipt, and Webflow is never reached', async ($: any, on: any) => {
  const w = world(on, { check: BLOCKED(B1, 'full-size-image-alt-text is the bare brand name') })
  const r: any = await $.tool.call(publish(BRANDS, [B1]) as any)
  expect(r.deny).toMatch(/^\[mod:refresh-run-guard\] /)
  expect(r.deny).toContain(`BLOCK Brands ${B1}: full-size-image-alt-text is the bare brand name`)
  expect(published(w)).toBe(false)
  expect(w.toasts.length).toBe(1)
  expect(w.runs[0].payload.seen).toEqual({}) // nothing was read, so the check had no evidence
})

test('Products: the canonical context read is recorded; a hand-made one is not; the refusal hands over the query', async ($: any, on: any) => {
  const row = ctxRow('2026-11-20 10:00:00+00')
  const w = world(on, { list: { [PRODUCTS]: [{ id: P1, fieldData: goodProduct }] }, sql: [row], check: BLOCKED(P1, 'x') })
  await $.tool.call(read(PRODUCTS) as any)
  await $.tool.call({ tool: SQL, project_id: 'x', query: `select '${P1}' as webflow_id, now() as price_verified_at` } as any)
  const forged: any = await $.tool.call(publish(PRODUCTS, [P1]) as any)
  expect(w.runs[0].payload.ctx).toEqual({})
  expect(forged.deny).toContain(contextSql([P1])) // the exact query to run next
  await $.tool.call({ tool: SQL, project_id: 'x', query: contextSql([P1]) } as any)
  await $.tool.call(publish(PRODUCTS, [P1]) as any)
  expect(w.runs[1].payload.ctx[P1]).toEqual({ row, readAt: NOW })
  expect(w.runs[1].payload.seen[P1].collection).toBe(PRODUCTS)
})

test('a context read with two rows for one id records neither; rows for ids not asked for are ignored', async ($: any, on: any) => {
  const w = world(on, { sql: [ctxRow('a'), ctxRow('b'), { ...ctxRow('c'), webflow_id: B1 }], check: BLOCKED(P1, 'x') })
  await $.tool.call({ tool: SQL, project_id: 'x', query: contextSql([P1]) } as any)
  await $.tool.call(publish(PRODUCTS, [P1]) as any)
  expect(w.runs[0].payload.ctx).toEqual({})
})

test('a Webflow write after the read voids it; a read of another collection is not recorded', async ($: any, on: any) => {
  const w = world(on, { list: { [BRANDS]: [{ id: B1, fieldData: goodBrand }], [BLOG]: [{ id: P1, fieldData: { name: 'x' } }] }, check: BLOCKED(B1, 'x') })
  await $.tool.call(read(BRANDS) as any)
  await $.tool.call({ tool: CMS, actions: [{ update_collection_items: { collection_id: BRANDS, request: { items: [{ id: B1, fieldData: { name: 'Sabai' } }] } } }] } as any)
  await $.tool.call(read(BLOG) as any)
  await $.tool.call(publish(BRANDS, [B1]) as any)
  expect(w.runs[0].payload.seen).toEqual({})
})

test('a locale read, or a read bundled with another action, is not recorded', async ($: any, on: any) => {
  const w = world(on, { list: { [BRANDS]: [{ id: B1, fieldData: goodBrand }] }, check: BLOCKED(B1, 'x') })
  await $.tool.call({ tool: CMS, actions: [{ list_collection_items: { collection_id: BRANDS, request: { cmsLocaleId: 'l2' } } }] } as any)
  await $.tool.call({ tool: CMS, actions: [read(BRANDS).actions[0], { get_collection_details: { collection_id: BRANDS } }] } as any)
  await $.tool.call(publish(BRANDS, [B1]) as any)
  expect(w.runs[0].payload.seen).toEqual({})
})

test('articles stay a human click: Blog Posts and Best Products Data publishes are denied without running the check', async ($: any, on: any) => {
  const w = world(on, { list: { [BRANDS]: [{ id: B1, fieldData: goodBrand }] } })
  await $.tool.call(read(BRANDS) as any)
  for (const coll of [BLOG, BPD]) {
    const r: any = await $.tool.call(publish(coll, [B1]) as any)
    expect(r.deny).toContain('human click')
  }
  const site: any = await $.tool.call({ tool: 'mcp__webflow__data_sites_tool', actions: [{ publish_site: { siteId: 's' } }] } as any)
  expect(site.deny).toContain('human click')
  // A Brands publish riding next to a Blog Posts publish in one call is the old deny, whole.
  const mixed: any = await $.tool.call({ tool: CMS, actions: [publish(BRANDS, [B1]).actions[0], publish(BLOG, [B1]).actions[0]] } as any)
  expect(mixed.deny).toContain('human click')
  expect(w.runs.length).toBe(0)
  expect(published(w)).toBe(false)
})

for (const [label, check] of [
  ['a failed run', { exitCode: 1, stdout: '' }],
  ['junk output', { exitCode: 0, stdout: 'nope' }],
  ['an allow with no receipts', { exitCode: 0, stdout: '{"allow": true, "receipts": []}' }],
] as const) {
  test(`a check that answers with ${label} refuses the publish`, async ($: any, on: any) => {
    const w = world(on, { check: { ...check } })
    const r: any = await $.tool.call(publish(BRANDS, [B1]) as any)
    expect(r.deny).toContain('NOT CHECKED')
    expect(published(w)).toBe(false)
  })
}

test('tool.check lets only the exact catalog shape through to the call; everything else publish-shaped is denied', async ($: any, on: any) => {
  on('tool.check', () => ({ decision: 'allow' }) as any)
  const ok: any = await $.tool.check({ tool: CMS, input: { actions: publish(BRANDS, [B1]).actions } } as any)
  expect(ok.decision).toBe('allow')
  const blog: any = await $.tool.check({ tool: CMS, input: { actions: publish(BLOG, [B1]).actions } } as any)
  expect(blog.decision).toBe('deny')
})

test('the publish shape is exact: id not name, plain ids, no locales, no extra keys', () => {
  expect(catalogPublishItems({ actions: [{ label: 'p', publish_collection_items: { collection_id: BRANDS, request: { itemIds: [B1] } } }] })).toEqual([{ collection: BRANDS, id: B1 }])
  expect(catalogPublishItems({ actions: [{ publish_collection_items: { collection_id: PRODUCTS, request: { items: [{ id: P1 }] } } }] })).toEqual([{ collection: PRODUCTS, id: P1 }])
  for (const bad of [
    { actions: [{ publish_collection_items: { collection_id: 'Brands', request: { itemIds: [B1] } } }] },
    { actions: [{ publish_collection_items: { collection_id: BLOG, request: { itemIds: [B1] } } }] },
    { actions: [{ publish_collection_items: { collection_id: BPD, request: { itemIds: [B1] } } }] },
    { actions: [{ publish_collection_items: { collection_id: BRANDS, request: { items: [{ id: B1, cmsLocaleIds: ['l'] }] } } }] },
    { actions: [{ publish_collection_items: { collection_id: BRANDS, request: { itemIds: [B1], extra: 1 } } }] },
    { actions: [{ publish_collection_items: { collection_id: BRANDS, siteId: 's', request: { itemIds: [B1] } } }] },
    { actions: [{ publish_collection_items: { collection_id: BRANDS, request: { itemIds: [] } } }] },
    { actions: [{ publish_collection_items: { collection_id: BRANDS, request: { itemIds: ['not-an-id'] } } }] },
    { actions: [{ publish_collection_items: { collection_id: BRANDS, request: { itemIds: [B1] } }, publish_site: {} }] },
    { actions: [{ publish_collection_items: { collection_id: BRANDS, request: { itemIds: Array.from({ length: 101 }, (_, i) => i.toString(16).padStart(24, '0')) } } }] },
  ]) expect(catalogPublishItems(bad)).toBeNull()
})

test('the context query is matched exactly, ids aside', () => {
  expect(contextSqlIds(contextSql([P1, B1]))).toEqual([P1, B1])
  expect(contextSqlIds(contextSql([P1]).toUpperCase().replace(/\s+/g, '\n  ').replace(/'([0-9A-F]+)'/g, (_m, id) => `'${id.toLowerCase()}'`) + ';')).toEqual([P1])
  expect(contextSqlIds(contextSql([P1]) + ' or true')).toBeNull()
  expect(contextSqlIds(contextSql([P1]).replace('p.price_verified_at', 'now() as price_verified_at'))).toBeNull()
  expect(contextSqlIds(`select 1; ${contextSql([P1])}`)).toBeNull()
})

test('a verdict whose allow disagrees with its receipts refuses', () => {
  const one = [{ collection: BRANDS, id: 'x' }]
  expect(parseCatalogVerdict({ exitCode: 0, stdout: '{"allow": true, "receipts": [{"verdict": "BLOCK", "id": "x", "collection": "Brands", "reason": "r"}]}' }, one)!.allow).toBe(false)
  expect(parseCatalogVerdict({ exitCode: 0, stdout: '{"allow": true, "receipts": [{"verdict": "PASS", "id": "x", "collection": "Brands", "reason": "r"}]}' }, one)!.allow).toBe(true)
  expect(parseCatalogVerdict({ exitCode: 2, stdout: '{"allow": true, "receipts": [{"verdict": "PASS"}]}' }, one)).toBeNull()
  expect(parseCatalogVerdict({ exitCode: 0, stdout: '{"allow": true, "receipts": [{"verdict": "PASS", "id": "x", "collection": "Brands", "reason": "r"}]}' }, [])).toBeNull()
})

test('every requested item needs its own PASS receipt', () => {
  const two = [{ collection: BRANDS, id: 'x' }, { collection: BRANDS, id: 'y' }]
  const pass = (ids: string[]) => JSON.stringify({ allow: true, receipts: ids.map(id => ({ verdict: 'PASS', id, collection: 'Brands', reason: 'ok' })) })
  expect(parseCatalogVerdict({ exitCode: 0, stdout: pass(['x']) }, two)!.allow).toBe(false)
  expect(parseCatalogVerdict({ exitCode: 0, stdout: pass(['x', 'x']) }, two)!.allow).toBe(false)
  expect(parseCatalogVerdict({ exitCode: 0, stdout: pass(['x', 'z']) }, two)!.allow).toBe(false)
  expect(parseCatalogVerdict({ exitCode: 0, stdout: pass(['y', 'x']) }, two)!.allow).toBe(true)
  // A Brands PASS must not cover a Products item that shares its id, nor an unknown collection.
  expect(parseCatalogVerdict({ exitCode: 0, stdout: pass(['x']) }, [{ collection: PRODUCTS, id: 'x' }])!.allow).toBe(false)
  expect(parseCatalogVerdict({ exitCode: 0, stdout: pass(['x']) }, [{ collection: BLOG, id: 'x' }])!.allow).toBe(false)
  const prodPass = JSON.stringify({ allow: true, receipts: [{ verdict: 'PASS', id: 'x', collection: 'Products', reason: 'ok' }] })
  expect(parseCatalogVerdict({ exitCode: 0, stdout: prodPass }, [{ collection: PRODUCTS, id: 'x' }])!.allow).toBe(true)
})
