import type { Register } from 'claude-code'

import type { HookOut } from './py'
import { blockReason, contextOf, decisionOf, parseOut, resultText, runArgs, toastText, toolPayload } from './py'

// Why (LCH-528): every repo's .claude/skills/ is a CI byte copy of claude-skills; an edit there is
// overwritten by the next mirror and never reaches chat or Cowork. Only a path under
// .claude/skills/ starts the check; ./skill-copy-guard.py decides.
const COPY = /(^|[\\/])\.claude[\\/]skills[\\/]/

// --- $ helpers. They live in this file because the plugin validator follows $ only into functions
// declared in the hook's own file (claude-code 2.1.292); ./py.ts stays pure.
async function runCheck($: any, script: string, payload: unknown): Promise<HookOut | undefined> {
  try {
    const { argv, init } = runArgs($.plugin.root, script, payload)
    return parseOut(await $.process.run(argv, init))
  } catch {
    return undefined
  }
}

function toast($: any, text: string): void {
  try { $.ui.toast(toastText(text)) } catch { /* a toast never changes a verdict */ }
}

// Deny and ask are toasted for the operator; a warning is not.
function preToolUse($: any, v: HookOut | undefined) {
  const d = decisionOf(v)
  if (d && 'deny' in d) toast($, d.deny)
  if (d && 'ask' in d) toast($, d.ask)
  return d
}

function blockOf($: any, v: HookOut | undefined): string | undefined {
  const r = blockReason(v)
  if (r) toast($, r)
  return r
}

export const register: Register = on => {
  on('classic.PreToolUse', { tool: /^(Write|Edit|MultiEdit|NotebookEdit)$/ }, async ($, e, next) => {
    const path = String((e as any).file_path ?? (e as any).notebook_path ?? '')
    if (!COPY.test(path)) return next(e)
    return preToolUse($, await runCheck($, 'skill-copy-guard.py', toolPayload(e as any))) ?? next(e)
  // Fail open: a bug in the mod must never stop a tool call or a turn (runCheck already fails open).
  }).catch(($, e, next) => next(e))
}
