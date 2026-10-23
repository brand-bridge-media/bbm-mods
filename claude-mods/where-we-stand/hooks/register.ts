import type { Register } from 'claude-code'

import type { HookOut } from './py'
import { parseOut, runArgs, toolPayload } from './py'

// Why (LC-1893; CLAUDE.md section 1): the knowledge existed three times and nothing delivered it at the moment
// a session was diagnosing or stating a status. This mod is the delivery. It reacts only to RECOGNISED shapes
// (wws_trigger.py), looks the topic up read-only through the session's own Supabase / GitHub MCP, and injects ONE
// card. Every decision and every query lives in the .py files; this file only moves bytes and keeps the limits.
//
//   * once per topic per session, three cards per session, and never for a topic the session already
//     read in knowledge_memories / knowledge_articles;
//   * every source is its own step: one failing becomes NOT CHECKED on the card, never a failed lookup;
//   * three more ways in, none of them capped by the three-card limit: the session's OWN ticket (read from its
//     branch name) on the first tool call, the `lookup` tool (on demand), and the gate in ./gate.ts, which sends a
//     reply that states a status without a card back to this tool;
//   * the whole lookup is read-only: SELECTs, the pg_net GETs wws builds (Jira), list_edge_functions and
//     pull_request_read. The Jira credential is built inside the database and never leaves it;
//   * fails open: any error means no card, never a blocked or slowed tool call beyond the time-box.
const SCRIPT = 'where-we-stand.py'
const STORE_KEY = 'where-we-stand.session'
const MAX_CARDS = 3
const NUDGE = (why: string) =>
  `[mod:where-we-stand] The lookup could not read the database from the hook (${why}); no card. Treat every status as NOT CHECKED, or read the source yourself: the Jira issue's newest comment, refresh_runs / articles, pull_request_read.`
const MAX_PRS = 5
const MAX_TRIES = 2 // a lookup that produced no card is retried once more, not forever
const JIRA_WAIT_TRIES = 3
const REPO = { owner: 'brand-bridge-media', repo: 'bbm-infrastructure' }

type Opts = { supabaseServer?: string; projectId?: string; githubServer?: string }
type Moot = { verdict?: string; reason?: string; tickets?: Record<string, string> }
// `at` (epoch ms) and `moot` are what the NEEDS YOU guard (wws_needs_you.py) reads: was there a card THIS turn, and did it find the decision moot.
type Entry = { topic: string; tickets: string[]; terms: string[]; prs: number[]; at?: number; moot?: Moot }
type Session = { done: string[]; seen: string[]; cards: number; ledger: Entry[]; tries: Record<string, number>; broken?: boolean; nudged?: boolean; mootBlocks?: number }
type Made = { text: string; broken: boolean }
type Topic = { kind: string; topic: string; tickets: string[]; terms: string[] }

// A lookup runs its own MCP calls; this stops them re-triggering the mod that made them.
let busy = false

// --- $ helpers. They live in this file because the plugin validator follows $ only into functions
// declared in the hook's own file (claude-code 2.1.292); ./py.ts stays pure.
async function py($: any, payload: unknown): Promise<any> {
  try {
    const { argv, init } = runArgs($.plugin.root, SCRIPT, payload)
    return parseOut(await $.process.run(argv, init)) as HookOut | undefined
  } catch {
    return undefined
  }
}

function toast($: any, text: string): void {
  try { $.ui.toast(text.length > 160 ? text.slice(0, 157) + '...' : text) } catch { /* a toast never changes a result */ }
}

function textOf(content: readonly unknown[]): string {
  const joined = (content ?? [])
    .map(b => (b && typeof b === 'object' && 'text' in b ? String((b as { text: unknown }).text) : ''))
    .join('')
  try {
    const o = JSON.parse(joined)
    return o && typeof o === 'object' && typeof o.result === 'string' ? o.result : joined
  } catch {
    return joined
  }
}

// The array inside an execute_sql reply (plain, or wrapped as {"result":"...<untrusted-data>[...]..."}).
function rowsOf(content: readonly unknown[]): unknown[] {
  const text = textOf(content)
  const env = /<untrusted-data-[^>]*>([\s\S]*)<\/untrusted-data-[^>]*>/.exec(text)
  const body = env ? env[1] : text
  const open = body.indexOf('[')
  const close = body.lastIndexOf(']')
  if (open < 0 || close < open) throw new Error('no row array')
  const rows = JSON.parse(body.slice(open, close + 1))
  if (!Array.isArray(rows)) throw new Error('rows were not an array')
  return rows
}

