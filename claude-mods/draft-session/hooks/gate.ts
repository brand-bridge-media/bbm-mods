// Pure decision helpers for the draft-session mod. No engine calls here, so the
// rules that BLOCK a receipt can be read (and tested) without a session.

// Statuses write_stage_receipt.py treats as "this section is finished".
// Anything not in IN_PROGRESS_OR_FAILED counts as passing, so an unknown or
// missing status is gated too (fail closed).
const NOT_PASSING = new Set(['partial', 'pending', 'in_progress', 'todo', 'fail', 'failed', 'blocked'])

export type Run = { runId: string; articleId: string; slug: string; variant: string }

// The lint receipt does not say whether the V2 approved-method rules APPLIED (a v1/standard receipt is
// byte-identical by design), so the mod must know the run's template. Unknown = treated as v2: the strict side.
export const VARIANTS = ['v1', 'v2', 'standard']
export const methodRulesApply = (pinned: string, planVariant: string | undefined): boolean =>
  pinned === 'v2' || planVariant === 'v2' || !VARIANTS.includes(pinned)

const flag = (cmd: string, name: string): string | undefined => {
  const m = new RegExp(`--${name}(?:=|\\s+)(?:"([^"]*)"|'([^']*)'|(\\S+))`).exec(cmd)
  return m ? (m[1] ?? m[2] ?? m[3]) : undefined
}

export type ReceiptCall = { gated: boolean; pinViolation?: string }

// Is this Bash command a PASSING Draft (stage 6) receipt write for some run?
export function classifyReceiptCommand(cmd: string, run: Run): ReceiptCall {
  if (!/write_stage_receipt\.py/.test(cmd)) return { gated: false }
  if (/--selftest\b/.test(cmd) || /--dry-run\b/.test(cmd)) return { gated: false }
  const stage = flag(cmd, 'stage')
  const status = (flag(cmd, 'status') ?? '').toLowerCase()
  if (NOT_PASSING.has(status)) return { gated: false }
  // A readable stage other than 6 is somebody else's receipt; a missing or malformed stage cannot be
  // told apart from stage 6, so it is gated (fail closed).
  if (stage !== undefined && /^\d+(\.\d+)?$/.test(stage) && Number(stage) !== 6) return { gated: false }
  const rid = flag(cmd, 'run-id')
  const slug = flag(cmd, 'slug')
  if (rid !== undefined && rid !== run.runId)
    return { gated: true, pinViolation: `receipt targets run ${rid}, this session drafts run ${run.runId}` }
  if (slug !== undefined && (!run.slug || slug !== run.slug))
    return { gated: true, pinViolation: `receipt targets slug ${slug}; pin by --run-id ${run.runId}` }
  if (rid === undefined && slug === undefined)
    return { gated: true, pinViolation: `receipt names no run; use --run-id ${run.runId}` }
  return { gated: true }
}

const WRITE = /\b(update|insert\s+into|upsert|delete\s+from|merge\s+into)\b/i
// Tables that hold ONE article's draft; a write to them must name this article.
const ARTICLE_TABLES = /\b(roundup_slots|article_products|article_product_claims|article_selection_briefs)\b/i
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi

const PASSING = ['done', 'completed', 'pass', 'passed', 'verified', 'complete', 'completed_with_override', 'skipped']
const hasToken = (sql: string, words: readonly string[]) =>
  words.some(w => new RegExp(`(?<![a-z0-9_])${w}(?![a-z0-9_])`, 'i').test(sql))

// Default-deny, not shape-matching: statement spellings are endless (UPDATE ... SET, INSERT column lists
// and VALUES, JSON, upper case, unquoted), so this does not try to parse them. Any write to a run table
// that mentions `status` is gated UNLESS the only status words it carries are not-passing ones.
// Findings-only writes (no `status` at all) stay open: draft-lint reads those findings.
export function isDraftReceiptSql(sql: string): boolean {
  if (!WRITE.test(sql)) return false
  if (!/\brefresh_run_sections\b|\brefresh_runs\b/i.test(sql)) return false
  if (!/\bstatus\b/i.test(sql)) return false
  return hasToken(sql, PASSING) || !hasToken(sql, [...NOT_PASSING])
}

