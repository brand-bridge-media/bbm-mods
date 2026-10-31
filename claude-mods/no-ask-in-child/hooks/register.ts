import type { Register } from 'claude-code'

import { ASK_USER_QUESTION, signalOf, verdictFor, type Signal } from './logic'

// Why (LC-1968): see ./logic.ts. One get_session (no id = the caller) per module life. A parent never
// changes, so a readable answer is cached; an unreadable one is retried on the next AskUserQuestion.
const SERVER = 'claude-code-remote'

export const register: Register = on => {
  let cached: Signal | undefined // per registration, so a test world never inherits another's answer
  on('classic.PreToolUse', { tool: ASK_USER_QUESTION }, async ($, e, next) => {
    let sig = cached
    if (!sig) {
      try {
        sig = signalOf(await $.mcp.call(SERVER, 'get_session', {}))
      } catch (err) {
        sig = { kind: 'unreadable', reason: `get_session call failed: ${String(err).slice(0, 80)}` }
      }
      if (sig.kind !== 'unreadable') cached = sig
    }
    if (sig.kind === 'unreadable') {
      // Fail open, with the reason on record: a signal we cannot read must never block a person.
      try { $.ui.log(`no-ask-in-child: allowed AskUserQuestion, signal unreadable (${sig.reason})`, { to: 'debug' }) } catch { /* logging never changes a verdict */ }
      return next(e)
    }
    const v = verdictFor(sig)
    if (v === undefined) return next(e)
    try { $.ui.toast(v.deny) } catch { /* a toast never changes a verdict */ }
    return v
  // Fail open: a bug here must never stop a tool call.
  }).catch(($, e, next) => next(e))
}
