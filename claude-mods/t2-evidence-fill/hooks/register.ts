import type { Register } from 'claude-code'

import { resultText, toastText } from './py'

// Why (LC-2156, the session side of LC-2153): a T2 pull request (money and config) is approved by the operator
// from a `## Evidence` section, not from the diff. LC-2153 step 3 says the section must cost the operator no
// time, so the session that opens the PR fills it. This mod does that one job:
//   1. after a successful test run (selftest, mutate.py, preflight, pytest, plugin test) it keeps the run's count
//      line, so it can be pasted into the Tests slot later;
//   2. when the session creates or edits a PR on a repo whose checkout carries scripts/ci/t2_evidence.py, and the
//      PR is T2, it inserts the section if missing, fills Tests from (1), and lets the call through rewritten;
//   3. when the call would make that T2 PR ready for review while a slot is still empty, it refuses with the gaps.
// All decisions live in ./t2-evidence-fill.py (its --selftest is the mutation-tested part); this file only
// gathers facts and acts. Fails open everywhere: a bug here must never stop a PR or a command.

const PR_TOOL = /^mcp__(github|GitHub_Custom)__(create_pull_request|update_pull_request)$/
// Cheap pre-filter so ordinary commands never start Python; the helper applies the real rule.
const TEST_HINT = /selftest|mutate\.py|preflight|pytest|plugin\s+test|unittest|\btest\b/i
const STORE_KEY = 'testCounts'
const KEEP = 8
const MAX_AGE_MS = 6 * 60 * 60 * 1000 // counts older than this belong to other work
const HELPER = 't2-evidence-fill.py'
const TIMEOUT_MS = 60_000

type Count = { source: string; line: string; at: number }

// Callout convention (claude-mods/README.md): prefix for the model, toast for the operator.
function say($: any, text: string): string {
  const msg = `[mod:t2-evidence-fill] ${text}`
  try { $.ui.toast(toastText(msg)) } catch { /* a toast never changes an outcome */ }
  return msg
}

async function helper($: any, payload: unknown): Promise<any> {
  try {
    const r = await $.process.run(['python3', '-I', `${$.plugin.root}/hooks/${HELPER}`],
      { stdin: JSON.stringify(payload), timeoutMs: TIMEOUT_MS })
    const out = String(r?.stdout ?? '').trim()
    if (r?.exitCode !== 0 || !out) return undefined
    const v = JSON.parse(out)
    return v && typeof v === 'object' ? v : undefined
  } catch { return undefined }
}

async function freshCounts($: any): Promise<Count[]> {
  try {
    const now = await $.clock.now()
    const list = (await $.store.get(STORE_KEY)) as Count[] | undefined
    return Array.isArray(list) ? list.filter(c => c && typeof c.line === 'string' && now - Number(c.at) <= MAX_AGE_MS) : []
  } catch { return [] }
}

async function remember($: any, entry: { source: string; line: string }): Promise<void> {
  try {
    const now = await $.clock.now()
    const list = (await freshCounts($)).filter(c => c.source !== entry.source)
    await $.store.set(STORE_KEY, [...list, { ...entry, at: now }].slice(-KEEP))
  } catch { /* losing a count only means the slot stays for the session to fill */ }
}

function textOf(r: { content?: readonly unknown[] }): string {
  return (r.content ?? []).map(c => String((c as { text?: unknown }).text ?? '')).join('')
}

/** The PR as it stands (head branch, body, draft), for an update call that does not carry them. */
async function readPr($: any, server: string, e: any): Promise<{ head: string; body: string; draft: boolean } | undefined> {
  try {
    const g = await $.mcp.call(server, 'pull_request_read', { method: 'get', owner: e.owner, repo: e.repo, pullNumber: e.pullNumber })
    if (g.isError) return undefined
    const pr = JSON.parse(textOf(g)) as { head?: { ref?: unknown }; body?: unknown; draft?: unknown }
    const head = String(pr?.head?.ref ?? '')
    return head ? { head, body: typeof pr.body === 'string' ? pr.body : '', draft: pr.draft === true } : undefined
  } catch { return undefined }
}

