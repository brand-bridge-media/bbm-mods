import type { Register } from 'claude-code'

import type { HookOut } from './py'
import { blockReason, contextOf, decisionOf, parseOut, resultText, runArgs, toastText, toolPayload } from './py'

// Why (LCH-528, operator preference: name chats by ticket): a hook cannot read the title, so it puts
// the rule in front of the model at the two moments it matters: the start, and the moment a ticket
// key first exists. Text and tests: ./session-title-nudge.py.
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
  on('classic.SessionStart', async ($, e, next) => {
    const ran = await next(e)
    const note = contextOf(await runCheck($, 'session-title-nudge.py', { hook_event_name: 'SessionStart' }))
    return note ? { ...ran, additionalContext: [...(ran.additionalContext ?? []), note] } : ran
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: /^mcp__.*__createJiraIssue$/ }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError) return ran
    const note = contextOf(await runCheck($, 'session-title-nudge.py',
      { hook_event_name: 'PostToolUse', tool_name: String((e as any).tool), tool_response: resultText(ran) }))
    return note ? { ...ran, context: [...(ran.context ?? []), note] } : ran
  // Fail open: a bug in the mod must never stop a tool call or a turn (runCheck already fails open).
  }).catch(($, e, next) => next(e))
}
