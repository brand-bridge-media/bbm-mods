import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import { ATLASSIAN, readToRecord, verdictFor } from './logic'

// Why (LC-2118): see ./logic.ts. Comment reads are recorded per session in an atom; a write to a ticket
// with no recorded read is denied, and the text is toasted so the operator sees it too (callout convention).
const reads = atom({ plugin: 'jira-read-before-write', key: 'reads' } as const, [] as string[])

export const register: Register = on => {
  // Record a comment read once the call has actually succeeded.
  on('tool.call', { tool: ATLASSIAN }, async ($, ev, next) => {
    const e = ev as unknown as Record<string, unknown>
    const ran = await next(ev)
    try {
      const key = readToRecord(String(e.tool), e)
      if (key && ran.deny === undefined && !ran.isError) {
        await update($, reads, list => (list.includes(key) ? list : [...list, key]))
      }
    } catch { /* best effort: a missed recording only means a later write is refused with the fix */ }
    return ran
  })

  on('classic.PreToolUse', { tool: ATLASSIAN }, async ($, e, next) => {
    let v: { deny: string } | undefined
    try {
      const ev = (e ?? {}) as unknown as Record<string, unknown>
      v = verdictFor(String(ev.tool ?? ''), ev, await read($, reads))
    } catch { return next(e) } // fail open on a state or parse error
    if (v === undefined) return next(e)
    try { $.ui.toast(v.deny) } catch { /* a toast never changes a verdict */ }
    return v
  // Fail open: a bug here must never stop a tool call.
  }).catch(($, e, next) => next(e))
}
