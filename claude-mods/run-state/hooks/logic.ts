import type { RunView } from '../types'

// Pure logic for the run-state mod, kept apart from register.tsx so tests can
// call it directly. Business analogy: the conductor is the foreman's job board;
// this file reads the board and decides whether a worker may sign off a job.

// Runs refresh_conductor.py's own DAG on a refresh_runs row fed on stdin. The
// conductor's live mode needs SUPABASE_* in the shell, which a cloud session
// does not have (LC-1715 step 0); --snapshot-style input does work, so the mod
// reads the row through the Supabase MCP and hands it over here. argv[1] = path.
export const PY_HELPER = [
  'import importlib.util, json, sys',
  'spec = importlib.util.spec_from_file_location("rc", sys.argv[1])',
  'm = importlib.util.module_from_spec(spec)',
  'sys.modules["rc"] = m',
  'spec.loader.exec_module(m)',
  'raw = m.snapshot_row(json.loads(sys.stdin.read()))',
  'snap = m.RunSnapshot.model_validate(m.normalise_row(raw))',
  'plan = m.evaluate(snap)',
  'table = m.SECTIONS_V2 if snap.pipeline_version == 2 else m.SECTIONS',
  'prov = raw.get("selection_provenance") or {}',
  'audit = (prov.get("technical_audit") or {}) if isinstance(prov, dict) else {}',
  'pa = audit.get("pass_a") if isinstance(audit, dict) else None',
  'print(json.dumps({',
  '  "plan": json.loads(plan.model_dump_json()),',
  '  "table": [{"id": s.id, "stage": s.stage, "part": s.part} for s in table],',
  '  "pass_a": {"verdict": pa.get("verdict"), "at": pa.get("at")} if isinstance(pa, dict) else None,',
  '}))',
].join('\n')

// Only these two shapes ever reach SQL, so a pin can never smuggle a quote in.
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SLUG = /^[a-z0-9][a-z0-9-]{0,120}$/i

export const LIST_ACTIVE_SQL =
  "select id, article_slug, status from refresh_runs where status in ('in_progress','awaiting_approval') order by created_at desc limit 5"

export function pinClause(pin: string): string | null {
  if (UUID.test(pin)) return `id = '${pin.toLowerCase()}'`
  if (SLUG.test(pin)) return `article_slug = '${pin.toLowerCase()}'`
  return null
}

// The same two reads over PostgREST (LC-1711): a cloud build session has no Supabase MCP server, but
// the bulk-operations tools (refresh_conductor.fetch_run) read refresh_runs with SUPABASE_URL +
// SUPABASE_SERVICE_ROLE_KEY, so the mod can too. Same shape gate as pinClause: only a UUID or a slug
// reaches the URL, and the value is encoded anyway.
const RUN_COLS = 'id,article_slug,status,stages,selection_provenance,created_at,pipeline_version'
export const REST_ACTIVE_QS =
  'select=id,article_slug,status&status=in.(in_progress,awaiting_approval)&order=created_at.desc&limit=5'

export function restRowQs(pin: string): string | null {
  const col = UUID.test(pin) ? 'id' : SLUG.test(pin) ? 'article_slug' : null
  return col ? `select=${RUN_COLS}&${col}=eq.${encodeURIComponent(pin.toLowerCase())}&order=created_at.desc&limit=1` : null
}

export function restUrl(base: string, qs: string): string {
  return `${base.trim().replace(/\/+$/, '')}/rest/v1/refresh_runs?${qs}`
}

export function rowsFromRest(text: string): unknown[] {
  const rows = JSON.parse(text)
  if (!Array.isArray(rows)) throw new Error('PostgREST rows were not an array')
  return rows
}

export const rowSql = (where: string): string =>
  'select id, article_slug, status, stages, selection_provenance, created_at, pipeline_version ' +
  `from refresh_runs where ${where} order by created_at desc limit 1`

