import type { Register } from 'claude-code'

import type { HookOut } from './py'
import { decisionOf, parseOut, runArgs, toolPayload } from './py'

// Why (LC-1983): very large source files are where edits most often break things, and they grew by
// many small additions. CI (file-size-ratchet) is the gate; this is the reminder at the moment of the
// edit. It only ever adds context: ./oversized-file-nudge.py never emits a deny or an ask, and a
// failure here lets the call through untouched. Only a source extension starts the check.
const SOURCE = /\.(py|ts|tsx|js|mjs)$/

async function runCheck($: any, script: string, payload: unknown): Promise<HookOut | undefined> {
  try {
    const { argv, init } = runArgs($.plugin.root, script, payload)
    return parseOut(await $.process.run(argv, init))
  } catch {
    return undefined
  }
}

export const register: Register = on => {
  on('classic.PreToolUse', { tool: /^(Write|Edit|MultiEdit)$/ }, async ($, e, next) => {
    const path = String((e as any).file_path ?? '')
    if (!SOURCE.test(path)) return next(e)
    const d = decisionOf(await runCheck($, 'oversized-file-nudge.py', toolPayload(e as any)))
    // Advisory by construction: anything but a note is ignored, so this mod can never deny. The call
    // runs first (the guards beneath it still apply); the note rides along with its result.
    if (!d || !('additionalContext' in d)) return next(e)
    const ran = await next(e)
    return { ...ran, additionalContext: [...((ran as any).additionalContext ?? []), ...d.additionalContext] }
  // Fail open: a bug in the mod must never stop a tool call or a turn.
  }).catch(($, e, next) => next(e))
}
