// Pure decision logic for ci-preflight (LC-1846). No `$`, no I/O: register.ts feeds it facts and
// acts on the answer, so every rule here is unit-tested without an engine.

export const NUDGE_WINDOW_MS = 10 * 60_000
export const PREFLIGHT_TIMEOUT_MS = 180_000
export const MAX_DENY_LINES = 40
export const SKIP_RE = /(^|[\s;&|'"])PREFLIGHT_SKIP=1(?![A-Za-z0-9_])/

// ---------------------------------------------------------------------------------------------
// 1. Which commands are a push?
//
// WHAT WE CHOSE. The command is split into simple commands at && || ; | & and newlines, outside
// quotes, and each is tokenised with quotes removed. A command is a push only when, after
// leading VAR=val words and wrappers (env, command, exec, time, nohup), its program is `git`, its
// git global options (-C dir, -c k=v, --git-dir ...) are skipped, and its subcommand is `push`.
// So `echo "git push"` (program is echo), `grep 'git push' f` and a commit message that mentions a
// push are NOT pushes. `bash -c 'git push'` / `sh -c` / `eval` is parsed recursively. Not seen
// (the hook fails open on these): `$(...)`, backticks, aliases, a script that pushes.
//
// NOT a push for this mod: --dry-run / -n, --delete / -d, and the `git push origin :branch` delete
// refspec. Nothing is sent that CI would run on.
// ---------------------------------------------------------------------------------------------

export type Push = {
  /** Directory the push runs in: absolute, or relative to the session's cwd; undefined = the cwd. */
  dir?: string
  /** True when the directory could not be resolved statically (`~`, `$VAR`, `$(...)`). */
  isDirUnresolved: boolean
  /** Explicit branch (from a refspec) when the command names one. */
  branch?: string
}

const WRAPPERS = new Set(['env', 'command', 'exec', 'time', 'nohup'])
const GIT_VALUE_OPTS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env', '--exec-path'])
const PUSH_VALUE_OPTS = new Set(['--repo', '-o', '--push-option', '--receive-pack', '--exec'])
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash'])

/** Splits at unquoted && || ; | & and newlines, then into words with quotes removed. */
export function splitCommands(command: string): string[][] {
  const out: string[][] = []
  let words: string[] = []
  let cur = ''
  let has = false
  let quote: '' | "'" | '"' = ''
  const endWord = () => { if (has) words.push(cur); cur = ''; has = false }
  const endCmd = () => { endWord(); if (words.length) out.push(words); words = [] }
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!
    if (quote === "'") { if (c === "'") quote = ''; else cur += c; continue }
    if (quote === '"') {
      if (c === '"') quote = ''
      else if (c === '\\' && i + 1 < command.length && '"\\$`'.includes(command[i + 1]!)) cur += command[++i]
      else cur += c
      continue
    }
    if (c === "'" || c === '"') { quote = c; has = true; continue }
    if (c === '\\' && i + 1 < command.length) { cur += command[++i]; has = true; continue }
    if (c === '\n' || c === ';' || c === '|' || c === '&') {
      endCmd()
      // `&&` / `||` are two chars of the same separator
      if ((c === '&' || c === '|') && command[i + 1] === c) i++
      continue
    }
    if (c === ' ' || c === '\t') { endWord(); continue }
    cur += c; has = true
  }
  endCmd()
  return out
}

/** posix join/normalise of `rel` onto `base` (undefined base = unknown cwd, kept relative). */
export function resolveDir(base: string | undefined, rel: string): string {
  const joined = rel.startsWith('/') || base === undefined ? rel : `${base}/${rel}`
  const abs = joined.startsWith('/')
  const parts: string[] = []
  for (const p of joined.split('/')) {
    if (p === '' || p === '.') continue
    if (p === '..') { if (parts.length && parts[parts.length - 1] !== '..') parts.pop(); else if (!abs) parts.push('..'); continue }
    parts.push(p)
  }
  return (abs ? '/' : '') + parts.join('/') || (abs ? '/' : '.')
}

const UNRESOLVABLE = /^~|[$`]/

function branchFromRefspecs(specs: string[]): string | undefined {
  // `git push origin feat` / `HEAD:feat` / `+src:refs/heads/feat`: the destination is the branch.
  const spec = specs[0]
  if (!spec || spec === 'HEAD') return undefined
  const dst = spec.replace(/^\+/, '').split(':').pop() ?? ''
  const b = dst.replace(/^refs\/heads\//, '')
  return b && b !== 'HEAD' ? b : undefined
}

export function parsePushes(command: string, depth = 0): Push[] {
  const pushes: Push[] = []
  let dir: string | undefined // from earlier `cd X` in the same command
  let isDirUnresolved = false
  for (const raw of splitCommands(command)) {
    let w = [...raw]
    while (w.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0]!) || WRAPPERS.has(w[0]!))) w.shift()
    const prog = (w[0] ?? '').split('/').pop()
    if (prog === 'cd' && w[1] !== undefined) {
      if (UNRESOLVABLE.test(w[1])) isDirUnresolved = true
      else { dir = resolveDir(dir, w[1]); isDirUnresolved = false }
      continue
    }
    if (SHELLS.has(prog ?? '') && depth < 3) {
      const ci = w.findIndex(x => /^-[A-Za-z]*c$/.test(x))
      if (ci >= 0 && w[ci + 1] !== undefined) {
        for (const p of parsePushes(w[ci + 1]!, depth + 1)) pushes.push({ ...p, dir: p.dir ?? dir, isDirUnresolved: p.isDirUnresolved || isDirUnresolved })
      }
      continue
    }
    if (prog === 'eval' && depth < 3 && w[1] !== undefined) {
      for (const p of parsePushes(w.slice(1).join(' '), depth + 1)) pushes.push({ ...p, dir: p.dir ?? dir, isDirUnresolved: p.isDirUnresolved || isDirUnresolved })
      continue
    }
    if (prog !== 'git') continue

    // git global options
    let i = 1
    let gdir = dir
    let unresolved = isDirUnresolved
    for (; i < w.length; i++) {
      const t = w[i]!
      if (t === '-C' && w[i + 1] !== undefined) {
        const d = w[++i]!
        if (UNRESOLVABLE.test(d)) unresolved = true
        else gdir = resolveDir(gdir, d)
      } else if (GIT_VALUE_OPTS.has(t)) i++
      else if (t.startsWith('-')) continue // -c k=v handled above; --no-pager, -p, --git-dir=..
      else break
    }
    if (w[i] !== 'push') continue

    // push options and arguments
    const pos: string[] = []
    let ignored = false
    for (let j = i + 1; j < w.length; j++) {
      const t = w[j]!
      if (t === '--') { pos.push(...w.slice(j + 1)); break }
      if (t === '--dry-run' || t === '-n' || t === '--delete' || t === '-d') { ignored = true; continue }
      if (/^-[A-Za-z]+$/.test(t) && !t.startsWith('--') && /[nd]/.test(t) && t !== '-o') { ignored = true; continue } // -fn, -nf, -fd ...
      if (PUSH_VALUE_OPTS.has(t)) { j++; continue }
      if (t.startsWith('-')) continue
      pos.push(t)
    }
    if (ignored) continue
    const specs = pos.slice(1) // pos[0] is the remote
    if (specs.some(s => s.startsWith(':'))) continue // delete refspec
    pushes.push({ dir: gdir, isDirUnresolved: unresolved, branch: branchFromRefspecs(specs) })
  }
  return pushes
}

export const hasSkip = (command: string): boolean => SKIP_RE.test(command)

// ---------------------------------------------------------------------------------------------
// 2. Preflight outcome -> decision
// ---------------------------------------------------------------------------------------------

export type PreflightRun =
  | { kind: 'skipped' }
  | { kind: 'not-applicable' } // repo has no scripts/ci/preflight.sh
  | { kind: 'unresolved-dir' }
  | { kind: 'timeout'; seconds: number }
  | { kind: 'error'; message: string }
  | { kind: 'exit'; code: number; output: string }

/** `isQuiet`: routine, nothing changed for the person (a pass, or a repo this mod does not apply to): no toast. */
export type Decision = { deny?: string; context?: string[]; toast?: string; isQuiet?: boolean }

export const BYPASS_LINE =
  'Real emergency only: put PREFLIGHT_SKIP=1 in the command (PREFLIGHT_SKIP=1 git push ...) to push anyway; it is allowed with a note, and CI then runs every check.'

/** Keeps a long summary readable: head, a marker, and the tail (the pass/fail count line). */
export function trimLines(text: string, max = MAX_DENY_LINES): string {
  const lines = text.replace(/\s+$/, '').split('\n')
  if (lines.length <= max) return lines.join('\n')
  const tail = 6
  const head = max - tail - 1
  return [...lines.slice(0, head), `... (${lines.length - head - tail} lines trimmed)`, ...lines.slice(-tail)].join('\n')
}

export function notCheckedLines(output: string): string[] {
  return output.split('\n').filter(l => l.startsWith('NOT CHECKED')).map(l => l.replace(/\s+/g, ' ').trim())
}

export function decidePush(run: PreflightRun): Decision {
  switch (run.kind) {
    case 'not-applicable':
      return {}
    case 'skipped':
      return { context: ['PREFLIGHT_SKIP=1 was in the command: local preflight was bypassed; CI runs every check on this push.'] }
    case 'unresolved-dir':
      return { context: ['could not work out which directory this push runs in (~, $VAR or $(...) in cd/-C): preflight NOT CHECKED. CI runs every check.'] }
    case 'timeout':
      return { context: [`preflight timed out after ${run.seconds}s: NOT CHECKED. Push allowed (the mod never blocks on its own slowness); CI runs every check.`] }
    case 'error':
      return { context: [`preflight could not run (${run.message}): NOT CHECKED. Push allowed; CI runs every check.`] }
    case 'exit': {
      if (run.code === 0) return { context: ['preflight passed (all applicable fast checks green).'], isQuiet: true }
      if (run.code === 1) {
        return {
          deny: `push blocked, preflight FAILED (each failed CI round costs ~19 checks on a CPU-bound runner). Fix, commit, push again.\n` +
            `${trimLines(run.output)}\n${BYPASS_LINE}`,
          toast: 'push blocked: preflight failed (see the session for the summary)',
        }
      }
      if (run.code === 2) {
        const nc = notCheckedLines(run.output)
        return { context: [`preflight passed what it could, but these were NOT CHECKED (not a pass): ${nc.length ? nc.join(' | ') : 'see scripts/ci/preflight.sh output'}. Push allowed; CI runs them.`] }
      }
      return { context: [`preflight exited ${run.code} (not a result it defines): NOT CHECKED. Push allowed; CI runs every check.`] }
    }
  }
}

// ---------------------------------------------------------------------------------------------
// 3. update-branch guard: check runs -> allow / deny
// ---------------------------------------------------------------------------------------------

export type CheckRun = { name: string; status: string; conclusion: string | null }

const OK = new Set(['success', 'neutral', 'skipped'])
const BAD = new Set(['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure', 'stale'])

/** Reads the GitHub MCP get_check_runs text. undefined = could not be read as a list of runs. */
export function parseCheckRuns(text: string): CheckRun[] | undefined {
  let v: unknown
  try { v = JSON.parse(text) } catch { return undefined }
  const list = Array.isArray(v) ? v : (v && typeof v === 'object' ? (v as { check_runs?: unknown }).check_runs : undefined)
  if (!Array.isArray(list)) return undefined
  const out: CheckRun[] = []
  for (const r of list) {
    if (!r || typeof r !== 'object') return undefined
    const o = r as Record<string, unknown>
    if (typeof o.name !== 'string' || typeof o.status !== 'string') return undefined
    out.push({ name: o.name, status: o.status.toLowerCase(), conclusion: typeof o.conclusion === 'string' ? o.conclusion.toLowerCase() : null })
  }
  return out
}

const names = (rs: CheckRun[]) => rs.slice(0, 6).map(r => r.name).join(', ') + (rs.length > 6 ? `, +${rs.length - 6} more` : '')

const WHY = 'CLAUDE.md section 5: update a PR branch ONCE, when it is otherwise green and ready to merge; each update re-runs the full ~19-check CI set.'

/**
 * FAIL-OPEN BY DESIGN: this guard is advisory-strength. When the check runs cannot be read (MCP error,
 * unexpected shape, zero runs reported yet) it allows with a warning rather than block a legitimate
 * update because of our own plumbing. Only a readable list with a failing or unfinished run denies.
 */
export function decideUpdateBranch(runs: CheckRun[] | undefined, readError?: string): Decision {
  if (runs === undefined) {
    return { context: [`could not read this PR's check runs${readError ? ` (${readError})` : ''}: update-branch guard NOT CHECKED, update allowed. ${WHY}`] }
  }
  if (runs.length === 0) {
    return { context: [`the PR reports no check runs yet: update-branch guard NOT CHECKED, update allowed. ${WHY}`] }
  }
  const failing = runs.filter(r => r.status === 'completed' && r.conclusion !== null && BAD.has(r.conclusion))
  if (failing.length) {
    return { deny: `update-branch refused: ${failing.length} check(s) failing on the PR head (${names(failing)}). Fix them first. ${WHY}`, toast: `update-branch refused: ${failing.length} failing check(s)` }
  }
  // Not finished, or finished with no/unknown conclusion: never read as green (CI review on #1842).
  const pending = runs.filter(r => r.status !== 'completed' || r.conclusion === null || !OK.has(r.conclusion))
  if (pending.length) {
    return { deny: `update-branch refused: ${pending.length} check(s) still queued/in progress (${names(pending)}). Wait until they finish green. ${WHY}`, toast: `update-branch refused: ${pending.length} check(s) not finished` }
  }
  return {}
}

// ---------------------------------------------------------------------------------------------
// 4. batching nudge
// ---------------------------------------------------------------------------------------------

export const NUDGE_TEXT =
  'second push to this branch within 10 minutes: batch fixes into ONE push; each push re-runs the full CI set (~19 checks) on a CPU-bound runner.'

/** The nudge text when the previous push to the same branch was less than `windowMs` ago. */
export function nudgeFor(prevMs: number | undefined, nowMs: number, windowMs = NUDGE_WINDOW_MS): string | undefined {
  if (prevMs === undefined || !Number.isFinite(prevMs)) return undefined
  const age = nowMs - prevMs
  return age >= 0 && age < windowMs ? NUDGE_TEXT : undefined
}

/** Remember `key` at `nowMs`; drop entries older than an hour and cap the map. */
export function remember(map: Record<string, number> | undefined, key: string, nowMs: number): Record<string, number> {
  const kept = Object.entries(map ?? {}).filter(([k, t]) => k !== key && typeof t === 'number' && nowMs - t < 3_600_000)
  kept.sort((a, b) => b[1] - a[1])
  return Object.fromEntries([[key, nowMs], ...kept.slice(0, 49)])
}
