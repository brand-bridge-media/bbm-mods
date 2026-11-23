// Why (LC-2245, operator decisions 2026-11-18): checking prices is not a refresh's job. When a refresh's final picks
// are recorded, Catalog & Prices (LC-429) refreshes every price older than 1 day within minutes and stages it in the
// CMS: the queue, its request function and the result view are LC-2246, built and run by that track. The enqueue on
// final picks happens in the database, so headless runs need no mod. This mod covers the chat side:
//   1. "refresh prices for <article>" (or the request tool) asks the queue for that article on demand;
//   2. it watches the request and wakes the session once every PRID has a final result, per PRID;
//   3. it warns when a refresh session reads a brand page for a price (the rule's other half).
// This file is pure (no $). ./register.ts does the reads, the timer and the wakes. Tests: ../tests/logic.test.ts.

export const OWN = '[mod:price-freshness]'
/** Contract owned by LC-2246. Change it there first. */
export const QUEUE = { request: 'public.request_price_refresh', view: 'public.v_price_refresh_status', ticket: 'LC-2246' } as const
// updated_and_published / updated_held come from LC-2251 (auto-write of a changed price): held = not written, needs a person.
export const FINAL = ['refreshed', 'already_fresh', 'could_not_verify', 'failed', 'updated_and_published', 'updated_held'] as const
export const POLL_MS = 2 * 60_000
/** The queue promises about 15 minutes; past this the session hears it is not done, once. */
export const GIVE_UP_MS = 45 * 60_000

export type Row = {
  request_id?: string; article_slug?: string; public_code?: string; status?: string; reason?: string | null
  price_verified_at_after?: string | null; cms_staged_at?: string | null; finished_at?: string | null
}
export type Watch = { requestId: string; article: string; startedAt: number; errors: number; late?: boolean }

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const PRID_RE = /^P-\d{5}$/

/** "refresh prices for best-deep-sofas", "Refresh price for https://www.livingcozy.com/best/deep-sofas" -> the slug. */
export function onDemandSlug(prompt: string): string | undefined {
  const m = /^\s*refresh\s+prices?\s+(?:for|on)\s+(\S+)\s*$/i.exec(prompt)
  return m ? slugOf(m[1]!) : undefined
}

