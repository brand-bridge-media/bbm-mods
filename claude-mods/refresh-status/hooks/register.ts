import type { Register } from 'claude-code'

import type { HookOut } from './py'
import { parseOut, runArgs } from './py'

// Why (LC-2020): the operator wants one status table per refresh whenever they ask, without opening a
// session first. The Refresh Overseer writes the table every tick (public.v_refresh_status); this mod
// delivers it at the moment the operator types "refresh status", with the order to show it verbatim.
// Matching, wording and the SQL live in ./refresh-status.py (own --selftest); this file moves bytes.
// Fails open: any error means the prompt goes through unchanged, never a blocked prompt. A failed READ is
// different: the model is told NOT CHECKED, so it cannot answer from memory.
const SCRIPT = 'refresh-status.py'

type Opts = { supabaseServer?: string; projectId?: string }

// --- $ helpers (the plugin validator follows $ only into functions declared in this file).
async function py($: any, payload: unknown): Promise<any> {
  try {
    const { argv, init } = runArgs($.plugin.root, SCRIPT, payload)
    return parseOut(await $.process.run(argv, init)) as (HookOut & { match?: boolean; sql?: string }) | undefined
  } catch {
    return undefined
  }
}

// A cloud session names its Supabase server by a UUID (`mcp__<uuid>__execute_sql`), not "Supabase"
// (where-we-stand, LC-1893): take the name from a tool the session really has.
async function serverName($: any, configured: string): Promise<string> {
  try {
    const all: string[] = ((await $.tool.list()) ?? []).map((t: { name: unknown }) => String(t.name))
    const names = all.filter(n => n.startsWith('mcp__') && n.endsWith('__execute_sql')).map(n => n.slice(5, n.length - '__execute_sql'.length))
    return names.includes(configured) ? configured : (names[0] ?? configured)
  } catch {
    return configured
  }
}

function rowsOf(content: readonly unknown[]): unknown[] {
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
  return rows
}

async function readRows($: any, o: Opts, sql: string): Promise<{ rows?: unknown[]; error?: string }> {
  try {
    const res = await $.mcp.call(await serverName($, o.supabaseServer || 'Supabase'), 'execute_sql', {
      project_id: o.projectId || 'tlcbwwgfqnasmiipgmmd',
      query: sql,
    })
    if (res.isError) return { error: 'execute_sql returned an error' }
    return { rows: rowsOf(res.content) }
  } catch (e) {
    return { error: String((e as Error)?.message ?? e).slice(0, 160) }
  }
}

export const register: Register = (on, options) => {
  const o = (options ?? {}) as Opts
  on('prompt.submit', async ($, e, next) => {
    if (e.command || e.isMeta) return next(e)
    const hit = await py($, { prompt: e.text })
    if (!hit?.match || typeof hit.sql !== 'string') return next(e)
    const got = await readRows($, o, hit.sql)
    const out = await py($, { prompt: e.text, ...(got.rows ? { rows: got.rows } : { error: got.error ?? 'no answer' }) })
    // A matched prompt is never a silent no-op: if the check gave nothing back, say NOT CHECKED so the model cannot answer from memory.
    const given = out?.hookSpecificOutput?.additionalContext
    const note = typeof given === 'string' && given
      ? given
      : '[mod:refresh-status] NOT CHECKED: the refresh status check returned no answer. Tell the operator it was not checked. Do not invent or recall a table.'
    return next({ ...e, context: [...(e.context ?? []), note] })
  // Fail open: a bug in the mod must never stop a prompt.
  }).catch(($, e, next) => next(e))
}