/** LC-2310: why a captured run was not written into Tests (other branch, not in the head's history, unstamped). */
function skippedList(skipped: unknown): string {
  return (Array.isArray(skipped) ? skipped : []).map((x: unknown) => `- ${String(x)}`).join('\n')
}

function gapList(missing: unknown): string {
  return (Array.isArray(missing) ? missing : [])
    .map((m: any) => `- ${m?.[0]}: ${m?.[1]}. How: ${m?.[2]}`).join('\n')
}

export const register: Register = on => {
  // (1) Keep the count line of each successful test run.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    try {
      const command = String((e as { command?: unknown }).command ?? '')
      if (ran.deny === undefined && !ran.isError && TEST_HINT.test(command)) {
        const v = await helper($, { mode: 'capture', command, output: resultText(ran as any).slice(-20_000),
          cwd: typeof (e as { cwd?: unknown }).cwd === 'string' ? (e as { cwd?: string }).cwd : undefined })
        if (v?.entry?.line) await remember($, v.entry)
      }
    } catch { /* never change the command's outcome */ }
    return ran
  }).catch(($, e, next) => next(e))

  // (2) and (3) Fill the Evidence section of a T2 PR; refuse to make it ready with a slot empty.
  on('tool.call', { tool: PR_TOOL }, async ($, ev, next) => {
    const e = ev as unknown as Record<string, any>
    const server = String(e.tool).split('__')[1] ?? 'github'
    const isCreate = String(e.tool).endsWith('__create_pull_request')
    let head = String(e.head ?? '')
    let body: string | undefined = typeof e.body === 'string' ? e.body : undefined
    let ready = isCreate ? e.draft !== true : false
    if (!isCreate) {
      // An update that neither edits the body nor marks the PR ready (a title, a base) is not this mod's business.
      if (body === undefined && e.draft !== false) return next(ev)
      const pr = await readPr($, server, e)
      if (!pr) return next(ev)
      head = pr.head
      if (body === undefined) body = pr.body
      ready = e.draft === false && pr.draft // leaving draft now
    }
    const out = await helper($, {
      mode: 'fill', owner: e.owner, repo: e.repo, head, body: body ?? '', ready, counts: await freshCounts($),
    })
    if (!out?.applicable) return next(ev)

    if (out.deny) {
      return {
        deny: say($, `This ${out.tier} PR would leave draft with Evidence slots still empty (LC-2153: the operator approves `
          + `from this proof). Nothing was sent. Fill each slot below or write \`n/a: <reason>\`, then repeat the call, `
          + `or open it as a draft first.\n${gapList(out.missing)}\n`
          + (skippedList(out.skipped) ? `NOT CHECKED, test runs left out of Tests (they do not test this PR's head):\n${skippedList(out.skipped)}\n` : '')
          + `Check a body before sending: python3 scripts/ci/t2_evidence.py body --file <body.md>`),
      }
    }

    const rewritten = typeof out.body === 'string' && out.body !== (body ?? '')
    const ran = await next(rewritten ? { ...ev, body: out.body } as any : ev)
    if (ran.deny !== undefined || ran.isError) return ran
    try {
      const notes: string[] = []
      if (rewritten && Array.isArray(out.changed) && out.changed.length) {
        notes.push(say($, `Evidence section (${out.tier}): ${out.changed.join('; ')}.`))
      }
      if (skippedList(out.skipped)) {
        notes.push(`[mod:t2-evidence-fill] NOT CHECKED: these test runs were left out of Tests because they do not test this `
          + `PR's head (LC-2310). Re-run the tests on the head commit, or write the Tests line yourself:\n${skippedList(out.skipped)}`)
      }
      if (Array.isArray(out.missing) && out.missing.length) {
        notes.push(`[mod:t2-evidence-fill] Still empty; fill these (or \`n/a: <reason>\`) with update_pull_request before `
          + `marking the PR ready:\n${gapList(out.missing)}`)
      }
      return notes.length ? { ...ran, context: [...(ran.context ?? []), ...notes] } : ran
    } catch { return ran } // a note that fails to build never hides the PR the call created
  // Fail open: before the call ran, let it through untouched; never run it twice.
  }).catch(($, e, next) => (next.called ? { deny: '[mod:t2-evidence-fill] internal error after the call ran; it did run.' } : next(e)))
}