// A reply that is itself a JSON object carrying a string `result` is unwrapped to that string.
function unwrapResult(text: string): string {
  const t = text.trim()
  if (!t.startsWith('{')) return text
  try {
    const o = JSON.parse(t)
    return o && typeof o === 'object' && typeof o.result === 'string' ? o.result : text
  } catch {
    return text
  }
}


// execute_sql wraps its rows in an "untrusted-data" envelope; take the JSON array inside.
export function rowsFromMcp(content: readonly unknown[]): unknown[] {
  const joined = content
    .map(b => (b && typeof b === 'object' && 'text' in b ? String((b as { text: unknown }).text) : ''))
    .join('')
  // The Supabase MCP may return the whole reply as JSON, {"result":"...<untrusted-data>[{\"id\":...}]..."},
  // so the rows inside still carry escaped quotes. Unwrap that layer first; anything else stays as text.
  const text = unwrapResult(joined)
  // The rows sit inside the server's untrusted-data envelope; prose outside it may hold brackets.
  const env = /<untrusted-data-[^>]*>([\s\S]*)<\/untrusted-data-[^>]*>/.exec(text)
  const body = env ? env[1] : text
  const open = body.indexOf('[')
  const close = body.lastIndexOf(']')
  if (open < 0 || close < open) throw new Error('execute_sql returned no row array')
  const rows = JSON.parse(body.slice(open, close + 1))
  if (!Array.isArray(rows)) throw new Error('execute_sql rows were not an array')
  return rows
}

type Plan = {
  run_id: string | null
  slug: string | null
  run_status: string | null
  pipeline_version: number
  sections: { id: string; label: string; state: string; unmet: string[] }[]
}

export function viewFromHelper(out: string, now: number): RunView {
  const o = JSON.parse(out) as { plan: Plan; table: RunView['table']; pass_a: RunView['passA'] }
  if (!o.plan || !Array.isArray(o.plan.sections) || o.plan.sections.length === 0 || !o.plan.run_id) {
    throw new Error('conductor returned an empty plan')
  }
  return {
    runId: o.plan.run_id,
    slug: o.plan.slug ?? '?',
    status: o.plan.run_status ?? '?',
    pipelineVersion: o.plan.pipeline_version,
    sections: o.plan.sections.map(s => ({ id: s.id, label: s.label, state: s.state, unmet: s.unmet })),
    table: o.table,
    passA: o.pass_a,
    fetchedAt: now,
  }
}

// ---------------------------------------------------------------- the band

