import type { Register } from 'claude-code'

// Why this exists (LC-1731, rulings in memories 2ef2354a / 1c7e219e, LC-1726): Stan, 2026-10-08,
// "memories are suggestions sessions ignore". The pillar-brief rules are enforced here, at the
// moment they matter, in ANY session (not only refresh runs):
//   1. a new article idea (Jira LCC, label article-idea) names a parent article that EXISTS, so its
//      brief can inherit from it;
//   2. product selection and article writing happen only against an APPROVED pillar brief
//      (public.pillar_briefs, status='approved', approved_at within 365 days);
//   3. every approval names a configured human approver (userConfig `approvers`, default Stan).
// Business analogy: the foreman who will not let the crew order materials until the blueprint
// is signed, and who wants to see whose signature it is.
//
// Fail closed, never silently allow. A lookup that cannot run (no Supabase MCP, SQL error) DENIES with the fix:
// an unattended session cannot answer a question, and a stall is worse than a clear refusal. The only ASK left
// is an expired brief (> 365 days) after a successful lookup.
// Triggers are RECOGNISED actions only (tool + argv shapes), never names appearing in text or heredoc bodies.
// Cost: $0 (one read-only SQL per gated call, no paid API).
//
// Not covered (README lists the same): Jira edits that ADD the label later, Webflow MCP
// writes, other selection writers (write_stage_receipt.py), shell writes built from variables.

const NAME = 'pillar-brief-guard'
const YEAR_MS = 365 * 86_400_000
const ALLOW = 'Allow this call'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SLUG = /^[a-z0-9][a-z0-9-]{0,119}$/
const CREATE_ISSUE = /__createJiraIssue$/
const DISPATCH = /__actions_run_trigger$/
const GH_FILE = /__(create_or_update_file|push_files)$/
const ARTICLE_FILE_SKIP = /^(readme|claude|agents|changelog|license|contributing)\.md$/i
// An unattended session cannot answer a question, and a stall is worse than a clear refusal
// (orchestrator ruling, 2026-10-08, after run-state asked in a session with no Supabase MCP).
// Do NOT promise a server-side fallback here: with no approved brief product_shortlist.py falls
// back to search demand, so nothing but this guard stops the selection.
const FIX_LOOKUP = 'Fix: connect the Supabase MCP so the approved pillar brief can be checked; nothing selects products without it.'
const AFTER_FAIL = 'the guard failed after the call ran; treat its result as unchecked.'

type Opts = { supabaseServer?: string; projectId?: string; approvers?: string | string[] }
type Verdict = { deny?: string; ask?: string }
type Target =
  | { kind: 'run'; id: string }
  | { kind: 'slug'; slug: string }
  | { kind: 'articleId'; id: string }
  | { kind: 'unknown'; why: string }

const STEP_TO_RUN = (slug: string): string =>
  `Step to run: draft the brief (brief_stage.py draft --article-slug ${slug} [--parent-slug <parent>], LC-1728; ` +
  `until it lands, pillar_brief.py draft --file <brief.json> --apply), get Stan's approval ` +
  `(pillar_brief.py approve --brief-id <id> --by Stan), then retry.`

// Callout convention (claude-mods/README.md): prefix for the model, toast for Stan.
function say($: any, text: string): string {
  const msg = `[mod:${NAME}] ${text}`
  $.ui.toast(msg)
  return msg
}

function arg(e: any, key: string): unknown {
  return e?.[key] ?? e?.input?.[key]
}

function asObject(v: unknown): Record<string, unknown> {
  if (typeof v === 'string') { try { return asObject(JSON.parse(v)) } catch { return {} } }
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
}

// ---------------------------------------------------------------- approvers

function approversOf(o: Opts): string[] {
  const raw = Array.isArray(o.approvers) ? o.approvers : typeof o.approvers === 'string' ? o.approvers.split(',') : ['Stan']
  const list = raw.map(a => String(a).trim()).filter(Boolean)
  return list.length ? list : ['Stan']
}

// "Stan approves every brief": the approver must be one of the configured humans, so `claude` or `x` fail.
function approverOk(o: Opts, v: unknown): boolean {
  return typeof v === 'string' && approversOf(o).some(a => a.toLowerCase() === v.trim().toLowerCase())
}