// Which MCP server answers. LC-1893 first live use (2026-10-22): a cloud session names its Supabase server by a
// UUID (`mcp__e7e41b6a-...__execute_sql`), not "Supabase", so `$.mcp.call('Supabase', ...)` found no such server and
// every source went NOT CHECKED. The name is therefore taken from a tool the session really has; the configured
// name only wins when that server exists, and is the fallback when the tool list cannot be read.
const SERVER_TOOL = { supabase: 'execute_sql', github: 'pull_request_read' } as const
type Kind = keyof typeof SERVER_TOOL
// Per register() call (its options object), not per module: a long-lived process that loads the mod for a second session
// must not keep the first session's server names.
const resolvedBy = new WeakMap<object, Partial<Record<Kind, string>>>()
function cacheOf(o: Opts): Partial<Record<Kind, string>> {
  let c = resolvedBy.get(o)
  if (!c) resolvedBy.set(o, (c = {}))
  return c
}

async function serverFor($: any, o: Opts, kind: Kind, configured: string): Promise<string> {
  const resolved = cacheOf(o)
  if (resolved[kind]) return resolved[kind] as string
  try {
    const all: string[] = ((await $.tool.list()) ?? []).map((t: { name: unknown }) => String(t.name))
    const suffix = `__${SERVER_TOOL[kind]}`
    const names = all.filter(n => n.startsWith('mcp__') && n.endsWith(suffix)).map(n => n.slice(5, n.length - suffix.length))
    // Supabase also has to serve list_edge_functions: prefer a server that offers both.
    const both = kind === 'supabase' ? names.filter(n => all.includes(`mcp__${n}__list_edge_functions`)) : names
    const pool = both.length ? both : names
    const pick = pool.includes(configured) ? configured : pool[0]
    if (pick) {
      resolved[kind] = pick
      return pick
    }
  } catch { /* fall back to the configured name */ }
  return configured
}

// One MCP call, with the server found as above; a "no such server" failure forgets the cache and looks once more.
async function mcpCall($: any, o: Opts, kind: Kind, configured: string, tool: string, args: Record<string, unknown>): Promise<any> {
  try {
    return await $.mcp.call(await serverFor($, o, kind, configured), tool, args)
  } catch (e) {
    const resolved = cacheOf(o)
    if (!resolved[kind]) throw e
    delete resolved[kind]
    return await $.mcp.call(await serverFor($, o, kind, configured), tool, args)
  }
}

// {rows} on success, {error} otherwise: the .py parsers turn either into a receipt-ready slice.
async function sql($: any, o: Opts, query: string): Promise<{ rows?: any[]; error?: string }> {
  try {
    const res = await mcpCall($, o, 'supabase', o.supabaseServer || 'Supabase', 'execute_sql', {
      project_id: o.projectId || 'tlcbwwgfqnasmiipgmmd',
      query,
    })
    if (res.isError) return { error: 'execute_sql returned an error' }
    return { rows: rowsOf(res.content) as any[] }
  } catch (e) {
    return { error: String((e as Error)?.message ?? e).slice(0, 160) }
  }
}

async function edgeFunctions($: any, o: Opts): Promise<any[]> {
  try {
    const res = await mcpCall($, o, 'supabase', o.supabaseServer || 'Supabase', 'list_edge_functions', { project_id: o.projectId || 'tlcbwwgfqnasmiipgmmd' })
    if (res.isError) return []
    return (rowsOf(res.content) as any[]).map(f => ({ slug: f.slug, version: f.version, updated_at: f.updated_at }))
  } catch {
    return []
  }
}

async function jiraSlice($: any, o: Opts, tickets: string[]): Promise<unknown> {
  if (!tickets.length) return { ok: true, tickets: [] }
  const fire = await py($, { cmd: 'sql_jira_fire', tickets })
  if (!fire?.sql) return (await py($, { cmd: 'parse_jira', error: 'Jira query not built' }))?.evidence
  const fired = await sql($, o, fire.sql)
  if (!fired.rows) return (await py($, { cmd: 'parse_jira', error: fired.error }))?.evidence
  const ids = fired.rows.map((r: any) => r.req).filter((r: unknown) => r !== null && r !== undefined)
  let got: { rows?: any[]; error?: string } = { rows: [] }
  for (let i = 0; i < JIRA_WAIT_TRIES; i++) {
    // pg_sleep through the same MCP: pg_net answers after the statement commits, and hooks have no timer.
    await sql($, o, 'select pg_sleep(3)')
    const q = await py($, { cmd: 'sql_jira_collect', req_ids: ids })
    got = q?.sql ? await sql($, o, q.sql) : { error: 'collect query not built' }
    if (!got.rows || got.rows.length >= ids.length) break
  }
  if (!got.rows) return (await py($, { cmd: 'parse_jira', error: got.error }))?.evidence
  return (await py($, { cmd: 'parse_jira', tickets, fired: fired.rows, collected: got.rows }))?.evidence
}

