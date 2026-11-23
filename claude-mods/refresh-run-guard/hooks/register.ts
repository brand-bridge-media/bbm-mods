import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { CatalogCtx, CatalogSeen, PassAEntry } from '../types'
import { plainView } from './plain'

// refresh-run-guard (LC-1712, epic LC-1074).
// Why it exists: the refresh pipeline's proof (receipts, Pass A) can be
// defeated by a session that writes receipts by hand or publishes through a
// side door. The Python PreToolUse hooks in .claude/hooks stay as the floor;
// this mod adds the cases they cannot see (Bash, Supabase SQL) and a memory
// of Pass A freshness that a stateless hook does not have.
//
// Every gating hook ends in .catch that DENIES: a broken guard must block,
// never wave a call through. A guard that also false-denies gets switched off,
// so each rule below is as narrow as its evidence allows.

// Callout convention (LC-1711): every deny / ask / block / changed-something message starts with
// `[mod:refresh-run-guard]` (that text reaches the model in the tool result, so it can say who acted) and
// fires a toast naming the mod and the reason (so the operator sees it too). One helper keeps both together.
const MOD = 'refresh-run-guard'
function say($: any, reason: string): string {
  const text = `[mod:${MOD}] ${reason.replace(/^refresh-run-guard: /, '')}`
  try {
    $.ui.toast(text.length > 160 ? `${text.slice(0, 157)}...` : text)
  } catch { /* a toast must never be the reason a guard fails */ }
  return text
}

// Field slugs and collection ids below are copied from
// .claude/skills/article-technical-audit/SKILL.md (§1 Blog Posts, §3 Products) and
// .claude/skills/webflow-cms/SKILL.md (Architecture 2: the Blog Posts body is the rich-text fields
// `intro`, `post-content`, `post-content-two`; the audit register also lists `conclusion`); none are guessed.
// `post-body` is NOT a Blog Posts field (it is link-migration's configurable default) and is not used here.
const PRODUCTS_COLLECTION = '65fa33419d90d967c68a0963'
const BLOG_COLLECTION = '65fa33419d90d967c68a0964'
const BRANDS_COLLECTION = '65fa33419d90d967c68a0965'
const BODY_FIELDS = ['intro', 'post-content', 'post-content-two', 'conclusion']
const GO_LINK = /^https:\/\/go\.livingcozy\.com\/[A-Za-z0-9][A-Za-z0-9_\-/]*$/

const passA = atom({ plugin: 'refresh-run-guard', key: 'passA' } as const, {} as Record<string, PassAEntry>)
// Keyed `${itemId}:${field}`: one baseline per replaced body field.
const pills = atom({ plugin: 'refresh-run-guard', key: 'pills' } as const, {} as Record<string, number>)

// Any server's execute_sql, not just one named "Supabase": the connector id
// differs per environment and a name-keyed guard would silently never fire.
const SQL_TOOL = /^mcp__.*__(?:execute_sql|apply_migration)$/
// One anchored pattern on the Webflow MCP's own data_*_tool names; the connector id is a UUID here, so the
// connector name cannot be required. Other tools (SQL, ask_webflow_ai) stay on their own matchers.
const WEBFLOW_TOOL = /^mcp__.*__data_(?:cms|sites|pages)_tool$/

// ---------- rule 1: hand-written receipts -------------------------------

const RECEIPT_WHY =
  'Receipts are written by the pipeline tools, never by hand (run 96a5cfa9, 2026-09-20: hand-written receipts defeated the gate). ' +
  'Use `python3 webflow/bulk-operations/refresh-receipt-writer/write_stage_receipt.py` for stage receipts, ' +
  'or `python3 webflow/bulk-operations/article-audit/article_audit.py --slug <slug> --pass a --write-receipt` for the audit receipt. ' +
  'Reads (SELECT) stay allowed.'

// Linear comment stripper. A lazy `/\*[\s\S]*?\*/` regex rescans to the end of the input from every
// `/*` that never closes, which is quadratic on a hostile query; this walks the text once.
function stripBlockComments(text: string, filler: string): string {
  let out = ''
  let i = 0
  for (;;) {
    const open = text.indexOf('/*', i)
    if (open < 0) return out + text.slice(i)
    out += text.slice(i, open) + filler
    const close = text.indexOf('*/', open + 2)
    if (close < 0) return out // unterminated: the comment runs to the end
    i = close + 2
  }
}

const stripLiterals = (s: string): string => s.replace(/'(?:[^']|'')*'/g, "''")
const stripComments = (s: string, filler: string): string => stripBlockComments(s.replace(/--.*$/gm, filler), filler)

const MAX_CHECKED = 500_000