const approverDeny = (o: Opts, where: string): string =>
  `${where} needs a named human approver (${approversOf(o).join(' or ')}): an approval must say who gave it, and Stan approves every brief.`

// ---------------------------------------------------------------- text helpers

// A Jira description may be Markdown or an ADF document; return the plain text lines.
function plainText(v: unknown): string {
  if (typeof v === 'string') return v
  const out: string[] = []
  const walk = (n: unknown): void => {
    if (Array.isArray(n)) n.forEach(walk)
    else if (n && typeof n === 'object') {
      const o = n as Record<string, unknown>
      if (typeof o.text === 'string') out.push(o.text)
      if (o.type === 'paragraph' || o.type === 'hardBreak') out.push('\n')
      walk(o.content)
    }
  }
  walk(v)
  return out.join('')
}

// `Parent article: <slug>` on a line of its own, tolerating Markdown emphasis/backticks/bullets.
const PARENT = /^[\s>*_`+-]*parent article[\s*_`]*:[\s*_`]*([a-z0-9][a-z0-9-]*)(?=[\s*_`.,;)]|$)/im
const PLACEHOLDER = /^(none|n-a|na|tbd|todo|unknown|null|nil|slug|parent|xxx+)$/

function parentSlug(description: unknown): string | undefined {
  const m = PARENT.exec(plainText(description))
  const slug = m?.[1]?.toLowerCase()
  return slug && !PLACEHOLDER.test(slug) && SLUG.test(slug) ? slug : undefined
}

// Minimal base64 -> text (the GitHub contents API takes base64; atob is not guaranteed here).
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
function fromBase64(s: string): string {
  let out = ''
  let acc = 0
  let bits = 0
  for (const ch of s.replace(/[^A-Za-z0-9+/]/g, '')) {
    acc = (acc << 6) | B64.indexOf(ch)
    bits += 6
    if (bits >= 8) { bits -= 8; out += String.fromCharCode((acc >> bits) & 255); acc &= (1 << bits) - 1 }
  }
  return out
}

// Frontmatter = the block between the opening --- and the FIRST closing ---; a `slug:` line in the
// body (after the fence) must not name the article. Only a file whose frontmatter carries BOTH
// slug: and title: is an article (a README, a notes file or a template is not).
function articleSlug(content: string): string | undefined {
  content = content.replace(/^\uFEFF/, '') // a byte-order mark must not hide the frontmatter
  const block = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(content)?.[1] ?? ''
  const slug = /^slug:[ \t]*["']?([a-z0-9][a-z0-9-]*)/im.exec(block)?.[1]
  return slug && /^title:[ \t]*\S/im.test(block) ? slug.toLowerCase() : undefined
}

function articlePath(path: string, repo: string): boolean {
  const parts = path.split('/')
  const base = parts[parts.length - 1] ?? ''
  return (
    /\.md$/i.test(base) && !ARTICLE_FILE_SKIP.test(base) && parts.includes('articles') &&
    (parts.includes('bbm-content') || repo === 'bbm-content') &&
    !parts.some(p => p === '.github' || p === 'node_modules' || p === 'docs')
  )
}

// Splits a shell command into segments of tokens (quotes respected; ; & | newline end a
// segment; heredoc bodies are text and skipped). A token that itself holds whitespace after
// `-c` / `eval` is re-tokenised one level.
function segments(cmd: string, depth = 0): string[][] {
  const segs: string[][] = []
  let cur: string[] = []
  let tok = ''
  let has = false
  let q = ''
  const push = (): void => { if (has) cur.push(tok); tok = ''; has = false }
  const end = (): void => { push(); if (cur.length) segs.push(normSeg(cur)); cur = [] }
  const here: string[] = [] // heredoc delimiters waiting for their body
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]
    // `# comment` (only at the start of a word, outside quotes): an apostrophe in it must not open a quote.
    if (!q && c === '#' && !has) { while (i + 1 < cmd.length && cmd[i + 1] !== '\n') i++; continue }
    // Arithmetic `$((1<<3))` / `((1<<3))` holds `<<` that is not a heredoc: skip it whole.
    if (!q && (cmd.startsWith('$((', i) || (!has && cur.length === 0 && cmd.startsWith('((', i)))) {
      let depth = 0
      let j = i + (cmd[i] === '$' ? 1 : 0)
      for (; j < cmd.length; j++) {
        if (cmd[j] === '(') depth++
        else if (cmd[j] === ')' && --depth === 0) break
      }
      tok += cmd.slice(i, j + 1)
      has = true
      i = j
      continue
    }
    if (!q && c === '<' && cmd[i + 1] === '<' && cmd[i + 2] !== '<' && cmd[i - 1] !== '<') {
      const m = /^<<-?\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z0-9_]+))/.exec(cmd.slice(i))
      if (m) { here.push(m[1] ?? m[2] ?? m[3]); i += m[0].length - 1; continue }
    }
    if (!q && c === '\n' && here.length) {
      end()
      // The body is text, not commands. If its terminator is never found we do NOT swallow the rest of the
      // command (that would hide a real command after a fake heredoc): it is parsed as commands instead.
      for (const word of here.splice(0)) {
        let j = i + 1
        let found = false
        while (j < cmd.length) {
          let nl = cmd.indexOf('\n', j)
          if (nl < 0) nl = cmd.length
          const line = cmd.slice(j, nl).trim()
          j = nl + 1
          if (line === word) { found = true; break }
        }
        if (found) i = j - 1
      }
      continue
    }
    if (q) {
      if (c === q) q = ''
      else if (c === '\\' && q === '"' && i + 1 < cmd.length) { tok += cmd[++i] }
      else tok += c
    } else if (c === '"' || c === "'") { q = c; has = true }
    else if (c === '\\' && i + 1 < cmd.length) { tok += cmd[++i]; has = true }
    else if (c === ';' || c === '&' || c === '|' || c === '\n') end()
    else if (c === ' ' || c === '\t') push()
    else { tok += c; has = true }
  }
  end()
  if (depth < 8) { // nested `bash -c "bash -c ..."`: bounded, deep enough for any real command
    for (const s of [...segs]) {
      s.forEach((t, i) => { if (/\s/.test(t) && (/^-[a-z]*c$/.test(s[i - 1] ?? '') || s[0] === 'eval')) segs.push(...segments(t, depth + 1)) })
    }
  }
  return segs
}