async function githubSlice($: any, o: Opts, prs: number[]): Promise<unknown> {
  if (!prs.length) return { ok: true, asked: [], prs: [] }
  const items: { number: number; text?: string; error?: string }[] = []
  for (const n of prs.slice(0, MAX_PRS)) {
    try {
      const res = await mcpCall($, o, 'github', o.githubServer || 'github', 'pull_request_read', { method: 'get', ...REPO, pullNumber: n })
      items.push(res.isError ? { number: n, error: 'pull_request_read returned an error' } : { number: n, text: textOf(res.content) })
    } catch (e) {
      items.push({ number: n, error: String((e as Error)?.message ?? e).slice(0, 80) })
    }
  }
  return (await py($, { cmd: 'parse_prs', asked: prs.slice(0, MAX_PRS), items }))?.evidence
}

// The moot read has ONE success path. Once an open decision exists, anything other than well-formed evidence marked ok:true is
// a failed read, whatever went wrong (a Python failure, undefined, {}, null, a wrong shape, a throw): it reaches the card as
// ok:false, which is NOT CHECKED. Three review rounds found a different fail-open branch each time; this is the one rule.
const FAILED = (error: string) => ({ ok: false, error })
const wellFormed = (ev: any) => !!ev && typeof ev === 'object' && ev.ok === true && Array.isArray(ev.articles) && Array.isArray(ev.runs)

async function mootSlice($: any, o: Opts, tickets: string[], jira: unknown): Promise<unknown> {
  try {
    const refs = await py($, { cmd: 'moot_refs', jira })
    if (typeof refs?.needed !== 'boolean') return FAILED('moot_refs returned no answer')
    if (!refs.needed) return undefined // an explicit "no open decision in any newest comment": nothing to compare
    const q = await py($, { cmd: 'sql_production', tickets: refs.tickets ?? tickets, terms: [], kind: 'ticket-status', refs: { runs: refs.runs ?? [], slugs: refs.slugs ?? [] } })
    if (!q?.sql) return FAILED('moot query not built')
    const r = await sql($, o, q.sql)
    const ev = (await py($, { cmd: 'parse_production', ...r, asked: q.asked ?? {}, terms: [] }))?.evidence
    if (wellFormed(ev)) return ev
    return FAILED(String(ev?.error ?? r.error ?? 'moot evidence missing or malformed').slice(0, 200))
  } catch (e) {
    return FAILED(`moot read threw: ${String((e as Error)?.message ?? e)}`.slice(0, 200))
  }
}

// The whole lookup. Each source is read and parsed on its own; nothing here decides a verdict.
async function lookup($: any, o: Opts, t: Topic): Promise<{ card: string; entry?: Entry; broken?: boolean } | undefined> {
  const k = await py($, { cmd: 'sql_knowledge', terms: t.terms, tickets: t.tickets })
  const kr = k?.sql ? await sql($, o, k.sql) : { error: 'knowledge query not built' }
  const knowledge = (await py($, { cmd: 'parse_knowledge', ...kr, terms: t.terms, tickets: t.tickets }))?.evidence

  const p = await py($, { cmd: 'sql_production', terms: t.terms, tickets: t.tickets, kind: t.kind })
  const pr = p?.sql ? await sql($, o, p.sql) : { error: 'production query not built' }
  // Knowledge AND production both unreadable: the database is unreachable from this hook, and a card of four NOT CHECKED
  // receipts says nothing. Say so in one line and stop spending calls (Jira and the function list go through it too).
  if (kr.error && pr.error) return { card: NUDGE(kr.error), broken: true }
  const fns = t.terms.length ? await edgeFunctions($, o) : []
  const production = (await py($, { cmd: 'parse_production', ...pr, asked: p?.asked ?? {}, terms: t.terms, functions_raw: fns }))?.evidence

  const found = (await py($, { cmd: 'discover', tickets: t.tickets, knowledge, production })) ?? { tickets: t.tickets, prs: [] }
  const jira = await jiraSlice($, o, found.tickets ?? t.tickets)
  // A second look once the tickets are read: PR numbers in their newest comments are cited evidence too.
  const again = (await py($, { cmd: 'discover', tickets: t.tickets, knowledge, production, jira })) ?? found
  const github = await githubSlice($, o, again.prs ?? found.prs ?? [])
  // LC-1907: a decision the newest comment still calls open is checked against the runs and articles it names (and the runs that
  // list the ticket), which only a second read of production can answer: the first one ran before any comment was read.
  const mootProduction = await mootSlice($, o, found.tickets ?? t.tickets, jira)

  const out = await py($, { cmd: 'render', topic: t.topic, terms: t.terms, tickets: found.tickets ?? t.tickets, today: new Date().toISOString().slice(0, 10), evidence: { knowledge, jira, github, production, ...(mootProduction ? { moot_production: mootProduction } : {}) } })
  if (!out?.card) return undefined
  // What this card covers, for the gate: the tickets it read, the terms it searched, the PRs it checked.
  const entry: Entry = { topic: t.topic, tickets: found.tickets ?? t.tickets, terms: t.terms, prs: (again.prs ?? found.prs ?? []).slice(0, MAX_PRS), at: Date.now(), moot: out.moot }
  return { card: `[mod:where-we-stand] ${out.card}`, entry }
}

