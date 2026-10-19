import type { Ledger } from '../types'

// Pure helpers for the mod-actions list (LC-1711), kept apart from register.tsx so tests can call
// them directly: a test module cannot fire a toast, so the toast/deny dedupe is proven here.

// Anchored: a real mod message STARTS with its tag. A `[mod:x]` in the middle of a string is quoted
// content (a diff, a README line, a file being read), not an action, and is never listed.
const MOD_TAG = /^\s*\[mod:([a-z][a-z0-9-]*)\]\s*([^\n"\\]{0,160})/
const MOD_ACTIONS_MAX = 30
export const OWN_MOD = 'session-close'
// Tools that are themselves a mod's surface: only their result / text is the mod speaking. Every
// other tool (Read, Bash, any MCP file or search tool) carries other people's text, so only the
// `deny` and `context` a mod attaches to its call are trusted there. Allow-list, not deny-list:
// a new content tool must not become a place where quoted `[mod:` text counts.
export const MOD_TOOLS = /^mcp__fleet-tracker__/

// "name: reason" lines for each string that begins with a mod tag, never this mod's own nudges.
export function modActionsIn(texts: readonly unknown[]): string[] {
  const out: string[] = []
  for (const t of texts) {
    if (typeof t !== 'string') continue
    const m = MOD_TAG.exec(t)
    if (!m || m[1] === OWN_MOD) continue
    const line = `${m[1]}: ${m[2].trim().replace(/\s+/g, ' ')}`
    if (!out.includes(line)) out.push(line)
  }
  return out
}

// The same action seen twice: a toast cuts its text at 160 characters ("...") while the deny line
// carries the full reason, so the two differ only in a truncated tail. Same mod, and equal after
// normalising or one is the "..."-cut stem of the other.
const split = (a: string): [string, string] => {
  const i = a.indexOf(': ')
  return i < 0 ? [a, ''] : [a.slice(0, i), a.slice(i + 2)]
}
const isCut = (r: string): boolean => /(\.{3}|\u2026)$/.test(r)
const stem = (r: string): string => r.replace(/(\.{3}|\u2026)$/, '').replace(/\s+/g, ' ').trim().toLowerCase()
export function sameAction(a: string, b: string): boolean {
  const [ma, ra] = split(a)
  const [mb, rb] = split(b)
  if (ma !== mb) return false
  const sa = stem(ra)
  const sb = stem(rb)
  return sa === sb || (isCut(ra) && sb.startsWith(sa)) || (isCut(rb) && sa.startsWith(sb))
}

// `?? []`: a ledger the session built before this field existed (hot reload keeps $.state) has no modActions.
export function withModActions(l: Ledger, found: string[]): Ledger {
  const next = [...(l.modActions ?? [])]
  let changed = false
  for (const f of found) {
    const i = next.findIndex(h => sameAction(h, f))
    if (i < 0) { next.push(f); changed = true; continue }
    // Keep the fuller wording: a cut toast is replaced by the full deny line, never the reverse.
    if (isCut(split(next[i])[1]) && !isCut(split(f)[1])) { next[i] = f; changed = true }
  }
  return changed ? { ...l, modActions: next.slice(-MOD_ACTIONS_MAX) } : l
}