/** A slug or a livingcozy.com URL, reduced to the last path segment; anything else is refused. */
export function slugOf(raw: string): string | undefined {
  let s = raw.trim().replace(/[.,;:!?"'`)]+$/, '').replace(/^["'`(]+/, '')
  if (/^https?:\/\//i.test(s)) {
    try {
      const u = new URL(s)
      if (!/(^|\.)livingcozy\.com$/i.test(u.hostname)) return undefined
      s = u.pathname.split('/').filter(Boolean).pop() ?? ''
    } catch { return undefined }
  }
  s = s.toLowerCase()
  return SLUG_RE.test(s) && s.length <= 120 ? s : undefined
}

function lit(s: string): string {
  return `'${s.replace(/'/g, "''")}'`
}

/** The SQL that asks the queue. Slug and PRIDs are validated before they get here; the literals are quoted anyway. */
export function requestSql(slug: string, source: 'on_demand', by: string, prids: readonly string[] = []): string {
  const list = prids.filter(p => PRID_RE.test(p))
  const arr = list.length ? `array[${list.map(lit).join(',')}]::text[]` : 'null'
  return `select * from ${QUEUE.request}(p_article_slug => ${lit(slug)}, p_run_id => null, p_prids => ${arr}, p_source => ${lit(source)}, p_requested_by => ${lit(by.slice(0, 80))})`
}

export function statusSql(requestId: string): string {
  if (!/^[0-9a-f-]{8,64}$/i.test(requestId)) throw new Error('bad request id')
  return `select request_id, article_slug, public_code, status, reason, price_verified_at_after, cms_staged_at, finished_at from ${QUEUE.view} where request_id = ${lit(requestId)} order by public_code`
}

/** The request id the queue answered with (every row carries the same one). */
export function requestIdOf(rows: readonly Row[]): string | undefined {
  const ids = [...new Set(rows.map(r => r?.request_id).filter((x): x is string => typeof x === 'string' && x.length > 0))]
  return ids.length === 1 && /^[0-9a-f-]{8,64}$/i.test(ids[0]!) ? ids[0] : undefined
}

export function isFinal(status: unknown): boolean {
  return typeof status === 'string' && (FINAL as readonly string[]).includes(status)
}

/** Done only when there is at least one row and every row is final. Zero rows is never done. */
export function allFinal(rows: readonly Row[]): boolean {
  return rows.length > 0 && rows.every(r => isFinal(r.status))
}

function count(rows: readonly Row[], s: string): number {
  return rows.filter(r => r.status === s).length
}

function needsPerson(r: Row): boolean {
  return r.status === 'could_not_verify' || r.status === 'failed' || r.status === 'updated_held' || (r.status === 'refreshed' && !r.cms_staged_at)
}

function line(r: Row): string {
  const why = r.reason ? ` (${String(r.reason).slice(0, 120)})` : ''
  const staged = r.status === 'refreshed' ? (r.cms_staged_at ? ', staged in CMS' : ', NOT staged in CMS') : ''
  return `- ${r.public_code ?? '?'}: ${r.status ?? 'unknown'}${staged}${why}`
}

/** The report the session gets when the request finishes. Flagged PRIDs lead, because they need a person. */
export function doneReport(w: Watch, rows: readonly Row[]): string {
  const bad = rows.filter(needsPerson)
  const ok = rows.filter(r => !needsPerson(r))
  const head = bad.length
    ? `${OWN} PRICES DONE WITH FLAGS for ${w.article}: ${bad.length} of ${rows.length} PRIDs need a person.`
    : `${OWN} PRICES READY for ${w.article}: all ${rows.length} PRIDs are fresh; refreshed ones are staged in the CMS, and updated_and_published ones are already live.`
  return [
    head,
    `Counts: ${count(rows, 'refreshed')} refreshed, ${count(rows, 'already_fresh')} already fresh, ${count(rows, 'could_not_verify')} could not verify, ${count(rows, 'failed')} failed, ${count(rows, 'updated_and_published')} updated and published, ${count(rows, 'updated_held')} held. Request ${w.requestId} (${QUEUE.ticket}).`,
    ...bad.map(line),
    ...(ok.length <= 40 ? ok.map(line) : [`- ${ok.length} more PRIDs fine (not listed).`]),
    'Tell the operator in one plain sentence. Do not check any price yourself; a flagged PRID is a Catalog & Prices item.',
  ].join('\n')
}

export function lateReport(w: Watch, rows: readonly Row[], now: number): string {
  const open = rows.filter(r => !isFinal(r.status))
  return `${OWN} PRICES NOT DONE for ${w.article}: request ${w.requestId} is ${Math.round((now - w.startedAt) / 60_000)} min old with ` +
    `${open.length} of ${rows.length} PRIDs still open${open.length ? ` (${open.slice(0, 10).map(r => r.public_code).join(', ')})` : ''}. ` +
    `That is past the queue's ~15 minute promise: tell the operator it is NOT CHECKED and point at ${QUEUE.ticket}. Do not check prices yourself.`
}

export function queuedReceipt(slug: string, rows: readonly Row[], id: string): string {
  const open = rows.filter(r => !isFinal(r.status)).length
  return `${OWN} REQUESTED: price refresh for ${slug} queued with Catalog & Prices (request ${id}, ${rows.length} PRIDs, ${open} to refresh, ` +
    `${count(rows, 'already_fresh')} already fresh). This session is woken when every PRID has a result. Do not check prices yourself.`
}

export function notCheckedReceipt(slug: string, reason: string): string {
  return `${OWN} NOT CHECKED: the price refresh for ${slug} could not be queued (${reason}). ` +
    `The queue is ${QUEUE.ticket} (Catalog & Prices); if it is not built yet, say so to the operator. Do not check prices by hand instead.`
}

// --- Hand price checks: a refresh fetching a brand page for a price is the work this rule moved to Catalog & Prices.
// Warn, never block: a link check also fetches brand pages, and a guard nobody has read on real data does not get
// to block (single-job module rule 4, LC-1766).

// A refresh is in play once the session touches its machinery (sticky for the session).
const REFRESH_RE = new RegExp([
  'refresh_runs', 'refresh-run', 'refresh_conductor', 'refresh_run_sections', 'article_products', 'roundup_slots',
  'record_slot_ruling', 'roster_materialize', 'listicle-refresh', String.raw`\{\{price:P-\d{5}\}\}`,
].join('|'), 'i')
const PRICE_WORD = /\b(price|prices|priced|pricing|sale price|cost|how much|configurator)\b|\$\s?\d/i
const FETCH_TOOL = /^(WebFetch|WebSearch)$|^mcp__.*(fetch|scrape|crawl|firecrawl|get_page_text|navigate|browser).*$/i
const OWN_HOSTS = /(^|\.)(livingcozy\.com|webflow\.io|webflow\.com|github\.com|githubusercontent\.com|supabase\.co|atlassian\.net)$/i

export function isRefreshSignal(text: string): boolean {
  return REFRESH_RE.test(text)
}

function urlsIn(text: string): string[] {
  return text.match(/https?:\/\/[^\s"'<>)\\]+/g) ?? []
}

function foreign(url: string): boolean {
  try { return !OWN_HOSTS.test(new URL(url).hostname) } catch { return false }
}

/** True when the call reads a non-Living-Cozy page and its own words are about price. */
export function isHandPriceCheck(tool: string, args: Record<string, unknown>): boolean {
  let text = ''
  try { text = JSON.stringify(args ?? {}) } catch { return false }
  if (!PRICE_WORD.test(text)) return false
  if (tool === 'Bash') {
    const cmd = String(args.command ?? '')
    return /\b(curl|wget|http(ie)?)\b/.test(cmd) && urlsIn(cmd).some(foreign)
  }
  if (tool === 'Agent' || tool === 'Task') return String(args.subagent_type ?? '') === 'web-fetch' && urlsIn(text).some(foreign)
  if (!FETCH_TOOL.test(tool)) return false
  if (tool === 'WebSearch') return true
  const urls = urlsIn(text)
  return urls.length === 0 || urls.some(foreign)
}

export function handCheckWarning(): string {
  return `${OWN} WARN: this looks like a hand price check inside a refresh. A refresh never checks a price (LC-2245, operator 2026-11-18): ` +
    `Catalog & Prices refreshes the picks' prices and stages them (${QUEUE.ticket}). Use the price we hold and record nothing from this page; ` +
    'to ask for a refresh, call mcp__price-freshness__request. A link or availability check is fine; carry on with that.'
}