async function load($: any): Promise<Session> {
  try {
    const s = (await $.store.get(STORE_KEY)) as Session | undefined
    return s && Array.isArray(s.done) ? { ...s, ledger: Array.isArray(s.ledger) ? s.ledger : [], tries: s.tries ?? {} } : { done: [], seen: [], cards: 0, ledger: [], tries: {} }
  } catch {
    return { done: [], seen: [], cards: 0, ledger: [], tries: {} }
  }
}

// A topic is "done" only once a card exists for it; a lookup that returned nothing counts as a try, so a transient
// MCP failure does not silence the topic for the rest of the session (and a persistent one stops after MAX_TRIES).
async function mark($: any, key: string, gotCard: boolean): Promise<void> {
  const s = await load($)
  if (gotCard) s.done = [...s.done, key].slice(-20)
  else s.tries = { ...s.tries, [key]: (s.tries[key] ?? 0) + 1 }
  await save($, s)
}

// Run a lookup and record it: the ledger is what the gate (./gate.ts) checks a reply against. A broken lookup covers
// nothing, is not a card (it never counts toward the cap), and switches the gate off until a lookup works again.
async function produce($: any, o: Opts, t: Topic, counted: boolean): Promise<Made | undefined> {
  const r = await lookup($, o, t)
  if (!r) return undefined
  const s = await load($)
  s.broken = !!r.broken
  if (!r.broken && r.entry) {
    s.ledger = [...s.ledger, r.entry].slice(-20)
    if (counted) s.cards += 1
  }
  await save($, s)
  toast($, r.broken ? '[mod:where-we-stand] lookup unavailable: database not reachable from the hook' : `[mod:where-we-stand] card for ${t.topic}: ${(/VERDICT: ([A-Z ]+)/.exec(r.card)?.[1] ?? '?').toLowerCase()}`)
  return { text: r.card, broken: !!r.broken }
}

// The nudge goes into the model's context once per session; after that a broken lookup stays quiet.
async function nudgeOnce($: any, m: Made): Promise<string | undefined> {
  if (!m.broken) return m.text
  const s = await load($)
  if (s.nudged) return undefined
  s.nudged = true
  await save($, s)
  return m.text
}

// The ticket the session's own branch names (lc1893-... -> LC-1893), or undefined.
async function ownTicket($: any): Promise<string | undefined> {
  try {
    const r = await $.process.run(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], { timeoutMs: 10_000 })
    if (r?.exitCode !== 0) return undefined
    const t = await py($, { cmd: 'branch_ticket', branch: String(r.stdout ?? '').trim() })
    return t?.tickets?.[0]
  } catch {
    return undefined
  }
}

async function save($: any, s: Session): Promise<void> {
  try { await $.store.set(STORE_KEY, s) } catch { /* the store is a convenience; without it the limits reset */ }
}

