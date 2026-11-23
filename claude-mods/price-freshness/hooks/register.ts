import type { Register } from 'claude-code'

import {
  GIVE_UP_MS, OWN, POLL_MS, allFinal, doneReport, handCheckWarning, isHandPriceCheck, isRefreshSignal, lateReport,
  notCheckedReceipt, onDemandSlug, queuedReceipt, requestIdOf, requestSql, slugOf, statusSql,
} from './logic'
import type { Row, Watch } from './logic'

// Why (LC-2245): see ./logic.ts. The queue's source CHECK allows only final_picks | on_demand, so every call here is on_demand;
// requested_by says whether the operator's chat or a session's tool asked. This file asks the Catalog & Prices queue (LC-2246) through the session's Supabase
// MCP, polls the request, and wakes the session with the per-PRID result. Fails open everywhere: a bug here never
// changes a prompt or a tool call; a failed read is NOT CHECKED, never "ready".

const STORE_KEY = 'price-freshness'
const TOOL_REQUEST = 'mcp__price-freshness__request'

type Opts = { supabaseServer?: string; projectId?: string }

const watches: Watch[] = []
const pendingWakes: string[] = []
let ticking = false
let busy = false

// --- $ helpers (the plugin validator follows $ only into functions declared in this file).

function toast($: any, text: string): void {
  try { $.ui.toast(text.split('\n')[0]!.slice(0, 200)) } catch { /* a toast never changes a verdict */ }
}

async function refreshSeen($: any): Promise<boolean> {
  try { return !!((await $.store.get(STORE_KEY)) as { refresh?: boolean } | undefined)?.refresh } catch { return false }
}

async function markRefresh($: any): Promise<void> {
  try { await $.store.set(STORE_KEY, { refresh: true }) } catch { /* without the store the flag lives for this call only */ }
}

// A cloud session names its Supabase server by a UUID (where-we-stand, LC-1893): take the name from a tool it has.
async function serverName($: any, configured: string): Promise<string> {
  try {
    const all: string[] = ((await $.tool.list()) ?? []).map((t: { name: unknown }) => String(t.name))
    const names = all.filter(n => n.startsWith('mcp__') && n.endsWith('__execute_sql')).map(n => n.slice(5, n.length - '__execute_sql'.length))
    return names.includes(configured) ? configured : (names[0] ?? configured)
  } catch {
    return configured
  }
}

function rowsOf(content: readonly unknown[] | undefined): Row[] {
  const text = (content ?? []).map(b => (b && typeof b === 'object' && 'text' in b ? String((b as { text: unknown }).text) : '')).join('\n')
  let body = text
  try {
    const o = JSON.parse(text)
    if (o && typeof o === 'object' && typeof o.result === 'string') body = o.result
  } catch { /* plain text reply */ }
  const env = /<untrusted-data-[^>]*>([\s\S]*)<\/untrusted-data-[^>]*>/.exec(body)
  const inner = env ? env[1]! : body
  const open = inner.indexOf('[')
  const close = inner.lastIndexOf(']')
  if (open < 0 || close < open) throw new Error('no row array in the reply')
  const rows = JSON.parse(inner.slice(open, close + 1))
  if (!Array.isArray(rows)) throw new Error('rows were not an array')
  return rows as Row[]
}

async function sql($: any, o: Opts, query: string): Promise<{ rows?: Row[]; error?: string }> {
  try {
    const res = await $.mcp.call(await serverName($, o.supabaseServer || 'Supabase'), 'execute_sql', { project_id: o.projectId || 'tlcbwwgfqnasmiipgmmd', query })
    if (res?.isError) {
      const t = (res.content ?? []).map((c: any) => String(c?.text ?? '')).join(' ')
      return { error: (t || 'execute_sql returned an error').slice(0, 160) }
    }
    return { rows: rowsOf(res?.content) }
  } catch (e) {
    return { error: String((e as Error)?.message ?? e).slice(0, 160) }
  }
}

function flush($: any): void {
  if (!pendingWakes.length) return
  const wakes = pendingWakes.splice(0)
  Promise.resolve()
    .then(async () => {
      toast($, wakes[0]!)
      await $.prompt.submit({ text: wakes.join('\n\n') })
    })
    .catch(() => { pendingWakes.unshift(...wakes) })
}

