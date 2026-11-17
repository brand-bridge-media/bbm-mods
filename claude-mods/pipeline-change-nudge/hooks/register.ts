import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

// Why (LCH-676, operator decision 2026-11-11): three pipeline redesigns each changed one part without a view of the
// whole, and on 2026-11-11 three pipeline changes merged in one day, one of which stalled merging. Pipeline changes are
// now deliberate: written against the owner doc, with a statement of impact, one at a time. This mod is the reminder at
// the moment of the edit. The judgment (statement complete, one in flight) is scripts/ci/pipeline_change.py in `quick`,
// where it runs the same for every session; a mod only loads where it is installed, so it cannot be the lock.
//
// Advisory by construction: it only adds context, once per session, and fails open.
// Pipeline paths mirror infra/pipeline-register.json change_procedure.paths (a mod cannot read the repo at rest).
const PIPELINE = /^(\.github\/workflows\/|scripts\/ci\/|\.mergify\.yml$|\.trunk\/trunk\.yaml$|scripts\/quality\/expected_required_checks\.json$|infra\/pipeline-register\.json$)/
const told = atom({ plugin: 'pipeline-change-nudge', key: 'told' } as const, false)

/** The bbm-infrastructure repo-relative path, or undefined when the file is not in that repo. */
export function repoPath(p: string): string | undefined {
  const m = p.match(/(?:^|\/)bbm-infrastructure\/(.+)$/)
  if (m) return m[1]
  return p.startsWith('/') ? undefined : p.replace(/^\.\//, '')
}

export function isPipeline(p: string): boolean {
  const rel = repoPath(p)
  return rel !== undefined && PIPELINE.test(rel)
}

export const NOTE =
  '[mod:pipeline-change-nudge] This edits the delivery pipeline (LCH-676). Before you push: (1) read .github/PIPELINE.md ' +
  '(the seven steps, required checks, runner budget, rules); (2) give the PR body a `## Pipeline change` section: Step, Adds, ' +
  'Removes (in this same PR), Runner-minutes per push (before and after), Back-out; (3) check no other open, ready PR changes ' +
  'a pipeline path: one pipeline change in flight at a time. quick\'s pipeline_change step checks (2) and (3). A new or ' +
  'retired workflow also needs its line in infra/pipeline-register.json.'

export const register: Register = on => {
  on('tool.call', { tool: /^(Write|Edit|MultiEdit|NotebookEdit)$/ }, async ($, ev, next) => {
    const e = ev as unknown as Record<string, unknown>
    const path = String(e.file_path ?? e.notebook_path ?? '')
    if (!isPipeline(path) || (await read($, told))) return next(ev)
    const ran = await next(ev)
    if (ran.deny !== undefined || ran.isError) return ran
    await update($, told, () => true)
    $.ui.toast('[mod:pipeline-change-nudge] pipeline file edited: statement + one-in-flight apply')
    return { ...ran, context: [...(ran.context ?? []), NOTE] }
  // Fail open: a bug in the mod must never stop a tool call.
  }).catch(($, e, next) => next(e))
}