export const register: Register = (on, options) => {
  const o = (options ?? {}) as Opts

  // The session's own ticket gets its card on the FIRST tool call, not at session start: $.mcp.call is not available in
  // classic.SessionStart ("no session is bound in this process", the REPL has not mounted yet), so a start-time lookup
  // always came back empty (LC-1893, second live finding, 2026-10-22). One try per load of the mod.
  let ownTried = false
  on('tool.call', async ($, e: any, next) => {
    const ran = await next(e)
    if (ownTried || busy || e.tool === 'mcp__where-we-stand__lookup' || ran.deny !== undefined || ran.isError) return ran
    ownTried = true
    busy = true
    try {
      const key = await ownTicket($)
      if (!key) return ran
      const s = await load($)
      if (s.done.includes(key) || (s.tries[key] ?? 0) >= MAX_TRIES) return ran
      const made = await produce($, o, { kind: 'ticket-status', topic: key, tickets: [key], terms: [] }, true)
      await mark($, key, !!made && !made.broken)
      const card = made ? await nudgeOnce($, made) : undefined
      return card ? { ...ran, context: [...(ran.context ?? []), card] } : ran
    } catch {
      return ran
    } finally {
      busy = false
    }
  }).catch(($, e, next) => next(e))

  // On demand: the model (or the gate's block message) asks for a card by name.
  on('session.start', async ($, e, next) => {
    try {
      await $.tool.register({
        name: 'lookup',
        description:
          'Where-we-stand card for a ticket, article, job or error: what we know (memories, articles), the ticket status with its NEWEST comment and date, and what GitHub and production say, with every conflict named. ' +
          'Call it BEFORE stating a ticket status or saying something is published, merged, deployed or live.',
        inputSchema: {
          type: 'object',
          properties: {
            tickets: { type: 'array', items: { type: 'string' }, description: 'Jira keys, e.g. LC-1345' },
            terms: { type: 'array', items: { type: 'string' }, description: 'lowercase slugs, job names or error classes, e.g. most-comfortable-couches, catalog-ingest' },
            kind: { type: 'string', enum: ['ticket-status', 'diagnosis', 'article-status'], description: 'article-status when a term is an article slug or run id' },
          },
        },
      })
    } catch { /* without the tool the triggers and the gate still work */ }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'mcp__where-we-stand__lookup' }, async ($, e: any) => {
    const t = await py($, { cmd: 'normalize', tickets: e.tickets, terms: e.terms, kind: e.kind })
    if (!t?.topic) return { result: '[mod:where-we-stand] Give at least one valid Jira key (tickets) or slug / job name (terms).' }
    busy = true
    try {
      const made = await produce($, o, t, false)
      return { result: made?.text ?? '[mod:where-we-stand] The lookup could not run; treat every status as NOT CHECKED.' }
    } finally {
      busy = false
    }
  }).catch(($, e, next) => next(e))
  on('tool.call', { tool: /^mcp__.*__(execute_sql|getJiraIssue|fetchJiraIssue)$/ }, async ($, e, next) => {
    const ran = await next(e)
    if (busy || ran.deny !== undefined || ran.isError) return ran
    busy = true
    try {
      const t = await py($, { cmd: 'trigger', ...toolPayload(e as any) })
      if (!t || (!t.kind && !t.seen)) return ran
      const s = await load($)
      if (t.seen) {
        s.seen = [...new Set([...s.seen, ...t.seen])].slice(-40)
        await save($, s)
        return ran
      }
      const names: string[] = [...t.tickets, ...t.terms]
      const key = [...names].sort().join('|')
      if (s.cards >= MAX_CARDS || s.done.includes(key) || (s.tries[key] ?? 0) >= MAX_TRIES || names.every(n => s.seen.includes(n))) return ran
      const made = await produce($, o, t, true)
      await mark($, key, !!made && !made.broken)
      const card = made ? await nudgeOnce($, made) : undefined
      if (!card) return ran
      return { ...ran, context: [...(ran.context ?? []), card] }
    } catch {
      return ran
    } finally {
      busy = false
    }
  // Fail open: a bug in the mod must never stop a tool call or a turn.
  }).catch(($, e, next) => next(e))

  // The backstop (LC-1893): a reply that states a status or says something is published / merged / deployed / live,
  // with no card in this session for that subject, is sent back ONCE (Claude Code sets stop_hook_active on the stop
  // after a block, and wws_gate.py always passes then, so it cannot loop). The NEEDS YOU guard (wws_needs_you.py, LC-1907) runs in
  // the same stop: a reply that opens with the banner and puts a decision_moot ticket to the operator. It lives in this plugin because the
  // cards it checks against are in this plugin's store, and a plugin's store is private to it.
  on('classic.Stop', async ($, e, next) => {
    const s = await load($)
    // While the lookup is broken it cannot produce the card the gate would demand: sending a reply back for it is noise.
    if (s.broken) return next(e)
    const v = await py($, { cmd: 'gate', ...(e as any), cards: s.ledger, moot_blocks: s.mootBlocks ?? 0 })
    if (typeof v?.block === 'string' && v.block) {
      // The NEEDS YOU guard (LC-1907) blocks a moot ask again on the re-send; this count is what stops that after MAX_REPEAT.
      if (v.block.includes('NEEDS YOU guard')) {
        s.mootBlocks = (s.mootBlocks ?? 0) + 1
        await save($, s)
      }
      toast($, v.block)
      return { block: v.block }
    }
    return next(e)
  }).catch(($, e, next) => next(e))
}