const ago = (iso: string | null | undefined, now: number): string => {
  const t = iso ? Date.parse(iso) : NaN
  if (Number.isNaN(t)) return 'unknown age'
  const m = Math.max(0, Math.round((now - t) / 60_000))
  if (m < 90) return `${m}m ago`
  const h = Math.round(m / 60)
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`
}

export function bandText(view: RunView, now: number): string {
  const open = view.sections.filter(s => s.state !== 'DONE')
  if (open.length === 0) return `run ${view.runId.slice(0, 8)} ${view.slug} · all sections DONE`
  const stageOf = new Map(view.table.map(t => [t.id, t.stage]))
  const stage = Math.min(...open.map(s => stageOf.get(s.id) ?? Infinity))
  const ready = open.filter(s => s.state === 'READY').map(s => s.id)
  const stan = open.filter(s => s.state === 'WAITING_STAN').map(s => s.id)
  const next = ready[0] ?? (stan.length ? `${stan[0]} (waiting on a human)` : 'none (nothing READY)')
  const pass = view.passA ? `${view.passA.verdict ?? '?'} ${ago(view.passA.at, now)}` : 'none'
  const missing = open.slice(0, 4).map(s => s.id).join(', ')
  const more = open.length > 4 ? ` +${open.length - 4}` : ''
  return (
    `run ${view.runId.slice(0, 8)} ${view.slug} · stage ${Number.isFinite(stage) ? stage : '?'}` +
    ` · next READY: ${next} · Pass A: ${pass} · missing ${open.length}: ${missing}${more}`
  )
}

// ---------------------------------------------------------------- write detection

export type WriteTarget = {
  // human description for the reason text
  what: string
  ids: string[]
  pairs: { stage: number; part: string | null }[]
  passes: ('a' | 'b')[]
  // The run the write itself names (--run-id / --slug, or id / article_slug in the SQL), lowercased.
  // Absent = the write names none, so the pinned / only active run is the one to judge against.
  run?: string
}

const KNOWN_WRITERS = ['write_stage_receipt.py', 'article_audit.py']

// PLAIN-COMMAND-BEGIN (keep identical in run-state/hooks/logic.ts and refresh-run-guard/hooks/plain.ts; ci_gates.py parity enforces it)
// ---------------------------------------------------------------- what counts as "plain"
//
// Things are exempt from the receipt guard (LC-1711): a --help / --dry-run / --selftest run of the
// writer, an echo/printf/cat/tee that only prints or writes text, and the body of a quoted-terminator
// heredoc that cat/tee writes to a file (receipt code and its tests name the scripts constantly).
// Each exemption is a claim about what the shell will NOT run, and every shell parser that tries to
// prove that grows holes (escapes, comments, expansions, quoting forms). So there is no parser to
// get wrong: an exemption applies ONLY when the whole command is plain AND the segment's first word
// is on a short allow-list (the writer itself, or echo / printf / cat / tee). Anything else is judged
// exactly as if no exemption existed. Plain is FAIL CLOSED on every character the code does not model.
//
// The text outside a cat/tee quoted-terminator heredoc body (the body is raw data, `'EOF'` stops the
// shell expanding it) is NOT plain if it contains any of:
//   `#` (comment)  `\` (escape)  `${`  `$'`  `$"`  a backtick  `$(`  `>(`  `<(`
//   a single `|`   a single `&`   an unclosed quote   a heredoc that was not dropped
//   eval / source / alias / unalias / function / a leading `.` / `name()` / a `PATH=` assignment
//   bash sh zsh python python3 node with -c, `-` or any `<` after it (code read from stdin)
// A command with a comment or a backslash simply gets no exemption: a few false positives are fine.
// What is left is a command with no escapes, comments or expansions, where quotes just pair up, so
// the one pass below (quotes only) is exact for it.

type ShellScan = { closed: boolean; heredocs: number; drops: { from: number; to: number }[] }

const HEREDOC_OP = /^(-?)\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2/

// One pass over the command with the quote state carried across lines. Heredoc bodies are raw text,
// so they are skipped (never scanned for quotes). Only an operator outside quotes counts as a
// heredoc. Anything that would make this pass inexact (an escape, a comment) also makes the command
// not plain, so a wrong drop can never survive into a plain verdict.
function scanShell(command: string): ShellScan {
  const lines = command.split('\n')
  const scan: ShellScan = { closed: true, heredocs: 0, drops: [] }
  let q = ''
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    let pending: { term: string; dash: boolean; quoted: boolean; consumer: string } | null = null
    for (let j = 0; j < line.length; j++) {
      const c = line[j]
      if (q) { if (c === q) q = ''; continue }
      if (c === "'" || c === '"') { q = c; continue }
      if (c === '<' && line[j + 1] === '<') {
        if (line[j + 2] === '<') { j += 2; continue } // a here-string, not a heredoc
        const m = HEREDOC_OP.exec(line.slice(j + 2))
        if (m && !pending) {
          const before = line.slice(0, j).split(/&&|\|\||;|\|/).pop() ?? ''
          const word = (before.trim().split(/\s+/)[0] ?? '').split('/').pop() ?? ''
          pending = { term: m[3], dash: m[1] === '-', quoted: m[2] !== '', consumer: word }
          scan.heredocs += 1
        }
        j += 1
      }
    }
    if (pending) {
      const p = pending
      const end = lines.findIndex((l, k) => k > i && (p.dash ? l.replace(/^\t+/, '') : l).trimEnd() === p.term)
      if (end < 0) continue // unterminated: nothing is skipped or dropped, the rest is scanned as commands
      if (p.quoted && (p.consumer === 'cat' || p.consumer === 'tee')) scan.drops.push({ from: i + 1, to: end })
      i = end // the body is raw text for the scan whether or not it is dropped
    }
  }
  scan.closed = q === ''
  return scan
}