// The shapes that run text as SQL: a DO block, `execute '...'` / `execute format(...)` / `execute $$...`, and
// `call proc(...)`. A bare word in a string (`'execute me'`) is not one of them.
const DYNAMIC_SQL = /\bdo\s*(?:\$|language\b|')|\bexecute\s+(?:format\s*\(|quote_\w+\s*\(|'|\$)|\bcall\s+[\w."]+\s*\(/

// A write's TARGET is the relation right after the verb, not any table named somewhere in the text:
// `update other set x = (select ... from refresh_run_sections)` writes `other`, not a receipt table.
const TBL = String.raw`(?:"?[a-z_]+"?\s*\.\s*)?"?(?<t>refresh_run_sections|refresh_runs)"?\b`
const TARGETS: { verb: string; re: RegExp }[] = [
  { verb: 'update', re: new RegExp(String.raw`\bupdate\s+(?:only\s+)?${TBL}`) },
  { verb: 'delete', re: new RegExp(String.raw`\bdelete\s+from\s+(?:only\s+)?${TBL}`) },
  { verb: 'insert', re: new RegExp(String.raw`\binto\s+(?:table\s+)?${TBL}`) }, // insert into / select into
  { verb: 'merge', re: new RegExp(String.raw`\bmerge\s+into\s+${TBL}`) },
  { verb: 'truncate', re: new RegExp(String.raw`\btruncate\s+(?:table\s+)?(?:only\s+)?${TBL}`) },
  { verb: 'copy', re: new RegExp(String.raw`\bcopy\s+${TBL}`) },
  { verb: 'drop', re: new RegExp(String.raw`\b(?:drop|alter)\s+(?:table\s+)?(?:if\s+exists\s+)?${TBL}`) },
]
const WHOLE_ROW_VERBS = new Set(['delete', 'truncate', 'merge', 'copy', 'drop'])

// ---------- rule 1 exception: the Draft's own findings merge (LCH-745) ----
//
// Why: the Draft stage doc (bbm-refresh-agent `stages/v2_s6_draft.md`, Part 3 item 4) tells a cloud
// session, which has no service-role key, to merge `article_content` / `product_copy` / the title pair
// into its run's `v2_s6` findings through the Supabase connector. Rule 1 refused every such write, so
// every cloud Draft stalled (deep-sofas, run 5e706b07, 2026-11-19, went round it with a data-changes
// package). A findings MERGE of draft copy is not a receipt: it sets no status, and the lint (v2_s6_5)
// and the quality gate (v2_s7) read that copy afterwards. So exactly one shape is let through, judged on
// the WHOLE query text (anchored, so no second statement, comment or CTE can ride along):
//   update [public.]refresh_run_sections
//      set findings = findings || '<json object>'::jsonb      (or coalesce(findings, '{}'[::jsonb]) || ...)
//    where run_id = '<uuid>' and section_key = 'v2_s6' [and id = '<uuid>'] [and article_id = '<uuid>']
//   [returning <columns>] [;]
// and the JSON's top-level keys must all be draft-copy keys. Anything else falls through to rule 1.
export const DRAFT_FINDINGS_KEYS = ['article_content', 'product_copy', 'search_title', 'h1'] as const
export const DRAFT_FINDINGS_SHAPE =
  "A Draft's own findings merge is allowed in one shape: update refresh_run_sections set findings = findings || " +
  "'<json>'::jsonb where run_id = '<run id>' and section_key = 'v2_s6' (top-level keys only " +
  DRAFT_FINDINGS_KEYS.join(', ') +
  ').'
const UUID_LIT = String.raw`'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'`
const MERGE_SHAPE = new RegExp(
  String.raw`^\s*update\s+(?:public\.)?refresh_run_sections\s+set\s+findings\s*=\s*` +
    String.raw`(?:coalesce\(\s*findings\s*,\s*'\{\}'(?:\s*::\s*jsonb)?\s*\)|findings)\s*\|\|\s*` +
    String.raw`'(?<json>(?:[^']|'')*)'\s*::\s*jsonb\s+where\s+(?<where>[a-z_\s=0-9'-]+?)` +
    String.raw`(?:\s+returning\s+[a-z_\s,.*]+)?\s*;?\s*$`,
  'i',
)
const WHERE_TERMS: { key: string; re: RegExp }[] = [
  { key: 'run_id', re: new RegExp(String.raw`^run_id\s*=\s*${UUID_LIT}$`, 'i') },
  { key: 'section_key', re: /^section_key\s*=\s*'v2_s6'$/i },
  { key: 'id', re: new RegExp(String.raw`^id\s*=\s*${UUID_LIT}$`, 'i') },
  { key: 'article_id', re: new RegExp(String.raw`^article_id\s*=\s*${UUID_LIT}$`, 'i') },
]

export function isDraftFindingsMerge(query: unknown): boolean {
  if (typeof query !== 'string' || query.length > MAX_CHECKED) return false
  const m = MERGE_SHAPE.exec(query)
  if (!m?.groups) return false
  // The WHERE is a plain AND of known equality terms, each at most once; run_id and section_key required.
  const seen = new Set<string>()
  for (const raw of m.groups.where.trim().split(/\s+and\s+/i)) {
    const term = raw.trim()
    const hit = WHERE_TERMS.find(t => t.re.test(term))
    if (!hit || seen.has(hit.key)) return false
    seen.add(hit.key)
  }
  if (!seen.has('run_id') || !seen.has('section_key')) return false
  let merged: unknown
  try {
    merged = JSON.parse(m.groups.json.replace(/''/g, "'"))
  } catch {
    return false
  }
  if (merged === null || typeof merged !== 'object' || Array.isArray(merged)) return false
  const keys = Object.keys(merged as object)
  return keys.length > 0 && keys.every(k => (DRAFT_FINDINGS_KEYS as readonly string[]).includes(k))
}

export function sqlViolation(query: unknown): string | null {
  if (isDraftFindingsMerge(query)) return null
  if (typeof query !== 'string') return 'query was not a string, so it could not be checked'
  if (query.trim() === '') return 'query was empty, so there was nothing to check'
  if (query.length > MAX_CHECKED) return 'query was too large to check'
  const lower = query.toLowerCase()
  // String literals are removed before the scan (a quoted `update refresh_run_sections` is data). The
  // order of literal and comment stripping changes what a stray quote or `--` hides, so both orders are
  // judged, with comments read as whitespace and as nothing, and a deny on ANY view stands:
  // `select '--'; update ...` and `-- it's` + a later quote each hide a statement from one order only.
  const views = [
    stripLiterals(lower),
    stripComments(stripLiterals(lower), ' '),
    stripComments(stripLiterals(lower), ''),
    stripLiterals(stripComments(lower, ' ')),
    stripLiterals(stripComments(lower, '')),
  ]
  // Dynamic SQL runs text this scan cannot follow, and literal stripping hides the text it would run
  // (`execute 'update refresh_run_sections ...'`, `execute format(...)`). So, apart from the target scan:
  //  - EXECUTE or CALL as a statement is refused outright (a prepared or stored body is invisible here;
  //    nothing in the refresh pipeline needs either through these tools);
  //  - a DO block, or an EXECUTE/CALL anywhere, in text that names a receipt table at all, INCLUDING inside
  //    a string literal, is refused (judged on views that keep the literals).
  const keepLiterals = [lower, stripComments(lower, ' '), stripComments(lower, '')]
  for (const v of keepLiterals) {
    if (/\b(refresh_run_sections|refresh_runs)\b/.test(v) && DYNAMIC_SQL.test(v)) {
      return 'This SQL runs dynamic SQL (DO/EXECUTE/CALL) in text that names a receipt table.'
    }
  }
  for (const v of views) {
    for (const stmt of v.split(';')) {
      if (/^\s*(?:execute|call)\b/.test(stmt)) return 'This SQL is an EXECUTE/CALL statement, whose body this guard cannot read.'
      const names = /\b(refresh_run_sections|refresh_runs)\b/.test(stmt)
      if (!names) continue
      for (const { verb, re } of TARGETS) {
        const m = re.exec(stmt)
        if (!m) continue
        const table = m.groups?.t
        if (table === 'refresh_run_sections') return `This SQL writes refresh_run_sections. ${DRAFT_FINDINGS_SHAPE}`
        // refresh_runs: whole-row removal destroys receipts; UPDATE/INSERT are a violation only when they
        // set the receipt columns (a plain status UPDATE, or creating a run row, is the conductor's lifecycle).
        if (WHOLE_ROW_VERBS.has(verb)) return 'This SQL removes or recreates refresh_runs rows, which destroys their receipts.'
        if (/\b(stages|selection_provenance)\b/.test(stmt)) return 'This SQL writes refresh_runs.stages / selection_provenance.'
      }
    }
  }
  return null
}

// ---------- rule 2: Bash publish path -----------------------------------

// A publish attempt is something that can RUN a command (an executor) plus a Webflow publish call. Judging
// by "any token containing webflow and publish" false-denies editing, grepping and committing; judging
// quoted text as code false-denies `gh pr create --body "...publish_site..."`.
const PUBLISH_MARKER =
  /\b(?:publish_site|publish_collection_items|publish_collection|publish_items)\b|api\.webflow\.com[^\s'"]*\/publish\b|\/publish\b[^\n]*api\.webflow\.com/i
const WEBFLOW_PUBLISH_URL = /webflow[^\n]*\/publish\b/i
// Shells, runtimes and runners. `gh`, `git`, `echo` and friends are deliberately absent.
const EXECUTOR = /\b(?:curl|wget|httpie|python[0-9.]*|node|deno|bun|npx|npm|pnpm|yarn|make|just|perl|ruby|php|wrangler|bash|sh|zsh|dash|source|exec|eval|xargs)\b|(?<![\w:/.-])http(?=\s)/i
// A command whose first word is a variable or a path runs something we cannot name (`$CMD ...`, `./x.sh`).
const COMMAND_POSITION = /^\s*(?:\w+=\S+\s+)*(?:\$\{?\w+|\.{0,2}\/\S+|~\/\S+)/
// A script NAMED for a Webflow publish is judged by its name, since its body cannot be read from here.
// LCH-552: "publish" followed by ed/er/es/ing is a word ("webflow_last_published"), not a script name.
// Review by 2027-02-23: a column or sentence naming webflow and published must not read as a publish script.
const PUBLISH_SCRIPT_NAME = /webflow[\w.:\-]*(?<!un)publish(?!ed|er|es|ing)|(?<!un)publish(?!ed|er|es|ing)[\w.:\-]*webflow/i
// The ONE exemption: the repo's own hook file, by exact basename. A substring like `-gate` would let
// `do_webflow_publish-gate.sh` through.
const GATE_SCRIPT = /(?:^|\/)webflow-publish-gate\.py$/
const READ_ONLY_FIRST = /^\s*(?:grep|rg|cat|head|tail|ls|find|wc|diff|less|git|sed\s+-n)\b/

// Splits on ; & | newline that are OUTSIDE quotes, so a `;` or `|` inside a quoted argument stays put.
function splitOutsideQuotes(cmd: string): string[] {
  const out: string[] = []
  let cur = ''
  let q: string | null = null
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]
    if (q) {
      cur += c
      // Backslash escapes inside "..." and inside $'...' (ANSI-C quoting, where `\'` does not close it).
      if (c === '\\' && (q === '"' || q === "$'")) cur += cmd[++i] ?? ''
      else if (c === (q === "$'" ? "'" : q)) q = null
      continue
    }
    if (c === '$' && cmd[i + 1] === "'") { q = "$'"; cur += c + "'"; i++; continue }
    if (c === "'" || c === '"') { q = c; cur += c; continue }
    // A backslash outside quotes escapes the next character: `'don'\\''t'` and `don\\'t` do not open a quote.
    if (c === '\\') { cur += c + (cmd[++i] ?? ''); continue }
    if (c === ';' || c === '\n' || c === '|' || c === '&') { out.push(cur); cur = ''; continue }
    cur += c
  }
  out.push(cur)
  return out.filter(s => s.trim() !== '')
}

// The ONLY steps that may follow a dropped heredoc body (LC-1734). An allow-list, not a list of things to
// fear: the file a heredoc wrote can be run in more ways than any deny-list names (`timeout 5 sh f`,
// `if true; then sh f; fi`, `{ sh f; }`, `npm run p`, a git hook behind `git commit`, ...), so every
// step must be a plain cat/tee quoted-terminator heredoc write itself, or one of these read-only /
// test-runner commands. Anything else and the bodies stay judged (the old, stricter behaviour).
const BENIGN_STEP = [
  /^(?:cat|tee)\b[^|;&]*<<-?\s*['"]/,
  /^git\s+(?:add|status|diff)(?:\s|$)/,
  /^(?:ls|grep|wc)(?:\s|$)/,
  /^claude\s+plugin\s+(?:test|validate)(?:\s|$)/,
]
// A cat/tee heredoc write whose TARGET could change what a later benign git command runs (a hook, a config
// `fsmonitor` / `diff.external` / `filter` / `textconv`, `.gitattributes`): any path with a `.git...` component,
// or a variable in it (`$GIT_DIR/config`), keeps the body judged.
const RISKY_TARGET = /\$|(?:^|[\s/'"=])\.git/
const CAT_TEE_WRITE = BENIGN_STEP[0]
export const onlyBenignSteps = (text: string): boolean =>
  // `2>&1` is a descriptor copy, not a separator: take it out before splitting on `&`.
  splitOutsideQuotes(text.replace(/[0-9]?>&[0-9]/g, '')).every(seg => {
    const s = seg.trim()
    return CAT_TEE_WRITE.test(s) ? !RISKY_TARGET.test(s) : BENIGN_STEP.some(re => re.test(s))
  })

// Every heredoc body (any consumer, quoted or not) cut out. An EXTRA view only: a body can hold an apostrophe
// that pairs with a quote on a later line and hides a real call in the raw splitter (`cat > n.md <<'EOF'` /
// `it's here` / `EOF` then a curl with a quoted header). Not quote-aware on purpose: the raw view is judged too,
// so this can only add denials.
function withoutHeredocBodies(text: string): string {
  const lines = text.split('\n')
  const out: string[] = []
  for (let i = 0; i < lines.length; i++) {
    out.push(lines[i])
    const m = /<<-?\s*(['"]?)([A-Za-z_]\w*)\1/.exec(lines[i])
    if (!m || lines[i].includes('<<<')) continue
    const end = lines.findIndex((l, k) => k > i && l.replace(/^\t+/, '').trimEnd() === m[2])
    if (end >= 0) i = end
  }
  return out.join('\n')
}

// A comment cut off at its `#` (a `#` that starts a word). Used ONLY as a second view: the splitter reads an
// apostrophe in `# it's` as an opening quote that can swallow the next line, so a later publish call
// hides inside a "quoted" string. Judging this view as well can only add denials; the as-written view is
// still judged too, because cutting at `#` can itself hide code (`echo \`echo a # b\`; curl ...`).
const withoutComments = (text: string): string => text.replace(/(^|[\s;&|(])#[^\n]*/g, '$1')

const outsideQuotes = (s: string): string => s.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, '""')

export function bashPublishViolation(command: unknown): string | null {
  if (typeof command !== 'string') return 'command was not a string, so it could not be checked'
  if (command.trim() === '') return 'command was empty, so there was nothing to check'
  if (command.length > MAX_CHECKED) return 'command was too large to check'
  // A cat/tee heredoc body in a PLAIN command is text being written to a file (a test that quotes the
  // publish URL), not something the shell runs, so it is not judged (LC-1734) - but only when every other
  // step is on the short benign allow-list above (a later step could run the file the heredoc wrote).
  // A command that is not plain is judged whole, exactly as before.
  const view = plainView(command)
  // The exemption: judge ONLY the body-dropped text. Otherwise judge the raw command AND the command with every
  // heredoc body cut out, and deny if either does (the first can be blinded by a quote inside a body, the second
  // by a quote the cut leaves unpaired; together they close each other's gap).
  if (view.plain && onlyBenignSteps(view.text)) return judgeWithComments(view.text)
  return judgeWithComments(command) ?? judgeWithComments(withoutHeredocBodies(command))
}

// Comments are judged twice: as written, and cut off at their `#`.
const judgeWithComments = (t: string): string | null =>
  judgeText(t) ?? (t.includes('#') ? judgeText(withoutComments(t)) : null)

function judgeText(judgedText: string): string | null {
  // Segments that only read a file are dropped; the rest are judged together so a URL set in one
  // segment and fetched in the next is still seen.
  const kept = splitOutsideQuotes(judgedText).filter(
    seg => !(READ_ONLY_FIRST.test(seg) && !EXECUTOR.test(outsideQuotes(seg).replace(READ_ONLY_FIRST, ''))),
  )
  const rest = kept.join('\n')
  const runs = kept.some(seg => EXECUTOR.test(outsideQuotes(seg)) || COMMAND_POSITION.test(seg))
  if (!runs) return null
  const withoutGate = rest.split(/\s+/).filter(tok => !GATE_SCRIPT.test(tok)).join(' ')
  if (PUBLISH_MARKER.test(rest) || WEBFLOW_PUBLISH_URL.test(rest) || PUBLISH_SCRIPT_NAME.test(withoutGate)) {
    return 'This Bash command publishes to Webflow.'
  }
  return null
}

// ---------- shared: Webflow action payloads -----------------------------

type Json = Record<string, any>

// Reads `actions` at the top level AND under `input`, so tool.call and tool.check judge the same
// payload whichever envelope the MCP call arrives in.
function actionsOf(input: unknown): Json[] {
  const o = input as Json | null
  const out: Json[] = []
  for (const a of [o?.actions, o?.input?.actions]) {
    if (Array.isArray(a)) out.push(...a.filter((x): x is Json => !!x && typeof x === 'object'))
  }
  return out
}

// create passes items[] each with fieldData (the older shape is a fieldData LIST); update passes items[]
// each with a fieldData OBJECT. All are handled (the shapes webflow-no-slug-guard.py reads).
function writes(action: Json): { kind: 'create' | 'update'; collection: string; id: string; fd: Json }[] {
  const out: { kind: 'create' | 'update'; collection: string; id: string; fd: Json }[] = []
  // Any write-shaped key naming collection items is parsed (so a `_live` or `upsert_` variant cannot dodge
  // the payload checks). Only `create*` is a create; everything else is judged as an update, the stricter side.
  for (const [key, body] of Object.entries(action)) {
    if (!/collection_items/.test(key) || READ_ACTION.test(key) || /(?:^|_)(?:un)?publish|^delete_/.test(key)) continue
    const kind: 'create' | 'update' = key.startsWith('create') ? 'create' : 'update'
    if (!body || typeof body !== 'object') continue
    const req = body.request ?? {}
    const collection = String(body.collection_id ?? '')
    const lone = req.fieldData
    if (Array.isArray(lone)) {
      for (const fd of lone) if (fd && typeof fd === 'object') out.push({ kind, collection, id: '', fd })
    } else if (lone && typeof lone === 'object') {
      out.push({ kind, collection, id: '', fd: lone })
    }
    for (const it of Array.isArray(req.items) ? req.items : []) {
      if (it && typeof it.fieldData === 'object' && it.fieldData) {
        out.push({ kind, collection, id: String(it.id ?? ''), fd: it.fieldData })
      }
    }
  }
  return out
}

// Action names, from the Webflow MCP schemas of data_cms_tool, data_sites_tool and data_pages_tool (read
// 2026-10-07 via ToolSearch select:...). Reads: get_*, list_*, query_* (query_pages_schema_markup).
// Writes: create_/update_/delete_ (collections, fields, field groups, collection items, pages, branches),
// unpublish_collection_items (reverts a LIVE item to draft), and the ones a create/update prefix misses:
// bulk_update_pages, bulk_update_pages_schema_markup and merge_branch. The schemas list no `*_live` or
// `upsert_` variant; item writes are staged and publish_* is the only path live (denied below).
// An action key in NEITHER list is refused as unrecognized: an unknown shape must not read as permissive.
const READ_ACTION = /^(?:get|list|query)_/
const WRITE_ACTION = /^(?:create|update|delete|unpublish|bulk_update|merge|upsert|replace|set|restore)_/

// Keys of every action that are neither a read nor a write nor publish-shaped (`label` is not an action).
function unrecognizedKeys(input: unknown): string[] {
  const found: string[] = []
  for (const a of actionsOf(input)) {
    for (const k of Object.keys(a)) {
      if (k === 'label' || READ_ACTION.test(k) || WRITE_ACTION.test(k) || /publish/i.test(k)) continue
      found.push(k)
    }
  }
  return found
}

function isWrite(input: unknown): boolean {
  return actionsOf(input).some(a => Object.keys(a).some(k => WRITE_ACTION.test(k)))
}

function publishKeys(input: unknown): string[] {
  const found: string[] = []
  for (const a of actionsOf(input)) {
    for (const k of Object.keys(a)) {
      const lk = k.toLowerCase()
      if (lk.includes('publish') && !lk.includes('unpublish')) found.push(k)
    }
  }
  return found
}

const pillCount = (html: unknown): number =>
  typeof html === 'string' ? (html.match(/lc-deal-pill/g) ?? []).length : 0

// ---------- rule 4: payload checks --------------------------------------

type Verdict = { deny?: string; ask?: string }

// Pill loss mirrors markdown_to_webflow/pill_guard.py (LCH-302): per replaced body field, compare the live
// count with the incoming one. That guard fetches the live item itself; a hook cannot, so the baseline is
// whatever an earlier Webflow read in this session returned. Known loss is a deny. An unknown baseline is an
// ASK, not a deny: a permanent block gets the guard switched off, and the converter's own guard still
// refuses a real loss at --apply time.
function payloadVerdict(input: unknown, baseline: Record<string, number>): Verdict {
  const deny: string[] = []
  const ask: string[] = []
  for (const action of actionsOf(input)) {
    for (const w of writes(action)) {
      const onProducts = w.collection === PRODUCTS_COLLECTION
      if (onProducts && 'product-link' in w.fd) {
        const v = w.fd['product-link']
        if (typeof v !== 'string' || !GO_LINK.test(v)) {
          deny.push(
            `Products \`product-link\` must be a https://go.livingcozy.com/<redirect_slug> URL (LCH-220); got ${JSON.stringify(v)}. ` +
              'Never a raw brand, canonical or affiliate URL; no valid slug means skip and flag the card, not a fallback.',
          )
        }
      }
      if (onProducts && 'main-image' in w.fd) {
        deny.push(
          'A Products card hero goes to `feature-image`, NOT `main-image` (article-technical-audit §3). ' +
            '`main-image` is the Blog Posts field.',
        )
      }
      if (w.collection !== BLOG_COLLECTION) continue
      for (const field of BODY_FIELDS) {
        if (!(field in w.fd)) continue
        const body = w.fd[field]
        if (w.kind === 'update') {
          const base = w.id ? baseline[`${w.id}:${field}`] : undefined
          const now = pillCount(body)
          if (base !== undefined && now < base) {
            deny.push(
              `This \`${field}\` replace on item ${w.id} would drop lc-deal-pill spans (${base} seen in the live field, ${now} in the payload; LCH-302). ` +
                'Carry the pill markup next to the same brand CTA, or have the operator declare the loss on the converter path (accept_pill_loss).',
            )
          } else if (base === undefined) {
            ask.push(
              `No live read of ${w.id ? `item ${w.id}'s` : 'this item\'s'} \`${field}\` was seen this session, so lc-deal-pill spans cannot be compared (LCH-302). ` +
                'Read the item first (list_collection_items), or confirm it carries no pills.',
            )
          }
        }
        // A literal price in prose is sometimes legitimate ("a $1,000 budget"), and the payload alone cannot say
        // where a {{price:P-NNNNN}} belongs, so this is an ask.
        if (typeof body === 'string' && /\$\s?\d[\d,]*(?:\.\d{2})?/.test(body.replace(/\{\{price:[^}]*\}\}/g, ''))) {
          ask.push(
            `The \`${field}\` payload has a hand-typed price. Product prices belong in a {{price:P-NNNNN}} shortcode (LC-908) so they track the catalog.`,
          )
        }
      }
    }
  }
  return { deny: deny.length ? deny.join(' | ') : undefined, ask: ask.length ? ask.join(' | ') : undefined }
}

// ---------- rule 5: Catalog & Prices may publish Products and Brands (LC-2297) ----
//
// Why: operator decision (2026-11-19, repeated 2026-11-20) that Catalog & Prices (LC-429) publishes the
// Products and Brands items itself once each is verified correct, complete and current. Every other publish
// stays the human click above. The allowance is narrow on purpose:
//  * only a call whose EVERY action is exactly `publish_collection_items` on the Products or Brands collection
//    id (never a name), with plain item ids and no locale list; anything else keeps the old deny;
//  * only items whose staged fields THIS session read from Webflow after its last Webflow write, and (Products)
//    whose Supabase context it read with CONTEXT_SQL below, exactly; and
//  * only when hooks/catalog_publish.py gives every item PASS (product_readiness with no gaps and a price
//    verified under 24 h; Brands: required fields, alt text that is not the bare name). NOT CHECKED blocks.
// A hook has no credentials (LC-1017), so the evidence is what the session read, the same trust the
// lch600-review-gate board read uses. The mod cannot tell which project a session is in: any session that
// produces the evidence may publish these two collections.
const CATALOG_COLLECTIONS: Record<string, string> = { [PRODUCTS_COLLECTION]: 'Products', [BRANDS_COLLECTION]: 'Brands' }
const WEBFLOW_ID = /^[0-9a-f]{24}$/
const MAX_CATALOG_ITEMS = 100
const MAX_RECORDS = 1000
const catalogSeen = atom({ plugin: 'refresh-run-guard', key: 'catalogSeen' } as const, {} as Record<string, CatalogSeen>)
const catalogCtx = atom({ plugin: 'refresh-run-guard', key: 'catalogCtx' } as const, {} as Record<string, CatalogCtx>)

// The ONE Supabase read the check trusts for a Products item's context. Matched exactly (whitespace and case
// aside) with only the id list varying, so a hand-made `select 'x' as price_verified_at` is not evidence.
export const CONTEXT_SQL_HEAD =
  'select p.webflow_id, p.public_code, p.review_id, p.lc_reviewed, p.product_line_id, p.price_verified_at, ' +
  'pl.id as line_id, pl.webflow_id as line_webflow_id, pl.review_id as line_review_id, ' +
  'c.id is not null as card_row_found, c.card_sale_price ' +
  'from products p left join product_lines pl on pl.id = p.product_line_id ' +
  'left join v_product_card_price c on c.id = p.id where p.webflow_id in ('
const norm = (q: string): string => q.toLowerCase().replace(/\s+/g, ' ').replace(/\s*([(),=])\s*/g, '$1').trim()
const HEAD_NORM = norm(CONTEXT_SQL_HEAD)
const ID_LIST = /^'[0-9a-f]{24}'(?:,'[0-9a-f]{24}')*\)$/

export function contextSql(ids: string[]): string {
  return `${CONTEXT_SQL_HEAD}${ids.map(i => `'${i}'`).join(', ')})`
}

/** The Webflow ids a canonical context read asked for, or null when the query is anything else. */
export function contextSqlIds(query: unknown): string[] | null {
  if (typeof query !== 'string' || query.length > 20_000) return null
  const q = norm(query).replace(/;$/, '')
  if (!q.startsWith(HEAD_NORM)) return null
  const rest = q.slice(HEAD_NORM.length)
  if (!ID_LIST.test(rest)) return null
  return rest.slice(0, -1).split(',').map(s => s.slice(1, -1))
}

/** Row objects in an execute_sql result: the JSON array, also when it sits inside a `result` string. */
function sqlRows(text: string, depth = 0): Json[] {
  const out: Json[] = []
  if (depth > 2) return out
  for (const v of jsonValues(text)) {
    if (Array.isArray(v)) out.push(...v.filter((r): r is Json => !!r && typeof r === 'object' && !Array.isArray(r)))
    else if (v && typeof v === 'object' && typeof (v as Json).result === 'string') out.push(...sqlRows((v as Json).result, depth + 1))
  }
  return out
}

export type CatalogItem = { collection: string; id: string }

/**
 * The items of a publish this rule may consider, or null when the call is not exactly that shape: every
 * action is `publish_collection_items` (plus `label`) on Products or Brands, with `request.itemIds` or
 * `request.items[].id` (no cmsLocaleIds, no other keys), at most 100 distinct ids.
 */
export function catalogPublishItems(input: unknown): CatalogItem[] | null {
  const actions = actionsOf(input)
  if (!actions.length) return null
  const items: CatalogItem[] = []
  for (const a of actions) {
    const keys = Object.keys(a).filter(k => k !== 'label')
    if (keys.length !== 1 || keys[0] !== 'publish_collection_items') return null
    const body = a.publish_collection_items
    if (!body || typeof body !== 'object' || Array.isArray(body)) return null
    if (Object.keys(body).some(k => k !== 'collection_id' && k !== 'request')) return null
    const collection = body.collection_id
    if (typeof collection !== 'string' || !(collection in CATALOG_COLLECTIONS)) return null
    const req = body.request
    if (!req || typeof req !== 'object' || Array.isArray(req)) return null
    const reqKeys = Object.keys(req)
    let ids: unknown[]
    if (reqKeys.length === 1 && reqKeys[0] === 'itemIds' && Array.isArray(req.itemIds)) ids = req.itemIds
    else if (reqKeys.length === 1 && reqKeys[0] === 'items' && Array.isArray(req.items)) {
      ids = []
      for (const it of req.items) {
        if (!it || typeof it !== 'object' || Object.keys(it).some(k => k !== 'id')) return null
        ids.push(it.id)
      }
    } else return null
    if (!ids.length) return null
    for (const id of ids) {
      if (typeof id !== 'string' || !WEBFLOW_ID.test(id)) return null
      if (!items.some(i => i.id === id && i.collection === collection)) items.push({ collection, id })
    }
  }
  return items.length <= MAX_CATALOG_ITEMS ? items : null
}

/**
 * Why a call that publishes Products or Brands items is NOT rule 5's shape, or null when the call is rule 5's
 * shape or publishes no Products/Brands items at all. It only words the refusal; it never allows anything.
 *
 * Why it exists (LC-2309, 2026-11-20): Catalog & Prices sent a card update and the Products publish in ONE
 * call. Rule 5 rightly refused it (the publish needs a fresh read AFTER the last write, which a bundled write
 * makes impossible), but the refusal was the article text ("needs a Pass A receipt"), so the session read it
 * as "the guard does not know about Products" and filed a mod-change request. Review this by 2027-02-20:
 * if no session has hit it by then, fold the wording into CATALOG_NEXT and drop the function.
 */
export function catalogNearMiss(input: unknown): string | null {
  const actions = actionsOf(input)
  const touchesCatalog = actions.some(a => {
    const b = a.publish_collection_items
    return !!b && typeof b === 'object' && typeof b.collection_id === 'string' && b.collection_id in CATALOG_COLLECTIONS
  })
  if (!touchesCatalog || catalogPublishItems(input)) return null
  const others = [...new Set(actions.flatMap(a => Object.keys(a).filter(k => k !== 'label' && k !== 'publish_collection_items')))]
  if (others.length) return `also carries ${others.join(', ')}, and a Products/Brands publish must be a call of its own`
  const foreign = actions.some(a => {
    const id = a.publish_collection_items?.collection_id
    return !(typeof id === 'string' && id in CATALOG_COLLECTIONS)
  })
  if (foreign) return 'also publishes a collection other than Products or Brands (articles stay a human click)'
  return 'does not send plain item ids (request.itemIds, or request.items with only an id each; no locales, no other keys, 1 to 100 ids of 24 hex characters)'
}

/** A single-action staged read of a catalog collection in the primary locale: the only read recorded. */
function catalogRead(input: unknown): string | null {
  const actions = actionsOf(input)
  if (actions.length !== 1) return null
  const body = actions[0]?.list_collection_items
  if (!body || typeof body !== 'object') return null
  const collection = body.collection_id
  if (typeof collection !== 'string' || !(collection in CATALOG_COLLECTIONS)) return null
  const req = body.request
  if (req && typeof req === 'object' && ('cmsLocaleId' in req || 'allCmsLocales' in req)) return null
  return collection
}

function catalogItemsIn(text: string | undefined): { id: string; fieldData: Json; isArchived: boolean }[] {
  const out: { id: string; fieldData: Json; isArchived: boolean }[] = []
  const walk = (v: unknown, depth: number): void => {
    if (!v || typeof v !== 'object' || depth > 8) return
    if (Array.isArray(v)) return void v.forEach(x => walk(x, depth + 1))
    const o = v as Json
    if (typeof o.id === 'string' && WEBFLOW_ID.test(o.id) && o.fieldData && typeof o.fieldData === 'object' && !Array.isArray(o.fieldData)) {
      out.push({ id: o.id, fieldData: o.fieldData, isArchived: o.isArchived === true })
      return
    }
    for (const x of Object.values(o)) walk(x, depth + 1)
  }
  for (const v of jsonValues(text)) walk(v, 0)
  return out
}

const cap = <T>(m: Record<string, T>): Record<string, T> => {
  const keys = Object.keys(m)
  return keys.length <= MAX_RECORDS ? m : (Object.fromEntries(keys.slice(keys.length - MAX_RECORDS).map(k => [k, m[k]])) as Record<string, T>)
}

type Receipt = { collection: string; id: string; verdict: string; reason: string }

export function describeReceipts(receipts: Receipt[]): string {
  return receipts.map(r => `${r.verdict} ${r.collection} ${r.id}: ${r.reason}`).join(' | ')
}

/** The check's verdict, or null when it could not run or answered junk (the caller then refuses). */
export function parseCatalogVerdict(r: { exitCode?: number; stdout?: unknown } | undefined, items: CatalogItem[]): { allow: boolean; receipts: Receipt[] } | null {
  if (!r || r.exitCode !== 0 || !items.length) return null
  try {
    const v = JSON.parse(String(r.stdout ?? '').trim())
    if (!v || typeof v.allow !== 'boolean' || !Array.isArray(v.receipts) || !v.receipts.length) return null
    const receipts = v.receipts.filter((x: any) => x && typeof x.verdict === 'string') as Receipt[]
    if (receipts.length !== v.receipts.length) return null
    // allow must agree with the receipts: one non-PASS receipt refuses, whatever `allow` says, and every
    // requested item needs its OWN PASS receipt (one PASS must not cover two ids; independent review, PR #4067).
    // Keyed on collection AND id: a Brands PASS never covers a Products item with the same id.
    const passed = new Set(receipts.filter(x => x.verdict === 'PASS').map(x => `${x.collection}/${x.id}`))
    const covered = items.every(it => passed.has(`${CATALOG_COLLECTIONS[it.collection] ?? '?'}/${it.id}`))
    return { allow: v.allow && covered && receipts.every(x => x.verdict === 'PASS'), receipts }
  } catch {
    return null
  }
}

const CATALOG_NEXT =
  'To publish: read each item with data_cms_tool list_collection_items (one action, that collection, no locale) after your last write, ' +
  'run the context query for Products items, fix any BLOCK, then publish again. Articles stay a human click.'

// The refusal for a Products/Brands publish that misses rule 5's shape: says what to change, not "Pass A".
function nearMissDeny(keys: string[], miss: string): string {
  return `publish-shaped Webflow call (${keys.join(', ')}). It publishes Products/Brands items, but not in the shape rule 5 (LC-2297) ` +
    `accepts: this call ${miss}. Send any Webflow writes first, as their own call. ${CATALOG_NEXT}`
}

// ---------- Pass A bookkeeping ------------------------------------------

const PASS_A_CMD = /article_audit\.py/
const PASS_A_FLAGS = /--pass[ =](?:a|both)\b/
const WRITE_RECEIPT = /--write-receipt\b/

// Pass A is recorded only from a command that cannot splice in extra stdout or mask the exit status. These
// harmless wrappers are allowed: a leading `cd <dir> &&`, `2>&1`, and a trailing `| tail|head|tee ...`.
function isSimpleAuditCommand(cmd: string): boolean {
  let c = cmd.trim()
  c = c.replace(/^cd\s+[^;&|`$()\n]+?\s*&&\s*/, '')
  c = c.replace(/\s2>&1/g, '')
  c = c.replace(/\s*\|\s*(?:tail|head|tee)\b[^;&|`$()\n]*$/, '')
  return !/[;&|`\n#]|\$\(|\becho\b|\bprintf\b/.test(c)
}

function describePassA(map: Record<string, PassAEntry>): string {
  const rows = Object.values(map)
  if (!rows.length) return 'No Pass A receipt was recorded this session.'
  return rows
    .map(r => `${r.slug || r.runId}: ${r.stale ? 'STALE (an item write came after it)' : 'fresh'}`)
    .join('; ')
}

async function paintStatus($: any) {
  const rows = Object.values(await read($, passA))
  if (!rows.length) return $.ui.status(undefined)
  const stale = rows.some(r => r.stale)
  $.ui.status(stale ? 'Pass A STALE — rerun before the publish click' : `Pass A fresh: ${rows.map(r => r.slug || r.runId).join(', ')}`)
}

// A bookkeeping step threw after the tool already ran. Return the tool's own result (never call
// next again), but treat Pass A as stale and tell the model so.
async function bookkeepingFailed($: any, ran: any, what: string) {
  try {
    const at = await $.clock.now()
    await update($, passA, m =>
      Object.fromEntries(Object.entries(m).map(([k, r]) => [k, { ...r, stale: true, staleAt: at }])),
    )
  } catch { /* the note below still goes out */ }
  return { ...ran, context: [...(ran.context ?? []), say($, `${what} bookkeeping failed; treat Pass A as STALE. ${STALE_NOTE}`)] }
}

// The guard broke AFTER the tool ran. next is never called again (the tool must not run twice), and
// the refusal says plainly that the effect may have applied, so the model checks before retrying.
const AFTER_FAIL =
  'the guard failed AFTER this tool ran, so its effect may already have applied. ' +
  'Do not retry blindly: verify the result first, and treat Pass A as STALE.'

const STALE_NOTE = 'Pass A stale — rerun before the publish click: `python3 webflow/bulk-operations/article-audit/article_audit.py --slug <slug> --pass a --write-receipt`.'

// The Webflow MCP answers with one JSON object per action, back to back (measured 2026-10-07):
//   {"label":..,"action":"list_collection_items","result":{"items":[{"id":..,"fieldData":{..}}],"pagination":{..}}}
// so the text is read as a sequence of top-level JSON values, not one document.
function jsonValues(text: string | undefined): unknown[] {
  const out: unknown[] = []
  if (!text) return out
  let i = 0
  while (i < text.length) {
    const c = text[i]
    if (c !== '{' && c !== '[') { i++; continue }
    let depth = 0
    let inStr = false
    let j = i
    for (; j < text.length; j++) {
      const d = text[j]
      if (inStr) {
        if (d === '\\') j++
        else if (d === '"') inStr = false
        continue
      }
      if (d === '"') inStr = true
      else if (d === '{' || d === '[') depth++
      else if (d === '}' || d === ']') { depth--; if (depth === 0) break }
    }
    if (depth !== 0) break
    try { out.push(JSON.parse(text.slice(i, j + 1))) } catch { /* not JSON: skip past it */ }
    i = j + 1
  }
  return out
}

// Item bodies seen in Webflow read results become the pill baseline, per body field.
function harvest(value: unknown, out: Record<string, number>, depth = 0): void {
  if (!value || typeof value !== 'object' || depth > 12) return
  if (Array.isArray(value)) return void value.forEach(v => harvest(v, out, depth + 1))
  const o = value as Json
  if (typeof o.id === 'string' && o.fieldData && typeof o.fieldData === 'object') {
    for (const f of BODY_FIELDS) if (typeof o.fieldData[f] === 'string') out[`${o.id}:${f}`] = pillCount(o.fieldData[f])
  }
  for (const v of Object.values(o)) harvest(v, out, depth + 1)
}

// The SQL and Bash arguments may arrive at the top level or under `input` (the same two envelopes the
// Webflow payload is read from). Every present copy is judged and ANY violation denies, so a harmless
// decoy in one place cannot shield a write in the other. Neither present is judged too (and refused).
function judged(e: any, field: 'query' | 'command', check: (v: unknown) => string | null): string | null {
  const copies = [e?.[field], e?.input?.[field]].filter(v => v !== undefined)
  for (const v of copies.length ? copies : [undefined]) {
    const hit = check(v)
    if (hit) return hit
  }
  return null
}

// Runs hooks/catalog_publish.py. `$` helpers stay in this file (the plugin validator follows `$` only here).
async function catalogCheck($: any, items: CatalogItem[]): Promise<{ allow: boolean; receipts: Receipt[] } | null> {
  try {
    const now = await $.clock.now()
    const payload = { now_ms: now, items, seen: await read($, catalogSeen), ctx: await read($, catalogCtx) }
    const r = await $.process.run(['python3', '-I', `${$.plugin.root}/hooks/catalog_publish.py`], { stdin: JSON.stringify(payload), timeoutMs: 20_000 })
    return parseCatalogVerdict(r, items)
  } catch {
    return null
  }
}

export const register: Register = on => {
  // Rule 1 ------------------------------------------------------------
  on('tool.call', { tool: SQL_TOOL }, async ($, e: any, next) => {
    const v = judged(e, 'query', sqlViolation)
    if (v) return { deny: say($, `${v} ${RECEIPT_WHY}`) }
    const ran: any = await next(e)
    // Rule 5 bookkeeping: a canonical catalog-context read records its rows. A failure here only loses
    // evidence (the publish then reads NOT CHECKED), so it never touches the result.
    try {
      const copies = [e?.query, e?.input?.query].filter(q => q !== undefined)
      const ids = copies.length === 1 ? contextSqlIds(copies[0]) : null
      if (ids && ran.deny === undefined && ran.isError !== true) {
        const at = await $.clock.now()
        const got: Record<string, CatalogCtx> = {}
        const dup = new Set<string>()
        for (const row of sqlRows(typeof ran.text === 'string' ? ran.text : '')) {
          const id = row.webflow_id
          if (typeof id !== 'string' || !ids.includes(id)) continue
          if (id in got) dup.add(id) // two rows for one id: neither is evidence
          got[id] = { row, readAt: at }
        }
        for (const id of dup) delete got[id]
        if (Object.keys(got).length) await update($, catalogCtx, m => cap({ ...m, ...got }))
      }
    } catch { /* evidence lost, result intact */ }
    return ran
  }).catch(($, e, next) =>
    next.called ? { deny: say($, AFTER_FAIL) } : { deny: say($, 'the SQL guard failed, so this call is refused rather than unchecked.') },
  )

  // Rules 2 and 3 (Bash) ----------------------------------------------
  on('tool.call', { tool: 'Bash' }, async ($, e: any, next) => {
    const v = judged(e, 'command', bashPublishViolation)
    const cmd = String(e.command ?? e.input?.command ?? '')
    if (v) {
      const state = describePassA(await read($, passA))
      return {
        deny: say(
          $,
          `${v} Publishing is a human click in the Webflow Designer, not a script (LC-1017, same rule as webflow-publish-gate). ` +
            `${state} ${STALE_NOTE}`,
        ),
      }
    }
    const ran: any = await next(e)
    if (ran.deny !== undefined) return ran

    try {
      // Pass A receipt: exit 0 only (a failed Bash call carries isError). Fresh only when the audit's own
      // output says so: article_audit.py prints
      // `receipt written — <slug>: pass_a = PASS (...) -> refresh_runs <run_id>` after the write. The Bash
      // result's stdout is `ran.result.stdout` (BuiltinToolResults.Bash in the claude-code types).
      if (
        PASS_A_CMD.test(cmd) && PASS_A_FLAGS.test(cmd) && WRITE_RECEIPT.test(cmd) &&
        isSimpleAuditCommand(cmd) && ran.isError !== true
      ) {
        const out = String(ran.result?.stdout ?? ran.text ?? '')
        const m = /^receipt written — (\S+): pass_a = PASS\b.*?refresh_runs (\S+)/m.exec(out)
        // A pipe (`| tail`) hides the audit's own exit status, so the receipt line is the evidence, and
        // any failure marker in the same output (a BLOCK finding, a traceback, a failed write) cancels it.
        if (m && !/::error::|Traceback|RECEIPT WRITE FAILED/.test(out)) {
          const at = await $.clock.now()
          await update($, passA, all => ({ ...all, [m[1]]: { slug: m[1], runId: m[2], at, stale: false, staleAt: 0 } }))
          await paintStatus($)
        }
      }

      // v2_s10 handoff: add the freshness note to the result the model reads.
      if (
        /write_stage_receipt/.test(cmd) &&
        (/\bv2_s10\b(?!_)/.test(cmd) || /--stage[ =]10(?:\.0+)?(?=\s|$)/.test(cmd)) &&
        !/--part[ =]\S*render/.test(cmd)
      ) {
        const rows = Object.values(await read($, passA))
        if (!rows.length || rows.some(r => r.stale)) {
          return { ...ran, context: [...(ran.context ?? []), say($, `Pass A stale or missing at the publish handoff. ${rows.length ? STALE_NOTE : 'No Pass A receipt was recorded this session. ' + STALE_NOTE}`)] }
        }
      }
      return ran
    } catch {
      return bookkeepingFailed($, ran, 'Bash')
    }
  }).catch(($, e, next) =>
    next.called ? { deny: say($, AFTER_FAIL) } : { deny: say($, 'the Bash guard failed, so this call is refused rather than unchecked.') },
  )

  // Rules 2-4 (Webflow MCP) -------------------------------------------
  on('tool.call', { tool: WEBFLOW_TOOL }, async ($, e: any, next) => {
    if (actionsOf(e).length === 0) {
      return { deny: say($, 'this Webflow call carries no `actions` (missing or empty), so its payload cannot be examined.') }
    }
    const unknown = unrecognizedKeys(e)
    if (unknown.length) {
      return { deny: say($, `unrecognized Webflow action (${unknown.join(', ')}); it is neither a known read nor a known write, so it cannot be examined.`) }
    }
    const keys = publishKeys(e)
    const catalog = keys.length ? catalogPublishItems(e) : null
    if (catalog) {
      // Rule 5: a Products / Brands publish goes out only on a PASS receipt for every item.
      const verdict = await catalogCheck($, catalog)
      const products = catalog.filter(i => i.collection === PRODUCTS_COLLECTION).map(i => i.id)
      const query = products.length ? ` Context query for the Products items: ${contextSql(products)}` : ''
      if (!verdict) {
        return { deny: say($, `NOT CHECKED: the Products/Brands readiness check could not run, so this publish is refused. ${CATALOG_NEXT}${query}`) }
      }
      if (!verdict.allow) {
        return { deny: say($, `Products/Brands publish refused; every item needs PASS. Receipts: ${describeReceipts(verdict.receipts)}. ${CATALOG_NEXT}${query}`) }
      }
      const ranPub: any = await next(e)
      if (ranPub.deny !== undefined) return ranPub
      return {
        ...ranPub,
        context: [
          ...(ranPub.context ?? []),
          say($, `Products/Brands publish allowed (LC-2297). Receipts: ${describeReceipts(verdict.receipts)}. ` +
            'Check publishedItemIds against the ids sent and read any errors before reporting it live.'),
        ],
      }
    }
    if (keys.length) {
      const miss = catalogNearMiss(e)
      if (miss) return { deny: say($, nearMissDeny(keys, miss)) }
      return {
        deny: say(
          $,
          `publish-shaped Webflow call (${keys.join(', ')}). Publishing is a human click in the Webflow Designer. ` +
            `${describePassA(await read($, passA))} ${STALE_NOTE}`,
        ),
      }
    }
    const verdict = payloadVerdict(e, await read($, pills))
    if (verdict.deny) return { deny: say($, verdict.deny) }

    const ran: any = await next(e)
    if (ran.deny !== undefined || ran.isError === true) return ran

    try {
      if (isWrite(e)) {
        // The payload cannot be mapped back to one article (Products and Best
        // Products Data cards are shared), so any item write stales every recorded Pass A.
        const at = await $.clock.now()
        await update($, passA, m =>
          Object.fromEntries(Object.entries(m).map(([k, r]) => [k, { ...r, stale: true, staleAt: at }])),
        )
        const written: Record<string, number> = {}
        for (const a of actionsOf(e)) {
          for (const w of writes(a)) {
            if (!w.id || w.collection !== BLOG_COLLECTION) continue
            for (const f of BODY_FIELDS) if (f in w.fd) written[`${w.id}:${f}`] = pillCount(w.fd[f])
          }
        }
        if (Object.keys(written).length) await update($, pills, m => ({ ...m, ...written }))
        // Rule 5: any Webflow write may have changed a staged catalog item, so every staged read is void.
        await update($, catalogSeen, () => ({}))
        await paintStatus($)
      } else {
        const seen: Record<string, number> = {}
        for (const v of jsonValues(ran.text)) harvest(v, seen)
        if (Object.keys(seen).length) await update($, pills, m => ({ ...m, ...seen }))
        const collection = catalogRead(e)
        if (collection) {
          const at = await $.clock.now()
          const got: Record<string, CatalogSeen> = {}
          for (const it of catalogItemsIn(ran.text)) {
            got[it.id] = { collection, fieldData: it.fieldData, isArchived: it.isArchived, readAt: at }
          }
          if (Object.keys(got).length) await update($, catalogSeen, m => cap({ ...m, ...got }))
        }
      }
      return ran
    } catch {
      return bookkeepingFailed($, ran, 'Webflow')
    }
  }).catch(($, e, next) =>
    next.called ? { deny: say($, AFTER_FAIL) } : { deny: say($, 'the Webflow guard failed, so this call is refused rather than unchecked.') },
  )

  // Asks: the checks the payload alone cannot settle -------------------
  on('tool.check', { tool: WEBFLOW_TOOL }, async ($, e: any, next) => {
    if (actionsOf(e.input).length === 0) {
      return { decision: 'deny', reason: say($, 'this Webflow call carries no `actions` (missing or empty), so its payload cannot be examined.') }
    }
    const unknown = unrecognizedKeys(e.input)
    if (unknown.length) {
      return { decision: 'deny', reason: say($, `unrecognized Webflow action (${unknown.join(', ')}); it cannot be examined.`) }
    }
    const keys = publishKeys(e.input)
    // Rule 5: a Products / Brands publish is judged in tool.call, where the readiness check runs.
    if (keys.length && catalogPublishItems(e.input)) return next(e)
    if (keys.length) {
      const miss = catalogNearMiss(e.input)
      if (miss) return { decision: 'deny', reason: say($, nearMissDeny(keys, miss)) }
      return {
        decision: 'deny',
        reason: say(
          $,
          `publish-shaped Webflow call (${keys.join(', ')}). Publishing is a human click in the Webflow Designer. ` +
            `${describePassA(await read($, passA))} ${STALE_NOTE}`,
        ),
      }
    }
    const verdict = payloadVerdict(e.input, await read($, pills))
    if (verdict.deny) return { decision: 'deny', reason: say($, verdict.deny) }
    if (verdict.ask) return { decision: 'ask', reason: say($, verdict.ask) }
    return next(e)
  }).catch($ => ({ decision: 'deny' as const, reason: say($, 'the payload check failed, so this call is refused.') }))

  on('session.start', async ($, e, next) => {
    await paintStatus($)
    return next(e)
  })
}