// Leading shell keywords and grouping (then/do/else/if/while, `(`, `{`, `!`) are not part of the command.
const SHELL_LEAD = /^(then|do|else|elif|if|while|until|!)$/
function normSeg(seg: string[]): string[] {
  const out = [...seg]
  for (;;) {
    if (out.length && (SHELL_LEAD.test(out[0]) || /^[({]+$/.test(out[0]))) { out.shift(); continue }
    if (out.length && /^[({]+./.test(out[0])) { out[0] = out[0].replace(/^[({]+/, ''); continue }
    // `( cmd --run-id X )` leaves the group's closing bracket glued to the last word.
    const last = out.length - 1
    if (last >= 0 && /^[^()]+\)+$/.test(out[last])) out[last] = out[last].replace(/\)+$/, '')
    return out
  }
}

// --flag value | --flag=value. present=false when the flag is absent; value '' when it has none.
// argparse accepts any unambiguous prefix of a long option (`--run` for `--run-id`), so a long flag
// also matches by prefix (2+ chars after `--`): a bypass by abbreviation would otherwise be silent.
const KNOWN_LONG = ['--run-id', '--article', '--article-id', '--article-slug', '--slug', '--plan', '--by', '--output', '--html', '--render']
function flag(seg: string[], names: string[]): { present: boolean; value: string } {
  for (let i = 0; i < seg.length; i++) {
    const t = seg[i]
    for (const n of names) {
      if (t === n) return { present: true, value: seg[i + 1] ?? '' }
      if (t.startsWith(n + '=')) return { present: true, value: t.slice(n.length + 1) }
      if (n.startsWith('--') && t.startsWith('--')) {
        const eq = t.indexOf('=')
        const name = eq < 0 ? t : t.slice(0, eq)
        if (name.length >= 4 && n.startsWith(name) && !KNOWN_LONG.includes(name)) return { present: true, value: eq < 0 ? seg[i + 1] ?? '' : t.slice(eq + 1) }
      }
    }
  }
  return { present: false, value: '' }
}

// Tokens in flag position: the value of a value-taking flag (`--output --selftest`) is not a flag.
function flagTokens(seg: string[], valueFlags: string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < seg.length; i++) {
    out.push(seg[i])
    // argparse takes the next word as the value of an abbreviated value flag too (`--out --selftest`).
    const t = seg[i]
    if (valueFlags.includes(t) || (t.startsWith('--') && !t.includes('=') && t.length >= 4 && valueFlags.some(f => f.startsWith(t)))) i++
  }
  return out
}

// The command must be EXECUTED: first word, or behind only an interpreter / env assignments / a
// launcher. `grep product_shortlist.py x`, `cat ...pillar_brief.py` and the like do not count.
// A script matches as a file (`x/product_shortlist.py`) or as a module (`python -m a.product_shortlist`).
const LAUNCHER = /^(python[\d.]*|-[A-Za-z]+|[A-Za-z_][A-Za-z0-9_]*=\S*|env|uv|run|poetry|sudo|time|nice|timeout|nohup|exec|command|\d+)$/
const PILLAR_BRIEF = /(^|[/.])pillar_brief(\.py)?$/
const SHORTLIST = /(^|[/.])product_shortlist(\.py)?$/
const ROSTER = /(^|[/.])roster_materialize(\.py)?$/
const script = (seg: string[], re: RegExp): number => {
  const i = seg.findIndex(t => re.test(t))
  return i >= 0 && seg.slice(0, i).every(t => LAUNCHER.test(t)) ? i : -1
}

// ---------------------------------------------------------------- brief lookup

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


function rowsFromMcp(content: readonly unknown[]): unknown[] {
  const joined = (content ?? [])
    .map(b => (b && typeof b === 'object' && 'text' in b ? String((b as { text: unknown }).text) : ''))
    .join('')
  // The Supabase MCP may return the whole reply as JSON, {"result":"...<untrusted-data>[{\"id\":...}]..."},
  // so the rows inside still carry escaped quotes. Unwrap that layer first; anything else stays as text.
  const text = unwrapResult(joined)
  const env = /<untrusted-data-[^>]*>([\s\S]*)<\/untrusted-data-[^>]*>/.exec(text)
  const body = env ? env[1] : text
  const open = body.indexOf('[')
  const close = body.lastIndexOf(']')
  if (open < 0 || close < open) throw new Error('execute_sql returned no row array')
  const rows = JSON.parse(body.slice(open, close + 1))
  if (!Array.isArray(rows)) throw new Error('execute_sql rows were not an array')
  return rows
}

async function sql($: any, o: Opts, query: string): Promise<any[]> {
  const res = await $.mcp.call(o.supabaseServer || 'Supabase', 'execute_sql', {
    project_id: o.projectId || 'tlcbwwgfqnasmiipgmmd',
    query,
  })
  if (res.isError) throw new Error('execute_sql returned an error')
  return rowsFromMcp(res.content)
}

// Every id/slug is shape-checked before it reaches SQL; anything else never gets here.
async function briefVerdict($: any, o: Opts, t: Target, what: string): Promise<Verdict> {
  try {
    if (t.kind === 'unknown') {
      return { deny: `cannot tell which article this ${what} is for (${t.why}), so its pillar brief cannot be checked and the call is refused. Name the article (--run-id, --article or a readable --plan).` }
    }
    let where: string
    let label: string
    if (t.kind === 'run') {
      const runs = await sql($, o, `select article_id, article_slug from public.refresh_runs where id = '${t.id}' limit 1`)
      if (runs.length !== 1 || !UUID.test(String(runs[0].article_id))) {
        return { deny: `cannot find refresh run ${t.id}, so its article's pillar brief cannot be checked and this ${what} is refused. Check the run id.` }
      }
      where = `article_id = '${runs[0].article_id}'`
      label = String(runs[0].article_slug ?? runs[0].article_id)
    } else if (t.kind === 'articleId') {
      where = `article_id = '${t.id}'`
      label = t.id
    } else {
      // Through public.articles, never pillar_briefs.article_slug (a drafting-time snapshot).
      where = `article_id = (select id from public.articles where slug = '${t.slug}')`
      label = t.slug
    }
    const rows = await sql(
      $, o,
      'select id, article_slug, version, approved_at, approved_by from public.pillar_briefs ' +
        `where ${where} and status = 'approved' order by version desc limit 1`,
    )
    if (rows.length === 0) {
      return { deny: `no approved pillar brief for "${label}". Article selection and writing happen only against an approved brief (public.pillar_briefs, status='approved'), so this ${what} is refused. ${STEP_TO_RUN(label)}` }
    }
    const b = rows[0]
    const at = Date.parse(String(b.approved_at))
    if (Number.isNaN(at)) return { deny: `the approved brief for "${label}" has no readable approved_at, so its age cannot be checked and this ${what} is refused. Re-approve it with pillar_brief.py approve --by Stan.` }
    if (!approverOk(o, b.approved_by)) return { deny: `the approved brief for "${label}" names no configured approver (${approversOf(o).join(' or ')}), and every approval must; this ${what} is refused. Re-approve it with pillar_brief.py approve --by Stan.` }
    const age = (await $.clock.now()) - at
    if (age > YEAR_MS) {
      const days = Math.floor(age / 86_400_000)
      return { ask: `the approved brief for "${label}" (v${b.version}, approved ${String(b.approved_at).slice(0, 10)}) is ${days} days old, past the 365-day yearly refresh. Draft a fresh brief first, or confirm this ${what} on the expired one.` }
    }
    return {}
  } catch (err) {
    return { deny: `the pillar-brief lookup could not run (${err instanceof Error ? err.message : String(err)}), so this ${what} is refused (fail closed). ${FIX_LOOKUP}` }
  }
}

// ask: the engine's question dialog; dismissed or nobody to ask (-p run) means refuse.
async function resolve($: any, v: Verdict): Promise<{ deny: string } | null> {
  if (v.deny) return { deny: say($, v.deny) }
  if (v.ask) {
    const asking = say($, v.ask)
    let choice = ''
    try {
      choice = await $.ui.ask(`${asking} Allow this call?`, [ALLOW, 'Refuse'])
    } catch {
      return { deny: `${asking} (no one answered; refused)` }
    }
    if (choice !== ALLOW) return { deny: `${asking} (refused)` }
  }
  return null
}

function targetFrom(runId: string, slug: string, articleId: string): Target {
  if (runId) return UUID.test(runId) ? { kind: 'run', id: runId.toLowerCase() } : { kind: 'unknown', why: `run id "${runId.slice(0, 40)}" is not a UUID` }
  if (articleId) return UUID.test(articleId) ? { kind: 'articleId', id: articleId.toLowerCase() } : { kind: 'unknown', why: 'article id is not a UUID' }
  if (slug) return SLUG.test(slug.toLowerCase()) ? { kind: 'slug', slug: slug.toLowerCase() } : { kind: 'unknown', why: `slug "${slug.slice(0, 40)}" is not a valid article slug` }
  return { kind: 'unknown', why: 'the call names no run, slug or article id' }
}

// roster_materialize.py apply names only a plan file; the article is inside it.
async function planTarget($: any, seg: string[]): Promise<Target> {
  const f = flag(seg, ['--plan']).value
  if (!f) return { kind: 'unknown', why: 'apply names no --plan file' }
  try {
    const plan = asObject(await $.fs.read(f))
    const a = String(plan.article_id ?? asObject(plan.article).id ?? '')
    if (UUID.test(a)) return { kind: 'articleId', id: a.toLowerCase() }
    const s = String(plan.article_slug ?? plan.slug ?? '').toLowerCase()
    if (SLUG.test(s)) return { kind: 'slug', slug: s }
    return { kind: 'unknown', why: `${f} carries no article id or slug` }
  } catch {
    return { kind: 'unknown', why: `the plan file ${f.slice(0, 80)} is unreadable` }
  }
}

// ---------------------------------------------------------------- workflow dispatch (MCP and gh CLI)

// Which guarded workflow a dispatch is. A numeric workflow id cannot be mapped to a file name here,
// so it counts as a match when its inputs carry step=shortlist / mode=approve.
function dispatchKind(wf: string, inputs: Record<string, unknown>): 'approve' | 'shortlist' | null {
  const name = (wf.split('/').pop() ?? '').toLowerCase()
  const numeric = /^\d+$/.test(name)
  const step = String(inputs.step ?? '').trim().toLowerCase()
  const mode = String(inputs.mode ?? '').trim().toLowerCase()
  if (mode === 'approve' && (numeric || /^run-pillar-brief\.ya?ml$/.test(name))) return 'approve'
  if (step === 'shortlist' && (numeric || /^run-heading-research\.ya?ml$/.test(name))) return 'shortlist'
  return null
}

async function dispatchVerdict($: any, o: Opts, kind: 'approve' | 'shortlist', inputs: Record<string, unknown>): Promise<Verdict> {
  if (kind === 'approve') {
    return approverOk(o, inputs.approved_by) ? {} : { deny: approverDeny(o, 'a run-pillar-brief.yml mode=approve dispatch (inputs.approved_by)') }
  }
  // apply is a boolean workflow input that defaults to false: unset, '' and false run the step's selftest
  // only (nothing is selected). true selects. Any other value is out of the enum: deny, never guess.
  const apply = typeof inputs.apply === 'boolean' ? String(inputs.apply) : String(inputs.apply ?? '').trim().toLowerCase()
  if (apply === '' || ['false', '0', 'no', 'off', 'n', 'f'].includes(apply)) return {}
  // Looks true to a human or to a shell-ish coercion (1/yes/on): judge it as a selection.
  if (!['true', '1', 'yes', 'on', 'y', 't'].includes(apply)) return { deny: `run-heading-research.yml inputs.apply must be true or false (got "${apply.slice(0, 20)}"), so the shortlist dispatch cannot be judged and is refused.` }
  return briefVerdict($, o, targetFrom(String(inputs.run_id ?? '').trim(), '', ''), 'shortlist dispatch')
}

// `gh workflow run <wf> [-R repo] [--ref r] -f k=v ...` -> { wf, inputs }; json=true when inputs come from stdin.
function ghDispatch(seg: string[]): { wf: string; inputs: Record<string, unknown>; json: boolean } | null {
  const gh = seg.findIndex(t => t === 'gh' || t.endsWith('/gh'))
  if (gh < 0 || !seg.slice(0, gh).every(t => LAUNCHER.test(t))) return null
  // gh global flags may precede the subcommand: `gh -R o/r workflow run ...`
  let k = gh + 1
  while (k < seg.length && seg[k].startsWith('-')) k += seg[k] === '-R' || seg[k] === '--repo' ? 2 : 1
  if (seg[k] !== 'workflow' || seg[k + 1] !== 'run') return null
  const inputs: Record<string, unknown> = {}
  let wf = ''
  let json = false
  const rest = seg.slice(k + 2)
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i]
    let kv: string | undefined
    if (t === '-f' || t === '-F' || t === '--field' || t === '--raw-field') kv = rest[++i] ?? ''
    else kv = /^--(?:field|raw-field)=(.*)$/.exec(t)?.[1] ?? /^-[fF](.+)$/.exec(t)?.[1]
    if (kv !== undefined) {
      const eq = kv.indexOf('=')
      if (eq > 0) inputs[kv.slice(0, eq)] = kv.slice(eq + 1)
    } else if (t === '--json') json = true
    else if (['-R', '--repo', '-r', '--ref'].includes(t)) i++
    else if (!t.startsWith('-') && !wf) wf = t
  }
  return wf ? { wf, inputs, json } : null
}

// ---------------------------------------------------------------- the hooks

export const register: Register = (on, options) => {
  const o = (options ?? {}) as Opts

  // Rule 1: article ideas name an EXISTING parent -------------------------------------------
  on('tool.call', { tool: CREATE_ISSUE }, async ($, e: any, next) => {
    const rawFields = arg(e, 'additional_fields')
    const fields = asObject(rawFields)
    // additional_fields that cannot be read hides both the labels and the project: fail closed.
    let unreadable = false
    if (rawFields !== undefined && rawFields !== null && rawFields !== '') {
      let parsed: unknown = rawFields
      if (typeof rawFields === 'string') { try { parsed = JSON.parse(rawFields) } catch { parsed = undefined } }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) unreadable = true
    }
    const projects = [arg(e, 'projectKey'), asObject(fields.project).key].map(k => String(k ?? '').toUpperCase())
    if (!projects.includes('LCC') && !(unreadable && !arg(e, 'projectKey'))) return next(e)
    // Labels in every shape the tool could take (array, comma/space string, {name} objects, top level or
    // additional_fields). A shape we cannot read is treated as an article idea: fail closed.
    const raw = [fields.labels, arg(e, 'labels')].filter(v => v !== undefined && v !== null)
    const labels: string[] = []
    for (const v of raw) {
      const items = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[\s,]+/) : (unreadable = true, [])
      for (const it of items) {
        const name = typeof it === 'string' ? it : typeof asObject(it).name === 'string' ? String(asObject(it).name) : (unreadable = true, '')
        if (name) labels.push(name.trim().toLowerCase())
      }
    }
    if (!unreadable && !labels.includes('article-idea')) return next(e)

    const parent = parentSlug(arg(e, 'description'))
    if (!parent) {
      return {
        deny: say(
          $,
          'an article-idea ticket must name its parent article so its pillar brief can inherit from it. ' +
            'Add a line `Parent article: <slug>` to the description (the slug of the existing article this idea grows from) and retry.',
        ),
      }
    }
    try {
      const found = await sql($, o, `select id from public.articles where slug = '${parent}' limit 1`)
      if (found.length === 0) {
        return { deny: say($, `parent article "${parent}" does not exist in public.articles, so a brief cannot inherit from it. Use the slug of an existing article.`) }
      }
    } catch (err) {
      return { deny: say($, `could not check that parent article "${parent}" exists (${err instanceof Error ? err.message : String(err)}), so this call is refused (fail closed). ${FIX_LOOKUP}`) }
    }
    const ran: any = await next(e)
    if (ran.deny !== undefined || ran.isError) return ran
    return {
      ...ran,
      context: [
        ...(ran.context ?? []),
        say(
          $,
          `article idea created under parent "${parent}". Next: draft the brief from the parent ` +
            `(brief_stage.py draft --article-slug <new> --parent-slug ${parent}, LC-1728), get Stan's approval, ` +
            `and only then write or pick products.`,
        ),
      ],
    }
  }).catch(($, e, next) =>
    next.called ? { deny: say($, AFTER_FAIL) } : { deny: say($, 'the article-idea check failed, so this call is refused rather than unchecked.') },
  )

  // Rules 2(a) and 3(b): workflow dispatch through the GitHub MCP --------------------------
  on('tool.call', { tool: DISPATCH }, async ($, e: any, next) => {
    if (String(arg(e, 'method')) !== 'run_workflow') return next(e)
    const rawInputs = arg(e, 'inputs')
    const inputs = asObject(rawInputs)
    // Inputs that are present but not an object (or not JSON) hide step/mode: for a guarded workflow
    // (or a numeric id we cannot map to a file) that is a deny, never "not a shortlist".
    const wfName = (String(arg(e, 'workflow_id') ?? '').split('/').pop() ?? '').toLowerCase()
    if (/^(\d+|run-pillar-brief\.ya?ml|run-heading-research\.ya?ml)$/.test(wfName) && rawInputs !== undefined && rawInputs !== null && rawInputs !== '') {
      let parsed: unknown = rawInputs
      if (typeof rawInputs === 'string') { try { parsed = JSON.parse(rawInputs) } catch { parsed = undefined } }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { deny: say($, `the inputs of this ${wfName} dispatch cannot be read (not an object), so step/mode/apply/approved_by cannot be judged and the call is refused. Pass inputs as a JSON object.`) }
      }
    }
    const kind = dispatchKind(String(arg(e, 'workflow_id') ?? ''), inputs)
    if (kind) {
      const stop = await resolve($, await dispatchVerdict($, o, kind, inputs))
      if (stop) return stop
    }
    return next(e)
  }).catch(($, e, next) =>
    next.called ? { deny: say($, AFTER_FAIL) } : { deny: say($, 'the workflow-dispatch check failed, so this call is refused rather than unchecked.') },
  )

  // Rules 2(b), 3(a) and 3(b): Bash ---------------------------------------------------------
  on('tool.call', { tool: 'Bash' }, async ($, e: any, next) => {
    const cmd = String(arg(e, 'command') ?? '')
    const segs = cmd ? segments(cmd) : []
    for (const seg of segs) {
      const pb = script(seg, PILLAR_BRIEF)
      if (pb >= 0 && seg[pb + 1] === 'approve' && !approverOk(o, flag(seg, ['--by']).value)) {
        return { deny: say($, approverDeny(o, 'pillar_brief.py approve --by')) }
      }
      const gh = ghDispatch(seg)
      if (gh) {
        const guarded = /^(run-pillar-brief|run-heading-research)\.ya?ml$/.test((gh.wf.split('/').pop() ?? '').toLowerCase()) || /^\d+$/.test(gh.wf)
        if (gh.json && guarded) {
          return { deny: say($, 'gh workflow run with --json hides its inputs from the pillar-brief guard; pass them as -f key=value (step, run_id, apply, mode, approved_by).') }
        }
        const kind = dispatchKind(gh.wf, gh.inputs)
        if (kind) {
          const stop = await resolve($, await dispatchVerdict($, o, kind, gh.inputs))
          if (stop) return stop
        }
      }
    }
    for (const seg of segs) {
      let target: Target | undefined
      let what = ''
      const sl = script(seg, SHORTLIST)
      const rm = script(seg, ROSTER)
      if (sl >= 0 && !flagTokens(seg.slice(sl + 1), ['--run-id', '--output', '--html', '--render']).some(t => ['--selftest', '--render', '--dry-run', '-h', '--help'].includes(t.split('=')[0]))) {
        // Only an invocation that SELECTS (it carries a target) is a selection; no target is not one.
        const run = flag(seg, ['--run-id'])
        const art = flag(seg, ['--article', '--article-slug', '--slug'])
        const aid = flag(seg, ['--article-id'])
        if (run.present || art.present || aid.present) {
          what = 'product_shortlist.py run'
          target = targetFrom(run.value, art.value, aid.value)
        }
      } else if (rm >= 0 && seg[rm + 1] === 'apply') {
        what = 'roster_materialize.py apply'
        target = await planTarget($, seg)
      }
      if (target) {
        const stop = await resolve($, await briefVerdict($, o, target, what))
        if (stop) return stop
      }
    }
    return next(e)
  }).catch(($, e, next) =>
    next.called ? { deny: say($, AFTER_FAIL) } : { deny: say($, 'the Bash check failed, so this call is refused rather than unchecked.') },
  )

  // Rule 2(c): writing a NEW article markdown (Write tool) ----------------------------------
  on('tool.call', { tool: /^(Write|Edit)$/ }, async ($, e: any, next) => {
    const path = String(arg(e, 'file_path') ?? '')
    if (!articlePath(path, '') || !path.split('/').includes('bbm-content')) return next(e)
    let exists = false
    try { exists = await $.fs.exists(path) } catch { exists = false } // unknown counts as new: fail closed
    if (exists) return next(e)
    const slug = articleSlug(String(arg(e, 'content') ?? ''))
    if (!slug) return next(e) // not an article (no slug: + title: frontmatter)
    const stop = await resolve($, await briefVerdict($, o, targetFrom('', slug, ''), 'new article file'))
    return stop ?? next(e)
  }).catch(($, e, next) =>
    next.called ? { deny: say($, AFTER_FAIL) } : { deny: say($, 'the article-file check failed, so this call is refused rather than unchecked.') },
  )

  // Rule 2(c) via the GitHub MCP: create_or_update_file (no sha = a new file) and push_files --------
  on('tool.call', { tool: GH_FILE }, async ($, e: any, next) => {
    const repo = String(arg(e, 'repo') ?? '')
    const files: { path: string; text: string }[] = []
    if (String(e.tool).endsWith('push_files')) {
      let list = arg(e, 'files')
      if (typeof list === 'string') { try { list = JSON.parse(list) } catch { list = undefined } }
      if (Array.isArray(list)) for (const f of list) files.push({ path: String(asObject(f).path ?? ''), text: String(asObject(f).content ?? '') })
    } else if (arg(e, 'sha') === undefined || arg(e, 'sha') === null || arg(e, 'sha') === '') {
      files.push({ path: String(arg(e, 'path') ?? ''), text: fromBase64(String(arg(e, 'content') ?? '')) })
    }
    const slugs = new Set<string>()
    for (const f of files) {
      if (!articlePath(f.path, repo)) continue
      const slug = articleSlug(f.text)
      if (slug) slugs.add(slug)
    }
    for (const slug of slugs) {
      const stop = await resolve($, await briefVerdict($, o, targetFrom('', slug, ''), 'new article file (GitHub MCP)'))
      if (stop) return stop
    }
    return next(e)
  }).catch(($, e, next) =>
    next.called ? { deny: say($, AFTER_FAIL) } : { deny: say($, 'the GitHub file check failed, so this call is refused rather than unchecked.') },
  )
}