// The command with every cat/tee quoted-terminator heredoc body removed.
function dropHeredocBodies(command: string, scan: ShellScan): string {
  if (scan.drops.length === 0) return command
  const skip = new Set<number>()
  for (const d of scan.drops) for (let k = d.from; k <= d.to; k++) skip.add(k)
  return command.split('\n').filter((_, k) => !skip.has(k)).join('\n')
}

function looksPlain(text: string, scan: ShellScan): boolean {
  if (!scan.closed) return false
  if (scan.heredocs !== scan.drops.length) return false // a heredoc whose body is still in the command
  if (/[#\\`]|\$[{('"]|[<>]\(/.test(text)) return false // comment, escape, backtick, ${ $( $' $", >( <(
  if (/(^|[^|])\|([^|]|$)/.test(text)) return false // a single | (|| is fine)
  if (/(^|[^&>])&([^&>]|$)/.test(text.replace(/[0-9]?>&[0-9]/g, ''))) return false // a single & (not && or fd dup)
  if (/\b(eval|source|alias|unalias|function)\b/.test(text)) return false
  if (/(^|[;&|\n(])\s*\.\s/.test(text)) return false
  if (/[\w.-]+\s*\(\s*\)/.test(text)) return false // name() { ... }
  if (/\bPATH=/.test(text)) return false
  // An interpreter word (also as /bin/bash), not a file name that merely ends in .sh.
  if (/(^|[\s;&|(/])(bash|sh|zsh|python3?|node)(?=\s|$)[^;&|\n]*(\s-\w*c\b|\s-(\s|$)|<)/.test(text)) return false
  return true
}

// The command text to scan, and whether exemptions may apply to it.
export function plainView(command: string): { text: string; plain: boolean } {
  const scan = scanShell(command)
  const dropped = dropHeredocBodies(command, scan)
  return { text: dropped, plain: looksPlain(dropped, scan) }
}
// PLAIN-COMMAND-END

// `;`, `&`, `|` and newline inside quotes are text, not separators: mask them so a quoted payload
// is not cut into fake commands. Only called on a plain command: every quote is closed and there is
// no backslash, comment or expansion, so quotes simply pair up.
function maskQuotedSeparators(command: string): string {
  let q = ''
  let out = ''
  for (let i = 0; i < command.length; i++) {
    const c = command[i]
    if (q === "'") { if (c === "'") q = ''; out += /[;&|\n]/.test(c) ? '\u0001' : c; continue }
    if (q === '"') {
      if (c === '"') q = ''
      out += /[;&|\n]/.test(c) ? '\u0001' : c
      continue
    }
    if (c === "'" || c === '"') q = c
    out += c
  }
  return out
}

const SPLIT = /&&|\|\||;|\n/

// The writer itself: [VAR=x ...] [python3 [-flags]] path/to/<writer>.py
const WRITER_FIRST = /^(?:\w+=\S+\s+)*(?:python3?\s+(?:-[A-Za-z]+\s+)*)?\S*(?:write_stage_receipt|article_audit)\.py(?=\s|$)/

// Quoted text and redirect operators with their targets are not flags: `W 2> --dry-run` and
// `W > --help` write to a file called that, they do not ask for a dry run.
const flagText = (seg: string): string =>
  seg
    .replace(/"[^"]*"|'[^']*'/g, '""')
    .replace(/(?:\d*|&)>{1,2}\s*&?\S+|\d*<\s*&?\S+/g, ' ')

// `--help` / `-h`: usage only, nothing is written.
const hasHelpFlag = (seg: string): boolean => /(^|\s)(--help|-h)(\s|$)/.test(flagText(seg))
// Whole flags only: `--dry-runner` or `--dry-run-log` is not a dry run, so it is still judged.
const hasDryRunFlag = (seg: string): boolean => /(^|\s)--(dry-run|selftest)(\s|$)/.test(flagText(seg))

// ---- the exemption is all-or-nothing (LC-1736). A heredoc body or an echo payload written to a FILE is data
// only if nothing later runs that file, and "nothing later runs it" cannot be proved by naming the ways to
// run a file (`sh f`, `./f`, `timeout 5 sh f`, `( sh f )`, `if true; then sh f; fi`, `x="sh f"; $x`, `python3 p.py`
// ...). So: the command is exempt only when it is plain AND EVERY step is one of a short allow-list. Any other
// step and the whole command is judged, exactly as if no exemption existed (bodies and payloads included).
//   - print only: echo / printf / cat that writes nothing (no `>`)
//   - a file write: a plain cat / tee heredoc, echo / printf / cat redirected to a file, when no TARGET is risky
//   - the writer's own --help / --dry-run / --selftest run
//   - steps that cannot run a file that was just written (LC-1739, cut to the minimum after review): git add|status|diff,
//     ls, grep, wc, claude plugin test|validate (prefix forms, rest must be inert), and two EXACT forms below:
//     `git commit -m` with a single-quoted or one-word message, `mkdir -p` with a plain path.
//     NOT git log, git push, gh, bun/npm test, make, head, tail, sed, test, chmod, mv: they ask, as on main.
const BENIGN_STEP = [
  /^git\s+(?:add|status|diff)(?:\s|$)/,
  /^(?:ls|grep|wc)(?:\s|$)/,
  /^claude\s+plugin\s+(?:test|validate)(?:\s|$)/,
]
// Exact forms, whole step: no editor (a message is given), no flag that writes a file or sets a mode.
const COMMIT_MSG = String.raw`(?:'[^']*'|[A-Za-z0-9._:-]+)`
const GIT_COMMIT = new RegExp(String.raw`^git\s+commit(?:\s+-a)?\s+-m\s+${COMMIT_MSG}$|^git\s+commit\s+-am\s+${COMMIT_MSG}$`)
// A plain path has no shell character and no `.git` component.
const plainPath = (p: string): boolean => /^[A-Za-z0-9._/-]+$/.test(p) && !p.split('/').includes('.git')
const dirStep = (step: string): boolean => {
  // No `cd`: a write after it has an unknown real directory, so its target could not be checked (`cd ../.config/git`
  // then `cat > config` is the global git config). `mkdir -p` moves nothing, so later targets keep their real paths.
  const m = /^mkdir\s+-p\s+(\S+)$/.exec(step)
  return m !== null && plainPath(m[1])
}
// A write TARGET that could change what a later benign git command or test run executes: a `.git` path COMPONENT
// (a hook, `.git/config`, `info/attributes`), the global/XDG git config, a variable, or anything with a glob or a
// quote in it (`.g*t/config`, `".g"it/config` name a path the shell assembles later). `.gitignore`, `.gitkeep` and
// `.github/` are ordinary files and are not matched. Only targets are tested, never the text being written.
// `git commit` is allow-listed, so a file named like a git hook (core.hooksPath can point anywhere) or sitting in a
// hooks dir is risky, and a target with a group or redirect character (`>(sh)`) is a process substitution.
const RISKY_TARGET = /\$|[*?['"()<>]|\.config\/git|(?:^|\/)(?:applypatch-msg|pre-applypatch|post-applypatch|pre-commit|pre-merge-commit|prepare-commit-msg|commit-msg|post-commit|pre-rebase|post-checkout|post-merge|pre-push|pre-receive|update|proc-receive|post-receive|post-update|reference-transaction|push-to-checkout|pre-auto-gc|post-rewrite|sendemail-validate|fsmonitor-watchman|p4-[a-z-]+|post-index-change)$|(?:^|\/)hooks(?:\/|$)|(?:^|\/)\.git(?:\/|$|config$|attributes$|modules$)/
const PRINT_WORD = /^(?:echo|printf|cat|tee)(?=\s|$)/

// Where an echo / printf / cat / tee step writes: each redirect target, and tee's file arguments.
function writeTargets(step: string): string[] {
  // fd copies and heredoc ops are not targets; `>|` is the clobber form of `>`.
  const bare = step.replace(/[0-9]?>&[0-9]/g, '').replace(/<<-?\s*['"]?\w+['"]?/g, ' ').replace(/>\|/g, '>')
  const out: string[] = []
  for (const m of bare.matchAll(/>{1,2}\s*(\S+)/g)) out.push(m[1])
  if (/^tee\b/.test(bare)) {
    for (const t of bare.replace(/^tee\b/, '').replace(/>{1,2}\s*\S+/g, ' ').split(/\s+/)) {
      if (t && !t.startsWith('-')) out.push(t)
    }
  }
  return out
}

function stepIsExempt(step: string): boolean {
  if (PRINT_WORD.test(step)) {
    // Quoted text is the payload and is data, so it is blanked whole; what is left (the redirect operators and heredoc
    // markers aside) must be inert too, so this step does not lean on the outer plain test alone.
    if (/\$[({]|`/.test(step)) return false // a substitution is code even inside double quotes
    const s = step.replace(/[0-9]?>&[0-9]/g, '').replace(/<<-?\s*['"]?\w+['"]?/g, ' ').replace(/"[^"]*"|'[^']*'/g, '""').replace(/>>?\|?/g, ' ')
    return !/[$`|;&<>(){}\\]/.test(s) && writeTargets(step).every(t => !RISKY_TARGET.test(t))
  }
  if (WRITER_FIRST.test(step)) return hasDryRunFlag(step) || hasHelpFlag(step)
  // The allow-list entries match a command PREFIX, so the rest of the step must be inert too: after quoted text is
  // blanked it may hold no redirect, group, expansion or separator (`head a > .git/hooks/pre-commit` would write a
  // hook through an otherwise harmless `head`; `head $(sh f.sh)` would run it). `2>&1` is a descriptor copy.
  const rest = step.replace(/[0-9]?>&[0-9]/g, '').replace(/"[^"$`]*"|'[^']*'/g, '""')
  // The exact forms carry their own character class; a flag that writes a file or sets a mode is named in any form
  // (`git diff --output=f` writes f, `git add --chmod=+x f` sets the exec bit).
  if (/--output|--chmod/.test(step)) return false
  if (GIT_COMMIT.test(step) || dirStep(step)) return true
  // The prefix forms: the flags that write are named above, so `=` (`grep --include=f.sh`) is fine.
  if (/[$`|;&<>(){}\\]/.test(rest)) return false
  return BENIGN_STEP.some(re => re.test(step))
}

// The steps to judge: none when the whole command is exempt, else the command split plainly (no exemption at all).
function segments(command: string): string[] {
  const view = plainView(command)
  if (view.plain) {
    const steps = maskQuotedSeparators(view.text)
      .split(SPLIT)
      .map(s => s.trim())
      .filter(Boolean)
      .map(s => s.replace(/\u0001/g, ';'))
    if (steps.every(stepIsExempt)) return []
  }
  return command.split(SPLIT).map(s => s.trim()).filter(Boolean)
}

const runInBash = (seg: string): string | undefined => {
  const id = /--run-id[ =]+["']?([0-9a-f-]{36})\b/i.exec(seg)
  if (id) return id[1].toLowerCase()
  const slug = /--slug[ =]+["']?([a-z0-9][a-z0-9-]*)/i.exec(seg)
  return slug ? slug[1].toLowerCase() : undefined
}

export function receiptWritesInBash(command: string): WriteTarget[] {
  const out: WriteTarget[] = []
  for (const seg of segments(command)) {
    if (!KNOWN_WRITERS.some(w => seg.includes(w))) continue
    if (seg.includes('write_stage_receipt.py')) {
      const stage = /--stage[ =]+([0-9]+(?:\.[0-9]+)?)/.exec(seg)
      const part = /--part[ =]+["']?([A-Za-z0-9_]+)/.exec(seg)
      out.push({
        what: `write_stage_receipt stage ${stage?.[1] ?? '?'}${part ? ` part ${part[1]}` : ''}`,
        ids: [],
        pairs: stage ? [{ stage: Number(stage[1]), part: part ? part[1] : null }] : [],
        passes: [],
        run: runInBash(seg),
      })
    } else if (/--write-receipt/.test(seg)) {
      const p = /--pass[ =]+["']?(a|b|both)\b/i.exec(seg)
      const which = (p?.[1] ?? '').toLowerCase()
      out.push({
        what: `article-audit receipt (pass ${which || '?'})`,
        ids: [],
        pairs: [],
        passes: which === 'both' ? ['a', 'b'] : which === 'a' || which === 'b' ? [which] : [],
        run: runInBash(seg),
      })
    }
  }
  return out
}

export const SQL_TOOL = /(^|__)(execute_sql|apply_migration)$/
// Any statement that can change rows, not just the common four (COPY / MERGE / TRUNCATE also write).
const WRITE_VERB = /\b(insert\s+into|update|upsert|delete\s+from|copy|merge\s+into|truncate)\b/i

export function receiptWritesInSql(tool: string, query: string, knownIds: string[]): WriteTarget[] {
  if (!SQL_TOOL.test(tool)) return []
  const out: WriteTarget[] = []
  for (const seg of query.split(';')) {
    if (!WRITE_VERB.test(seg)) continue
    const touchesSections = /\brefresh_run_sections\b/i.test(seg)
    const touchesReceipts =
      /\brefresh_runs\b/i.test(seg) && /\b(stages|selection_provenance)\b/i.test(seg)
    if (!touchesSections && !touchesReceipts) continue
    const ids = knownIds.filter(id => new RegExp(`(^|[^A-Za-z0-9_])${id}([^A-Za-z0-9_]|$)`).test(seg))
    const pairs: WriteTarget['pairs'] = []
    for (const obj of seg.match(/\{[^{}]*\}/g) ?? []) {
      const st = /"stage"\s*:\s*"?([0-9]+(?:\.[0-9]+)?)/.exec(obj)
      if (!st) continue
      const pt = /"part"\s*:\s*"([^"]+)"/.exec(obj)
      pairs.push({ stage: Number(st[1]), part: pt ? pt[1] : null })
    }
    const passes: ('a' | 'b')[] = []
    if (/pass_a/i.test(seg)) passes.push('a')
    if (/pass_b/i.test(seg)) passes.push('b')
    const rid = /\b(?:id|run_id)\s*=\s*'([0-9a-f-]{36})'/i.exec(seg)
    const rslug = /\barticle_slug\s*=\s*'([a-z0-9][a-z0-9-]*)'/i.exec(seg)
    const run = rid ? rid[1].toLowerCase() : rslug ? rslug[1].toLowerCase() : undefined
    out.push({ what: 'SQL write to refresh run state', ids, pairs, passes, run })
  }
  return out
}

// ---------------------------------------------------------------- the decision

export type Decision = { action: 'allow' | 'ask' | 'deny'; reason: string }

const near = (a: number, b: number): boolean => Math.abs(a - b) < 1e-9

function sectionIdsFor(view: RunView, t: WriteTarget): string[] {
  const ids = new Set(t.ids)
  for (const { stage, part } of t.pairs) {
    const sameStage = view.table.filter(r => near(r.stage, stage))
    // A whole-stage receipt belongs to the stage's own (part-less) section when
    // there is one; otherwise it stands in for every part (conductor RECEIPT CONTRACT).
    const hit = part === null
      ? (sameStage.some(r => r.part === null) ? sameStage.filter(r => r.part === null) : sameStage)
      : sameStage.filter(r => r.part === part)
    for (const r of hit) ids.add(r.id)
  }
  for (const p of t.passes) {
    const v2 = view.table.some(r => r.id === 'v2_s9c6')
    ids.add(p === 'a' ? (v2 ? 'v2_s9c6' : 's7_5c6') : v2 ? 'v2_s11c5' : 's9c5')
  }
  return [...ids]
}

export function decide(view: RunView, t: WriteTarget): Decision {
  const ids = sectionIdsFor(view, t)
  if (ids.length === 0) {
    return { action: 'ask', reason: `run-state: ${t.what} does not map to any section of run ${view.slug}; confirm it.` }
  }
  const byId = new Map(view.sections.map(s => [s.id, s]))
  const verdicts = ids.map(id => ({ id, s: byId.get(id) }))
  const unknown = verdicts.find(v => !v.s)
  if (unknown) {
    return { action: 'ask', reason: `run-state: ${unknown.id} is not in the conductor's plan for ${view.slug}; confirm it.` }
  }
  // Worst section wins: one BLOCKED id in an aggregate write is enough to refuse it. Only BLOCKED
  // (unmet dependencies) denies. A human barrier (WAITING_STAN) asks, because recording its receipt
  // after the person has answered is exactly the legitimate write.
  const blocked = verdicts.find(v => v.s!.state === 'BLOCKED')
  if (blocked) {
    return { action: 'deny', reason: `run-state: ${t.what} refused: ${blocked.id} is not READY; it is BLOCKED by ${blocked.s!.unmet.join(', ') || 'unmet blockers'}. Run the conductor again and take a READY section.` }
  }
  const barrier = verdicts.find(v => v.s!.state === 'WAITING_STAN')
  if (barrier) {
    return { action: 'ask', reason: `run-state: ${barrier.id} is a human barrier (waiting on Stan or the content manager) on ${view.slug}; confirm the person has answered.` }
  }
  const redo = verdicts.find(v => v.s!.state === 'DONE' || v.s!.state === 'IN_PROGRESS')
  if (redo) {
    return { action: 'ask', reason: `run-state: ${redo.id} is already ${redo.s!.state} on ${view.slug}; this write supersedes its receipt. Confirm.` }
  }
  // Allow-list, not fall-through: only READY, or FAILED (the conductor lists a failed gate
  // under LAUNCH NOW as a re-run). Any other state (a future or malformed one) asks.
  const odd = verdicts.find(v => v.s!.state !== 'READY' && v.s!.state !== 'FAILED')
  if (odd) {
    return { action: 'ask', reason: `run-state: ${odd.id} has unrecognised state "${odd.s!.state}" on ${view.slug}; confirm.` }
  }
  return { action: 'allow', reason: `run-state: ${ids.join(', ')} ${verdicts.map(v => v.s!.state).join('/')} on ${view.slug}` }
}

const rank = { allow: 0, ask: 1, deny: 2 } as const
export const worst = (ds: Decision[]): Decision => ds.reduce((a, b) => (rank[b.action] > rank[a.action] ? b : a))

// Cheap pre-check so ordinary SQL (the common case) never triggers a plan fetch.
export const mayWriteRunState = (tool: string, query: string): boolean =>
  receiptWritesInSql(tool, query, []).length > 0

// The write names a run: is it the one the view is of? (a run id or an article slug)
export const sameRun = (view: RunView, run: string): boolean =>
  run === view.runId.toLowerCase() || run === view.slug.toLowerCase()
