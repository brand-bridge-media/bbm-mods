import { test, expect } from 'claude-code/testing'

import {
  OWN, QUEUE, allFinal, doneReport, handCheckWarning, isHandPriceCheck, isRefreshSignal, lateReport, notCheckedReceipt,
  onDemandSlug, queuedReceipt, requestIdOf, requestSql, slugOf, statusSql,
} from '../hooks/logic'

const W = { requestId: 'a1b2c3d4-0000-0000-0000-000000000001', article: 'best-deep-sofas', startedAt: 0, errors: 0 }

test('"refresh prices for <article>" takes a slug or a livingcozy.com URL; anything else is not the command', () => {
  expect(onDemandSlug('refresh prices for best-deep-sofas')).toBe('best-deep-sofas')
  expect(onDemandSlug('Refresh price for https://www.livingcozy.com/best/deep-sofas')).toBe('deep-sofas')
  expect(onDemandSlug('  refresh prices on best-deep-sofas.  ')).toBe('best-deep-sofas')
  expect(onDemandSlug('can you refresh prices for best-deep-sofas and then publish')).toBeUndefined()
  expect(onDemandSlug('refresh prices for https://evil.example.com/x')).toBeUndefined()
  expect(onDemandSlug("refresh prices for x'; drop table products; --")).toBeUndefined()
  expect(slugOf('Best-Deep-Sofas')).toBe('best-deep-sofas')
})

test('the request SQL calls the LC-2246 function with quoted, validated values', () => {
  const q = requestSql('best-deep-sofas', 'on_demand', "operator's chat", ['P-00072', 'bad', "P-00001'--"])
  expect(q).toContain(`${QUEUE.request}(p_article_slug => 'best-deep-sofas'`)
  expect(q).toContain("array['P-00072']::text[]")
  expect(q).toContain("'operator''s chat'")
  expect(q).not.toContain("P-00001'")
  expect(requestSql('x', 'on_demand', 's')).toContain('p_prids => null')
  expect(() => statusSql("x'; drop")).toThrow()
  expect(statusSql(W.requestId)).toContain(`from ${QUEUE.view} where request_id = '${W.requestId}'`)
})

test('one request id or none; zero rows is never done; any open row is not done', () => {
  expect(requestIdOf([{ request_id: W.requestId }, { request_id: W.requestId }])).toBe(W.requestId)
  expect(requestIdOf([{ request_id: W.requestId }, { request_id: 'b2c3d4e5-0000' }])).toBeUndefined()
  expect(requestIdOf([])).toBeUndefined()
  expect(allFinal([])).toBe(false)
  expect(allFinal([{ status: 'refreshed' }, { status: 'queued' }])).toBe(false)
  expect(allFinal([{ status: 'refreshed' }, { status: 'already_fresh' }, { status: 'could_not_verify' }])).toBe(true)
  expect(allFinal([{ status: 'whatever' }])).toBe(false)
  expect(allFinal([{ status: 'updated_and_published' }, { status: 'updated_held' }])).toBe(true)
})

test('the done report leads with what needs a person; "ready" only when nothing does', () => {
  const ready = doneReport(W, [
    { public_code: 'P-00001', status: 'refreshed', cms_staged_at: '2026-11-18T20:10:00Z' },
    { public_code: 'P-00002', status: 'already_fresh' },
  ])
  expect(ready.startsWith(`${OWN} PRICES READY for best-deep-sofas: all 2 PRIDs`)).toBe(true)
  const flagged = doneReport(W, [
    { public_code: 'P-00001', status: 'refreshed', cms_staged_at: null },
    { public_code: 'P-00002', status: 'could_not_verify', reason: 'WAF 403' },
    { public_code: 'P-00003', status: 'already_fresh' },
    { public_code: 'P-00004', status: 'updated_held', reason: 'move over 40%' },
    { public_code: 'P-00005', status: 'updated_and_published' },
  ])
  expect(flagged).toContain('- P-00004: updated_held (move over 40%)')
  expect(flagged.indexOf('P-00004')).toBeLessThan(flagged.indexOf('P-00005'))
  expect(flagged.startsWith(`${OWN} PRICES DONE WITH FLAGS for best-deep-sofas: 3 of 5 PRIDs need a person.`)).toBe(true)
  expect(flagged).toContain('- P-00002: could_not_verify (WAF 403)')
  expect(flagged).toContain('- P-00001: refreshed, NOT staged in CMS')
  expect(flagged.indexOf('P-00002')).toBeLessThan(flagged.indexOf('P-00003'))
})

test('every receipt starts with the mod name and says which kind it is', () => {
  expect(queuedReceipt('s', [{ status: 'queued' }, { status: 'already_fresh' }], W.requestId)).toMatch(/^\[mod:price-freshness\] REQUESTED: .*2 PRIDs, 1 to refresh, 1 already fresh/)
  expect(notCheckedReceipt('s', 'function does not exist')).toMatch(/^\[mod:price-freshness\] NOT CHECKED: .*\(function does not exist\).*LC-2246/)
  expect(lateReport(W, [{ public_code: 'P-00009', status: 'working' }, { status: 'refreshed' }], 50 * 60_000)).toMatch(/^\[mod:price-freshness\] PRICES NOT DONE .* 50 min old with 1 of 2 PRIDs still open \(P-00009\)/)
  expect(handCheckWarning().startsWith(`${OWN} WARN:`)).toBe(true)
})

test('a refresh is recognised by its machinery, not by the word "refresh"', () => {
  expect(isRefreshSignal('select * from refresh_runs')).toBe(true)
  expect(isRefreshSignal('{{price:P-00072}}')).toBe(true)
  expect(isRefreshSignal('please refresh the page')).toBe(false)
})

test('a hand price check is a foreign page read about price; our own pages and non-price reads are not', () => {
  expect(isHandPriceCheck('WebFetch', { url: 'https://www.dreamsofa.com/landon', prompt: 'What is the from price?' })).toBe(true)
  expect(isHandPriceCheck('WebFetch', { url: 'https://www.dreamsofa.com/landon', prompt: 'Does this page load and is it in stock?' })).toBe(false)
  expect(isHandPriceCheck('WebFetch', { url: 'https://www.livingcozy.com/best/deep-sofas', prompt: 'list each price shown' })).toBe(false)
  expect(isHandPriceCheck('Bash', { command: 'curl -s https://www.castlery.com/p/x | grep -i price' })).toBe(true)
  expect(isHandPriceCheck('Bash', { command: 'curl -sI https://go.livingcozy.com/x # price link' })).toBe(false)
  expect(isHandPriceCheck('Agent', { subagent_type: 'web-fetch', prompt: 'Read https://www.cozey.com/x and give the price' })).toBe(true)
  expect(isHandPriceCheck('mcp__Supabase__execute_sql', { query: 'select price from products' })).toBe(false)
})
