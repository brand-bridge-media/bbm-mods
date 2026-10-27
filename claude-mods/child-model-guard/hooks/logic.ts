// Which create_session calls are refused or questioned (LC-1917).
// Why: an omitted `model` silently inherits the calling session's model, usually the top tier,
// so a child that only reads or builds to a spec costs ~3x what it should (CLAUDE.md section 2).

const ROUTING =
  'Routing (CLAUDE.md §2): haiku for reading/watching, sonnet for building to a spec or reviewing, a top-tier ' +
  'model only when the brief names a design judgment.'

export const NAME_MODEL =
  `[mod:child-model-guard] Name the child's model. ${ROUTING} ` +
  "An omitted model silently inherits this session's (usually top-tier) model, ~3x the cost."

export const TOP_TIER_ASK =
  `[mod:child-model-guard] This child is top-tier. ${ROUTING} ` +
  'The brief does not contain the phrase "design judgment"; name a cheaper model, or approve if this really is one.'

export const CREATE_SESSION = 'mcp__claude-code-remote__create_session'

/** { deny } / { ask } for a create_session input, or undefined to allow silently. */
export function verdictFor(input: Record<string, unknown>): { deny: string } | { ask: string } | undefined {
  const model = typeof input.model === 'string' ? input.model.trim() : ''
  if (model === '') return { deny: NAME_MODEL }
  if (/opus|fable/i.test(model) && !/design judgment/i.test(String(input.prompt ?? ''))) {
    return { ask: TOP_TIER_ASK }
  }
  return undefined
}
