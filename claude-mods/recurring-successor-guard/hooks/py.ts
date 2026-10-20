// Shared by every policy mod that wraps a Python check (LCH-528). A mod cannot import a
// sibling, so each carries a byte-identical copy; claude-mods.yml fails if the copies drift.
//
// Why Python under a mod: the checks were built and mutation-tested as stdlib Python
// (classic hook in, classic hook out). The mod is how they reach every repo's sessions;
// the .py file stays the single place the rule's logic lives, with its own --selftest.
//
// PURE BY CONSTRAINT: the plugin validator (claude-code 2.1.292, the version CI pins) follows
// `$` only into functions declared in the hook's own file. So nothing here takes `$`; each
// register.ts keeps three small `$` helpers (runCheck, preToolUse, blockOf) over these.

export type HookOut = {
  hookSpecificOutput?: {
    permissionDecision?: string
    permissionDecisionReason?: string
    additionalContext?: string
  }
  decision?: string
  reason?: string
}

// tool.call envelope fields that are the engine's, not the tool's arguments.
const RESERVED = new Set(['tool', 'tool_use_id', 'agentId', 'requestMeta'])

/** The classic hook payload's tool fields, rebuilt from a tool.call envelope. */
export function toolPayload(e: Record<string, unknown>): { tool_name: string; tool_input: Record<string, unknown> } {
  const tool_input: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(e)) if (!RESERVED.has(k)) tool_input[k] = v
  return { tool_name: String(e.tool ?? ''), tool_input }
}

/** argv and init for `$.process.run`: hooks/<script> with the payload on stdin. */
export function runArgs(root: string, script: string, payload: unknown): { argv: string[]; init: { stdin: string; timeoutMs: number } } {
  return { argv: ['python3', '-I', `${root}/hooks/${script}`], init: { stdin: JSON.stringify(payload), timeoutMs: 10_000 } }
}

/**
 * The check's JSON output, or undefined on a non-zero exit, silence or junk. The checks fail
 * open (a guard that fails shut blocks every call and gets removed), as they did as hooks.
 */
export function parseOut(r: { exitCode?: number; stdout?: unknown }): HookOut | undefined {
  const out = String(r?.stdout ?? '').trim()
  if (r?.exitCode !== 0 || !out) return undefined
  try {
    const v = JSON.parse(out)
    return v && typeof v === 'object' ? (v as HookOut) : undefined
  } catch {
    return undefined
  }
}

/**
 * A classic.PreToolUse answer from a check's output. A check that only warns
 * (additionalContext, no decision) lets the call run with its note.
 */
export function decisionOf(v: HookOut | undefined):
  { deny: string } | { ask: string } | { additionalContext: string[] } | undefined {
  const h = v?.hookSpecificOutput
  const reason = String(h?.permissionDecisionReason ?? '')
  if (h?.permissionDecision === 'deny' && reason) return { deny: reason }
  if (h?.permissionDecision === 'ask' && reason) return { ask: reason }
  const note = contextOf(v)
  return note ? { additionalContext: [note] } : undefined
}

/** The check's additionalContext, if it gave one. */
export function contextOf(v: HookOut | undefined): string | undefined {
  const c = v?.hookSpecificOutput?.additionalContext
  return typeof c === 'string' && c ? c : undefined
}

/** A Stop block reason, if the check asked to block the turn's end. */
export function blockReason(v: HookOut | undefined): string | undefined {
  return v?.decision === 'block' && typeof v.reason === 'string' && v.reason ? v.reason : undefined
}

/** The text a tool call's result carries, for checks that read it (PostToolUse-style). */
export function resultText(ran: { text?: unknown; result?: unknown }): string {
  if (typeof ran.text === 'string') return ran.text
  try { return JSON.stringify(ran.result ?? '') } catch { return '' }
}

/** A toast's text: the first line, capped. */
export function toastText(text: string): string {
  return text.split('\n')[0]!.slice(0, 200)
}
