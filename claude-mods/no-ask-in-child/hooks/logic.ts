// Which sessions may not call AskUserQuestion (LC-1968).
// Why: a session another session created ("no human is watching") kept calling AskUserQuestion even with
// "do not use it" in the brief, and sat blocked until the orchestrator interrupted it (LC-1951: ~18 h;
// LC-1943: twice; LC-1967: once). A recurring failure gets a deterministic guard, not a reminder.
//
// THE SIGNAL: `ccr.parent_session_id` from claude-code-remote `get_session` called with no id (it
// describes the caller). The platform sets it when a session is made by create_session and leaves it
// out for a session a person started. Measured 2026-10-31 on the build session of this very mod.
// Not used, on purpose: CLAUDE_CODE_SESSION_ATTENDED=1 was also set in that child (it does not mean a
// human is present), and CLAUDE_CODE_CHILD_SESSION could not be shown absent in a top-level session.

export const ASK_USER_QUESTION = 'AskUserQuestion'

export const DENY =
  '[mod:no-ask-in-child] No human is watching this session (a session created it; AskUserQuestion would block ' +
  'it with nobody to answer). Take the option you would recommend, state it in your brief or final message with ' +
  'the reason, and carry on; the choice is recorded in your PR or final message. If it is truly an operator ' +
  'decision, finish what you can and end your final message with "NEEDS YOU" plus the options and their ' +
  'trade-offs; the orchestrator relays it.'

export type Signal =
  | { kind: 'child'; parent: string }
  | { kind: 'top' }
  | { kind: 'unreadable'; reason: string }

/** Every balanced top-level {...} in the text, in order (strings and escapes respected). Prose braces before or
 *  after the real object cannot break the parse: each candidate is tried alone. */
export function jsonObjects(raw: string): unknown[] {
  const out: unknown[] = []
  let i = 0
  while (i < raw.length) {
    i = raw.indexOf('{', i)
    if (i < 0) break
    let depth = 0, inStr = false, esc = false, end = -1
    for (let j = i; j < raw.length; j++) {
      const c = raw[j]
      if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue }
      if (c === '"') inStr = true
      else if (c === '{') depth++
      else if (c === '}' && --depth === 0) { end = j; break }
    }
    let next = i + 1 // always advances, so the loop cannot stall
    if (end > i) { try { out.push(JSON.parse(raw.slice(i, end + 1))); next = end + 1 } catch { /* prose braces: try the next one */ } }
    i = next
  }
  return out
}

/** Reads a get_session reply (content blocks, as `$.mcp.call` returns it). Anything unclear is 'unreadable'. */
export function signalOf(res: unknown): Signal {
  try {
    const r = res as { isError?: boolean; content?: readonly unknown[] } | null | undefined
    if (!r || typeof r !== 'object') return { kind: 'unreadable', reason: 'no reply' }
    if (r.isError) return { kind: 'unreadable', reason: 'get_session returned an error' }
    const raw = (r.content ?? [])
      .map(b => (b && typeof b === 'object' && typeof (b as any).text === 'string' ? (b as any).text : ''))
      .join('')
    const objs = jsonObjects(raw)
    if (objs.length === 0) return { kind: 'unreadable', reason: 'reply has no JSON' }
    // The session description is the object that has ccr.id; prose or other objects around it are ignored.
    const all = (objs as any[]).map(o => o?.ccr).filter(c => c && typeof c.id === 'string' && c.id !== '')
    // Exactly one session object, or we do not know which one is ours: unreadable (allow), never a guess.
    if (all.length > 1) return { kind: 'unreadable', reason: 'reply holds several session objects' }
    const ccr = all[0]
    if (!ccr || typeof ccr.id !== 'string' || ccr.id === '') return { kind: 'unreadable', reason: 'reply has no ccr.id' }
    const p = ccr.parent_session_id
    if (typeof p === 'string' && p.trim() !== '') return { kind: 'child', parent: p.trim() }
    if (p === undefined || p === null || (typeof p === 'string' && p.trim() === '')) return { kind: 'top' }
    return { kind: 'unreadable', reason: 'parent_session_id has an unexpected type' }
  } catch (err) {
    return { kind: 'unreadable', reason: `parse failed: ${String(err).slice(0, 80)}` }
  }
}

/** { deny } only for a session with a parent; everything else (top-level, unreadable) is allowed. */
export function verdictFor(sig: Signal): { deny: string } | undefined {
  return sig.kind === 'child' ? { deny: DENY } : undefined
}
