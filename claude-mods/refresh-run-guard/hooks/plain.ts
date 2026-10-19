// A COPY of run-state's "plain command" test (claude-mods/run-state/hooks/logic.ts, LC-1711/LC-1735):
// the same code in a plugin of its own, because a mod loads from its own folder and cannot import a
// sibling's (nor can a test). The CI gate `ci_gates.py parity` compares the block between the markers
// below in both files and fails the PR if they differ, so a fix made in one cannot silently miss the other.
//
// What it is for here (LC-1734): a heredoc BODY that cat/tee writes to a file is data, so a test file
// that merely quotes the Webflow publish URL must not read as a publish attempt. Everything else about
// the command, and every command that is not plain, is judged exactly as before.

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
