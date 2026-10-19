import { test, expect } from 'claude-code/testing'

import { receiptWritesInBash } from '../hooks/logic'

// LC-1735: six ways a command was judged exempt while bash really ran the writer. Every case below
// is a command the shell RUNS the writer in; each must be judged (1 write), never skipped.

const RUN = '896655cd-59e8-4f99-b127-6a275ab31e18'
const W = `python3 webflow/bulk-operations/refresh-receipt-writer/write_stage_receipt.py --run-id ${RUN} --stage 11 --part c5 --status pass`
const n = (cmd: string) => receiptWritesInBash(cmd).length

test('(a) a backslash anywhere means no exemption: the command is judged in full (fail closed)', () => {
  expect(n(`echo \\"; ${W} #"`)).toBe(1)
  expect(n(`echo \\'; ${W} #'`)).toBe(1)
  expect(n(`echo a\\"b; ${W}`)).toBe(1)
  expect(n(`echo "say \\"hi; ${W}\\"" > f`)).toBe(1) // a false positive on purpose: the escape is not modelled
  expect(n(`echo a\\; ${W} > f`)).toBe(1)
  expect(n(`echo \\" ; ${W} --help`)).toBe(1)
  // Without an escape, quotes just pair up and a real string is data.
  expect(n(`echo "plain; ${W}" > f`)).toBe(0)
})

test('(b) a heredoc operator inside a quoted string is not a heredoc', () => {
  expect(n(`cat "<<'EOF'"\n${W}\nEOF`)).toBe(1)
  expect(n(`cat '<<"EOF"'\n${W}\nEOF`)).toBe(1)
  expect(n(`echo "x <<'EOF'"; ${W}`)).toBe(1)
})

test('(c) a heredoc operator inside a # comment is not a heredoc', () => {
  expect(n(`cat x # <<'EOF'\n${W}\nEOF`)).toBe(1)
  expect(n(`cat x   #<<'EOF'\n${W}\nEOF`)).toBe(1)
  // Any `#` outside a heredoc body is unmodelled: no exemption. A `#` INSIDE a dropped body is just data.
  expect(n(`cat a#b <<'EOF'\n${W}\nEOF`)).toBe(1)
  expect(n(`cat > notes.md <<'EOF'\n# Title\n${W}\nEOF`)).toBe(0)
  expect(n(`cat > f <<'EOF'\n${W}\nEOF`)).toBe(0)
})

test('(d) a function or alias can shadow echo/printf: such a command is not plain', () => {
  expect(n(`echo() { ${W}; }; echo`)).toBe(1)
  expect(n(`echo () { ${W}; }; echo hi`)).toBe(1)
  expect(n(`function echo { ${W}; }; echo`)).toBe(1)
  expect(n(`printf() { ${W}; }; printf x`)).toBe(1)
  expect(n(`alias echo='${W}'; echo`)).toBe(1)
  expect(n(`PATH=./bin:$PATH; echo "${W}"`)).toBe(1)
})

test('(e) a redirect target named like a flag is not a flag', () => {
  expect(n(`${W} 2> --dry-run`)).toBe(1)
  expect(n(`${W} > --help`)).toBe(1)
  expect(n(`${W} >--help`)).toBe(1)
  expect(n(`${W} 2>--selftest`)).toBe(1)
  expect(n(`${W} < --help`)).toBe(1)
  // A real flag with a redirect elsewhere is still a help run.
  expect(n(`${W} --help > out.txt`)).toBe(0)
  expect(n(`${W} --dry-run 2>&1`)).toBe(0)
})

test('(f) only the writer itself (or echo/printf/cat/tee) can be exempt: any other interpreter is judged', () => {
  expect(n(`perl -e 'system("${W}")' -- --help`)).toBe(1)
  expect(n(`ruby -e 'system("${W}")' -- --dry-run`)).toBe(1)
  expect(n(`php -r 'system("${W}");' -- -h`)).toBe(1)
  expect(n(`env ${W} --help`)).toBe(1)
  expect(n(`time ${W} --dry-run`)).toBe(1)
  expect(n(`xargs ${W} --help`)).toBe(1)
  // The writer itself, with the usual prefixes, is the exemption.
  expect(n(`${W} --help`)).toBe(0)
  expect(n(`python3 -I ${W.replace('python3 ', '')} --dry-run`)).toBe(0)
  expect(n(`LC_ALL=C ${W} -h`)).toBe(0)
  expect(n(`./webflow/bulk-operations/refresh-receipt-writer/write_stage_receipt.py --help`)).toBe(0)
})