// Returns a violation message when the SQL writes article-scoped data outside the run's article
// or touches a different run's rows; undefined when it is fine.
export function sqlPinViolation(sql: string, run: Run): string | undefined {
  if (!WRITE.test(sql)) return undefined
  const ids = (sql.match(UUID) ?? []).map(s => s.toLowerCase())
  if (ARTICLE_TABLES.test(sql)) {
    // The pin must be BOUND to the write: an article_id predicate equal to the pinned id (or, for an
    // INSERT, the id inside the VALUES). A bare UUID in a comment or string must not count.
    const pin = run.articleId.toLowerCase()
    const bound = new RegExp(`article_id\\s*(?:=|in\\s*\\()\\s*'${pin}'`, 'i').test(sql)
    const inserted = /\binsert\s+into\b/i.test(sql) && new RegExp(`values\\s*\\([^)]*'${pin}'`, 'is').test(sql)
    if (!bound && !inserted) return `write to an article table without an article_id = '${run.articleId}' predicate`
  }
  if (/\brefresh_run_sections\b|\brefresh_runs\b/i.test(sql)) {
    // Same binding rule as the article pin: a run_id (or, for refresh_runs, id) predicate equal to the pin,
    // or the id inside an INSERT's VALUES. A UUID sitting in a comment or string proves nothing.
    const rp = run.runId.toLowerCase()
    const bound = new RegExp(`\\b(?:run_id|id)\\s*(?:=|in\\s*\\()\\s*'${rp}'`, 'i').test(sql)
    const inserted = /\binsert\s+into\b/i.test(sql) && new RegExp(`values\\s*\\([^)]*'${rp}'`, 'is').test(sql)
    if (!bound && !inserted) return `write to a run table without a run_id = '${run.runId}' predicate`
  }
  const foreign = ids.filter(i => i !== run.articleId.toLowerCase() && i !== run.runId.toLowerCase())
  if (ARTICLE_TABLES.test(sql) && foreign.length > 0 && /\barticle_id\b/i.test(sql)) {
    // Another uuid next to article_id = likely another article's slot; slot ids are legal, so only
    // flag when a different article_id comparison is spelled out.
    const other = /article_id\s*(?:=|in\s*\()\s*'?([0-9a-f-]{36})/gi
    let m: RegExpExecArray | null
    while ((m = other.exec(sql))) if (m[1].toLowerCase() !== run.articleId.toLowerCase())
      return `write names article_id ${m[1]}, not this run's ${run.articleId}`
  }
  return undefined
}

// Bash: the two draft writers + roster tools must be pointed at this article.
export function bashPinViolation(cmd: string, run: Run): string | undefined {
  if (!/(write_key_details|write_article_content|draft_lint)\.py/.test(cmd)) return undefined
  const aid = flag(cmd, 'article-id')
  const slug = flag(cmd, 'slug')
  // The real draft writers (write_article_content.py, write_key_details.py) take --run-id and resolve the
  // article from the run, so for them the run id IS the pin: it must be present and equal. A writer naming no
  // run, or a different one, is refused; --slug alone never counts as a pin.
  if (runsDraftWriter(cmd)) {
    const rid = flag(cmd, 'run-id')
    if (rid === undefined) return `draft writer names no run; pass --run-id ${run.runId}`
    if (rid !== run.runId) return `--run-id ${rid} is not this session's run ${run.runId}`
  }
  if (aid !== undefined && aid.toLowerCase() !== run.articleId.toLowerCase())
    return `--article-id ${aid} is not this run's article ${run.articleId}`
  if (slug !== undefined && run.slug && slug !== run.slug)
    return `--slug ${slug} is not this run's article ${run.slug}`
  return undefined
}

// Article files live under a content root (bbm-content/ or an articles/ directory) at any depth:
// bbm-content/best-sofas.md, content/articles/best-sofas/index.md, articles/a/b/best-sofas.mdx.
export const ARTICLE_FILE = /(^|\/)(bbm-content|articles?)\/(?:.+\/)?[^/]+\.(md|mdx|json)$/i
export const isArticlePath = (path: string): boolean => ARTICLE_FILE.test(path)

// File edits to an article file: the pin is the slug. No slug pinned = every article file is refused
// (nothing to match against must not read as "all allowed"); otherwise the filename stem or a whole
// path segment must equal the slug exactly, so "not-best-sofas.md" does not pass for "best-sofas".
export function filePinViolation(path: string, run: Run): string | undefined {
  if (!isArticlePath(path)) return undefined
  if (!run.slug) return `${path} is an article file but no slug is pinned; /draft-start <run_id> <article_id> <slug>`
  const parts = path.split('/')
  const stem = (parts[parts.length - 1] ?? '').replace(/\.[^.]+$/, '')
  const ok = stem === run.slug || parts.slice(0, -1).includes(run.slug)
  return ok ? undefined : `${path} is not this run's article (${run.slug})`
}

// Best effort, not a sandbox: a shell command that writes (cp/mv/install/rsync/tee/sed -i/redirect/heredoc)
// and NAMES an article file of another article. Anything built from variables or globs is not seen.
const FILE_TOKEN = /[^\s'"<>|;&=()]+\.(?:md|mdx|json)(?![\w.])/g
const COPY_LIKE = /\b(cp|mv|install|rsync|ln)\b/
export function bashFileWriteViolation(cmd: string, run: Run): string | undefined {
  if (!(looksLikeFileWrite(cmd) || COPY_LIKE.test(cmd))) return undefined
  for (const tok of cmd.match(FILE_TOKEN) ?? []) {
    const bad = filePinViolation(tok, run)
    if (bad) return bad
  }
  return undefined
}
export const bashTouchesArticleFile = (cmd: string): boolean => (cmd.match(FILE_TOKEN) ?? []).some(isArticlePath)

// A write that changes the draft: any write to an article table, or a draft writer CLI that is not a dry run.
export const writesArticleTable = (sql: string): boolean => WRITE.test(sql) && ARTICLE_TABLES.test(sql)
export const runsDraftWriter = (cmd: string): boolean =>
  /(write_key_details|write_article_content)\.py/.test(cmd) && !/--(dry-run|selftest)\b/.test(cmd)

// Bash that rewrites files in place or redirects output: a draft may have changed (heuristic, see README).
export const looksLikeFileWrite = (cmd: string): boolean => {
  const c = cmd.replace(/\d?>&\d|\d?>\s*\/dev\/null/g, '')
  return /\bsed\s+-[a-z]*i|\btee\b|>>?\s*[^\s&|]|python3?\s+-c\b|<<\s*['"]?\w+/.test(c)
}
