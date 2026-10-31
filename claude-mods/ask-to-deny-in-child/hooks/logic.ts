// Permission prompts in a session nobody watches become denies (LC-1968, second PR).
// Why: the LC-1943 child sat 24+ min on a control_request from plugin run-state ("confirm this receipt
// write. Allow this write?") that fired on a plain --selftest loop. ~20 mods return `ask` on their own;
// one hook on the permission request itself covers all of them, and every engine prompt, in one place.
//
// THE SIGNAL is the same as no-ask-in-child: `ccr.parent_session_id` from get_session (no id). It is
// copied, not imported (a mod cannot import a sibling); the two copies are small and both tested.
// Fail open means: a signal we cannot read leaves the prompt as it was (a person may be there).

export const GUIDANCE =
  'No human can answer this in this session (a session created it). Take the safe path (a read-only or ' +
  'narrower action, or skip the step), record the choice and why in your PR or final message; if the action is ' +
  'truly needed and only the operator can allow it, finish what you can and end your final message with ' +
  '"NEEDS YOU" plus the options.'

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

/** Names the prompt's tool and any reason the event carries, so the model knows what was refused. */
export function describe(e: unknown): string {
  const x = (e ?? {}) as Record<string, unknown>
  const tool = [x.tool_name, x.tool, x.toolName].find(v => typeof v === 'string' && v !== '')
  const why = [x.reason, x.message, x.description].find(v => typeof v === 'string' && v !== '')
  return (tool ? ` Tool: ${String(tool).slice(0, 120)}.` : '') + (why ? ` Reason given: ${String(why).slice(0, 400)}` : '')
}

export function denyText(e: unknown): string {
  return `[mod:ask-to-deny-in-child] Permission request refused.${describe(e)} ${GUIDANCE}`
}

/** The PermissionRequest answer for a child; undefined (leave the prompt) for top-level and unreadable. */
export function answerFor(sig: Signal, e: unknown): { decision: { behavior: 'deny'; message: string } } | undefined {
  return sig.kind === 'child' ? { decision: { behavior: 'deny', message: denyText(e) } } : undefined
}
