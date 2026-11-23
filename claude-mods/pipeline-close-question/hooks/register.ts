import type { Register } from 'claude-code'

// Why (LCH-676, operator decision 2026-11-12): pipeline stories kept closing with the fault fixed and the next one of the
// same kind left to happen (LCH-685 exists because one closing comment asked the question). A pipeline story now closes
// only when its closing comment answers two questions. A transition call does not say the parent epic or the target
// status, so this reminds on every LCH transition and lets the session judge whether it applies. Advisory, fails open.
const TRANSITION = /__transitionJiraIssue$/
const LCH = /^LCH-\d+$/i

export const NOTE = (key: string) =>
  `[mod:pipeline-close-question] If ${key} is a delivery-pipeline story (a child of LC-2484) and this moved it to Done, its ` +
  'closing comment must answer: (1) will this issue recur, for this specific fault and for the kind of fault; (2) what can ' +
  'be done right now to prevent it: small items done in this session, larger ones pointed at a ticket. Post that comment ' +
  'now if it is not there (.github/PIPELINE.md, "Closing a pipeline story").'

export const register: Register = on => {
  on('tool.call', { tool: TRANSITION }, async ($, ev, next) => {
    const key = String((ev as unknown as Record<string, unknown>).issueIdOrKey ?? '').toUpperCase()
    const ran = await next(ev)
    if (!LCH.test(key) || ran.deny !== undefined || ran.isError) return ran
    $.ui.toast(`[mod:pipeline-close-question] ${key}: closing comment needs the recurrence answer`)
    return { ...ran, context: [...(ran.context ?? []), NOTE(key)] }
  }).catch(($, e, next) => next(e))
}