async function tick($: any, o: Opts): Promise<void> {
  if (busy) return
  busy = true
  try {
    const now = await $.clock.now()
    for (const w of [...watches]) {
      const drop = () => { const i = watches.indexOf(w); if (i >= 0) watches.splice(i, 1) }
      let rows: Row[] | undefined
      let error: string | undefined
      try { ({ rows, error } = await sql($, o, statusSql(w.requestId))) } catch (e) { error = String((e as Error)?.message ?? e) }
      if (!rows) {
        w.errors += 1
        if (w.errors >= 5) {
          pendingWakes.push(`${OWN} NOT CHECKED: 5 reads of price request ${w.requestId} for ${w.article} failed (${error}); stopped watching. Tell the operator the prices are not confirmed.`)
          drop()
        }
        continue
      }
      w.errors = 0
      if (allFinal(rows)) {
        pendingWakes.push(doneReport(w, rows))
        drop()
      } else if (now - w.startedAt > GIVE_UP_MS && !w.late) {
        pendingWakes.push(lateReport(w, rows, now))
        w.late = true
      } else if (now - w.startedAt > 3 * GIVE_UP_MS) {
        drop() // already told once; a request this late is Catalog & Prices' to chase, not this session's
      }
    }
  } catch { /* a failed tick is retried by the next one */ } finally {
    busy = false
    flush($)
  }
}

/** Ask the queue for one article; on success start watching. Returns the receipt the model sees. */
async function ask($: any, o: Opts, slug: string, source: 'on_demand', by: string, prids: string[] = []): Promise<string> {
  const got = await sql($, o, requestSql(slug, source, by, prids))
  if (!got.rows) return notCheckedReceipt(slug, got.error ?? 'no answer')
  const id = requestIdOf(got.rows)
  if (!id || !got.rows.length) return notCheckedReceipt(slug, got.rows.length ? 'the queue answered with no single request id' : 'the queue found no products for this article')
  const now = await $.clock.now()
  if (!watches.some(w => w.requestId === id)) watches.push({ requestId: id, article: slug, startedAt: now, errors: 0 })
  if (!ticking) {
    ticking = true
    $.clock.every(POLL_MS, () => { void tick($, o) })
  }
  toast($, `${OWN} REQUESTED: price refresh for ${slug} (${got.rows.length} PRIDs)`)
  // Some PRIDs may already be final (already fresh): a request that is done at once reports at once.
  if (allFinal(got.rows)) {
    const w = watches.find(x => x.requestId === id)!
    watches.splice(watches.indexOf(w), 1)
    return doneReport(w, got.rows)
  }
  return queuedReceipt(slug, got.rows, id)
}

export const register: Register = (on, options) => {
  const o = (options ?? {}) as Opts

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    try {
      await $.tool.register({
        name: 'request',
        description:
          'Ask Catalog & Prices (LC-2246) to refresh the prices of one article\'s products: every price older than 1 day is re-read and staged in the CMS, ' +
          'and this session is woken with the result per PRID. A refresh never checks prices itself (LC-2245). The final picks of a run are queued automatically; ' +
          'use this for an on-demand refresh, or to follow a run\'s request from this session.',
        inputSchema: {
          type: 'object',
          properties: {
            article: { type: 'string', description: 'The article slug, or its livingcozy.com URL.' },
            prids: { type: 'array', items: { type: 'string' }, description: 'Optional: only these products.public_code values (P-NNNNN). Empty = the article\'s current products.' },
          },
          required: ['article'],
        },
      })
    } catch { /* without the tool, the chat command and the warning still work */ }
    return started
  }).catch(($, e, next) => next(e))

  // The operator's on-demand path: "refresh prices for <article>" in chat.
  on('prompt.submit', async ($, e, next) => {
    if (e.command || e.isMeta) return next(e)
    const slug = onDemandSlug(String(e.text ?? ''))
    if (!slug) return next(e)
    const note = await ask($, o, slug, 'on_demand', 'operator (chat)')
    return next({ ...e, context: [...(e.context ?? []), note] })
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: TOOL_REQUEST }, async ($, e: any) => {
    const slug = slugOf(String(e.article ?? ''))
    if (!slug) return { result: `${OWN} Give the article's slug or its livingcozy.com URL.` }
    const prids = Array.isArray(e.prids) ? e.prids.map(String) : []
    return { result: await ask($, o, slug, 'on_demand', 'session (tool)', prids) }
  }).catch(() => ({ result: `${OWN} NOT CHECKED: the request crashed; tell the operator the price refresh was not queued.` }))

  // The warning half: a refresh session reading a brand page for a price.
  on('tool.call', async ($, e: any, next) => {
    const ran = await next(e)
    if (String(e.tool ?? '').startsWith('mcp__price-freshness__') || ran.deny !== undefined || ran.isError) return ran
    try {
      let seen = await refreshSeen($)
      if (!seen) {
        let text = ''
        try { text = JSON.stringify(e ?? {}) } catch { /* unreadable args */ }
        if (isRefreshSignal(text)) { await markRefresh($); seen = true }
      }
      if (!seen || !isHandPriceCheck(String(e.tool ?? ''), e)) return ran
      toast($, `${OWN} WARN: hand price check inside a refresh`)
      return { ...ran, context: [...(ran.context ?? []), handCheckWarning()] }
    } catch {
      return ran
    }
  // Fail open: a bug in the mod must never change a tool call's outcome.
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const res = await next(e)
    flush($)
    return res
  })
}
