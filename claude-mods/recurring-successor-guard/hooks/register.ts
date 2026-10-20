import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Row } from '../types'
import type { HookOut } from './py'
import { blockReason, contextOf, decisionOf, parseOut, resultText, runArgs, toastText, toolPayload } from './py'

// Why (LCH-528, Stan: "recurring work gets its successor scheduled before it's closed"): closing a
// recurring ticket with no successor is how a monthly check silently stops. A PreToolUse hook gets
// no transcript, so this mod records the calls the check reads (the ticket, its transitions, any
// successor) and hands them over as transcript rows. Logic and tests: ./recurring-successor-guard.py.
const RECORD = /^(mcp__.*__(getJiraIssue|getTransitionsForJiraIssue|createJiraIssue|create_trigger|send_later)|CronCreate)$/
const MAX_ROWS = 200
const MAX_TEXT = 20_000
const rows = atom({ plugin: 'recurring-successor-guard', key: 'rows' } as const, [] as Row[])

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

// Deny and ask are toasted for Stan; a warning is not.
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
  on('tool.call', { tool: RECORD }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError) return ran
    const { tool_name, tool_input } = toolPayload(e as any)
    const id = String((e as any).tool_use_id ?? '')
    await update($, rows, l => [...l,
      { type: 'assistant', message: { content: [{ type: 'tool_use', id, name: tool_name, input: tool_input }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: resultText(ran).slice(0, MAX_TEXT) }] } },
    ].slice(-MAX_ROWS))
    return ran
  // A recording failure must never change the call's outcome.
  }).catch(($, e, next) => next(e))

  on('classic.PreToolUse', { tool: /^mcp__.*__transitionJiraIssue$/ }, async ($, e, next) =>
    preToolUse($, await runCheck($, 'recurring-successor-guard.py',
      { ...toolPayload(e as any), transcript_rows: await read($, rows) })) ?? next(e),
  // Fail open: a bug in the mod must never stop a tool call or a turn (runCheck already fails open).
  ).catch(($, e, next) => next(e))
}
