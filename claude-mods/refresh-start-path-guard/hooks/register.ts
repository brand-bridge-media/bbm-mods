import type { Register } from 'claude-code'

import { bashNumericStart, bashStartsRefresh, DENY, DENY_NUMERIC, mcpStartsRefresh, numericStart, workflowIsRefresh } from './logic'

// Why (LC-1975): see ./logic.ts. Decisions live there; this file only routes tool calls to them.

function deny($: any, text = DENY) {
  try { $.ui.toast(text.slice(0, 200)) } catch { /* a toast never changes a verdict */ }
  return { deny: text }
}

function textOf(r: { content?: readonly unknown[] }): string {
  return (r.content ?? []).map(c => String((c as { text?: unknown }).text ?? '')).join('')
}

export const register: Register = on => {
  on('tool.call', { tool: /^mcp__.*__actions_run_trigger$/ }, async ($, e, next) => {
    const a = e as any
    if (mcpStartsRefresh(a)) return deny($)
    const id = numericStart(a)
    if (id === null) return next(e)
    // A numeric id hides the file name: look it up, and refuse when the answer is refresh-run.yml or unreadable
    // (CI reviewer, #2429 finding 3). The file name always works, so a refused lookup costs one retry.
    let verdict: boolean | null = null
    try {
      const r = await $.mcp.call(String(a.tool).split('__')[1] ?? 'github', 'actions_get', { method: 'get_workflow', owner: a.owner, repo: a.repo, resource_id: id })
      verdict = r.isError ? null : workflowIsRefresh(textOf(r))
    } catch { verdict = null }
    if (verdict === true) return deny($)
    if (verdict === null) return deny($, DENY_NUMERIC)
    return next(e)
  // Fail open: a bug here must never stop a tool call.
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const cmd = String((e as any).command ?? '')
    if (bashStartsRefresh(cmd)) return deny($)
    return bashNumericStart(cmd) ? deny($, DENY_NUMERIC) : next(e)
  }).catch(($, e, next) => next(e))
}