test('cat / tee / echo / printf segments only print or write text', () => {
  expect(n('cat webflow/bulk-operations/refresh-receipt-writer/write_stage_receipt.py')).toBe(0)
  expect(n(`printf '%s' '${W}' | cat`)).toBe(1) // a pipe makes the whole command not plain
  // The real call makes the command not exempt, so the cat that merely names the script is judged too (2, was 1).
  expect(n(`ls && cat webflow/bulk-operations/refresh-receipt-writer/write_stage_receipt.py && ${W}`)).toBe(2)
})

// ---- review of #1626 at c7cdeb1 (H1 / H2): a comment is not code, and its apostrophe is not a quote.

test('H1 an apostrophe or quote inside a # comment does not fuse the next line into an inert segment', () => {
  expect(n(`echo x # it's\n${W}`)).toBe(1)
  expect(n(`cat notes.md # don't\n${W}`)).toBe(1)
  expect(n(`printf x # can't\n${W} --note done`)).toBe(1)
  expect(n(`tee f </dev/null # can't\n${W}`)).toBe(1)
  expect(n(`echo ok # "x\n${W}`)).toBe(1)
  expect(n(`# note; echo it's done\n${W}`)).toBe(1)
  expect(n(`cat > f <<'EOF' # it's\nbody\nEOF\n${W}`)).toBe(1)
})

test('H1 text after # is judged (no comment parsing): a false positive, never a false negative', () => {
  expect(n(`ls # ${W}`)).toBe(1)
  expect(n(`# ${W}`)).toBe(1)
  expect(n(`echo hi # it's a note`)).toBe(0) // no writer named, nothing to judge
  expect(n(`${W} --summary "issue #12" --note a#b`)).toBe(1)
  expect(n(`${W} # then it's done`)).toBe(1)
})

test('H2 $\'...\' (ANSI-C) quoting is never plain: its backslash escapes a quote', () => {
  expect(n(`echo $'\\' '; ${W}; echo ' #'`)).toBe(1)
  expect(n(`echo $"x"; ${W}`)).toBe(1)
  expect(n(`echo $'a'; ${W}`)).toBe(1)
})

// ---- round 2 of the #1626 review: every character the code does not model removes the exemption.

test('R2 HIGH-1 comment / escape / expansion tricks that hid the writer in an inert segment', () => {
  expect(n(`echo a\\;#b; ${W}`)).toBe(1)
  expect(n('echo ${x:-;#}; ' + W)).toBe(1)
  expect(n('echo ${x#a #b}; ' + W)).toBe(1)
  expect(n(`echo a\\\n#b; ${W}`)).toBe(1)
  expect(n(`echo a\\\n#b\n${W}`)).toBe(1)
})

test('R2 HIGH-2 a comment inside a backtick substitution cannot hide the rest of the line', () => {
  expect(n('echo `echo a # b`; ' + W)).toBe(1)
  expect(n('echo $(echo a # b); ' + W)).toBe(1)
})

test('R2 each unmodelled character on its own removes the exemption', () => {
  for (const ch of ['#', '\\', '${x}', "$'a'", '$"a"', '`x`', '$(x)', '>(x)', '<(x)']) {
    expect(n(`echo ${ch}; ${W}`), ch).toBe(1)
    expect(n(`${W} --help ${ch}`), `help + ${ch}`).toBe(1)
  }
})

test('R2 the no-false-positive set stays exempt', () => {
  expect(n(`${W} --help`)).toBe(0)
  expect(n(`${W} --dry-run`)).toBe(0)
  expect(n(`echo "${W}"`)).toBe(0)
  expect(n(`cat > notes.md <<'EOF'\n${W}\nEOF`)).toBe(0)
  expect(n('cat claude-mods/run-state/hooks/logic.ts')).toBe(0)
  expect(n(`cat > notes.md <<'EOF'\n# Title\n\\ and \`ticks\` and $(x) in the body\n${W}\nEOF`)).toBe(0)
})
