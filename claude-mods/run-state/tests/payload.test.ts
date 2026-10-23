import { expect, mock } from 'claude-code/testing'
import { test } from './slow'

import { receiptWritesInBash } from '../hooks/logic'

// LC-1711: ONE rule, not a shell parser. A script name sitting in text that is merely written to a
// file, or a --help / --dry-run run, is exempt ONLY when the whole command is plain. Anything with a
// pipe, a background &, a substitution, a process substitution, eval/source/., an interpreter fed
// code, or an unclosed quote is not plain and is judged exactly as if no exemption existed.

const RUN = '896655cd-59e8-4f99-b127-6a275ab31e18'
const W = `python3 webflow/bulk-operations/refresh-receipt-writer/write_stage_receipt.py --run-id ${RUN} --stage 11 --part c5 --status pass`
const n = (cmd: string) => receiptWritesInBash(cmd).length

test('plain commands: quoted-terminator heredoc bodies and print payloads are data', () => {
  expect(n(`cat > tests/x.test.ts <<'EOF'\nconst cmd = '${W}'\nEOF`)).toBe(0)
  expect(n(`cat > tests/x.test.ts <<"EOF"\n${W}\nEOF`)).toBe(0)
  expect(n(`cat <<-'EOF' > f\n\t${W}\n\tEOF`)).toBe(0)
  expect(n(`tee notes.md <<'DOC'\n${W}\nDOC`)).toBe(0)
  expect(n(`cat > f <<'EOF'\n${W}\nEOF\nclaude plugin test run-state 2>&1`)).toBe(0)
  expect(n(`echo "${W}" > notes.txt`)).toBe(0)
  expect(n(`printf '%s' '${W}' >> notes.txt`)).toBe(0)
  expect(n(`echo "first; ${W}" > notes.txt`)).toBe(0)
  expect(n(`echo "a && ${W}" > notes.txt`)).toBe(0)
})

test('plain commands: --help, -h, --dry-run and --selftest run nothing', () => {
  expect(n(`${W} --help`)).toBe(0)
  expect(n(`${W} -h`)).toBe(0)
  expect(n(`${W} --dry-run`)).toBe(0)
  expect(n(`${W} --selftest`)).toBe(0)
})

test('the reviewer\'s --help / -h bypasses are judged: a pipe, a background &, a pipe into cat', () => {
  expect(n(`${W} | grep -h ok`)).toBe(1)
  expect(n(`${W} & ls -h`)).toBe(1)
  expect(n(`${W} | cat --help`)).toBe(1)
  expect(n(`${W} --dry-run | bash`)).toBe(1)
})

test('the reviewer\'s echo / printf bypasses are judged', () => {
  expect(n(`echo a & ${W}`)).toBe(1)
  expect(n(`echo "${W}" > >(bash)`)).toBe(1)
  expect(n(`echo "${W}" | bash`)).toBe(1)
  expect(n(`echo "$(${W})"`)).toBe(1)
  expect(n(`echo \`${W}\``)).toBe(1)
})

test('the reviewer\'s heredoc bypasses are judged: unquoted bodies expand, process substitution runs', () => {
  expect(n(`cat > f <<EOF\n$(${W})\nEOF`)).toBe(1)
  expect(n(`cat > f <<EOF\n\`${W}\`\nEOF`)).toBe(1)
  expect(n(`tee >(bash) <<EOF\n${W}\nEOF`)).toBe(1)
  expect(n(`tee >(bash) <<'EOF'\n${W}\nEOF`)).toBe(1)
  // An unquoted terminator is never exempt, even when the body looks like plain text.
  expect(n(`cat > f <<EOF\n${W}\nEOF`)).toBe(1)
  expect(n(`cat > f <<-EOF\n\t${W}\n\tEOF`)).toBe(1)
})

test('interpreters fed code, eval/source and chained invocations are judged', () => {
  expect(n(`bash <<'EOF'\n${W}\nEOF`)).toBe(1)
  expect(n(`python3 - <<'EOF'\nimport os; os.system("${W}")\nEOF`)).toBe(1)
  expect(n(`perl <<'EOF'\n${W}\nEOF`)).toBe(1)
  expect(n(`cat <<'EOF' | bash\n${W}\nEOF`)).toBe(1)
  expect(n(`bash -c "${W}"`)).toBe(1)
  expect(n(`/bin/bash -c "${W}"`)).toBe(1)
  expect(n(`cat > run.sh <<'EOF'\nx\nEOF\n${W}`)).toBe(1)
  expect(n(`sh -c '${W}'`)).toBe(1)
  expect(n(`python3 -c "import os; os.system('${W}')"`)).toBe(1)
  expect(n(`eval "${W}"`)).toBe(1)
  expect(n(`source ./cmds.sh; ${W}`)).toBe(1)
})

test('a script written by a quoted heredoc and run in a later step is judged (LC-1736 closed the old known limit)', () => {
  expect(n(`cat > run.sh <<'EOF'\n${W}\nEOF\nbash run.sh`)).toBe(1)
})

test('what a plain-looking echo wrote can still be RUN by eval, source, . or an interpreter: judged', () => {
  expect(n(`echo "${W}" > f; source f`)).toBe(1)
  expect(n(`echo "${W}" > f; . ./f`)).toBe(1)
  expect(n(`echo "${W}" > f; eval bash f`)).toBe(1)
  expect(n(`echo "${W}" > f; bash < f`)).toBe(1)
  expect(n(`echo "${W}" > f; python3 - < f`)).toBe(1)
  expect(n(`echo "${W}" > f; /bin/sh -c "sh f"`)).toBe(1)
  // A file merely NAMED like an interpreter is not one.
  expect(n(`echo "${W}" > run.sh`)).toBe(0)
})

test('a real invocation still counts, however it is chained', () => {
  expect(n(W)).toBe(1)
  expect(n(`ls && ${W}`)).toBe(1)
  expect(n(`echo hi; ${W}`)).toBe(1)
  expect(n(`cat > f <<'EOF'\nx\nEOF\n${W}`)).toBe(1)
  expect(n(`cat > f <<'EOF' && ${W}\nx\nEOF`)).toBe(1)
  expect(n(`echo done > log.txt && ${W}`)).toBe(1)
})

test('fail closed: an unterminated heredoc or an unclosed quote exempts nothing', () => {
  expect(n(`cat > f <<'EOF'\n${W}\n`)).toBe(1)
  expect(n(`echo "oops; ${W}`)).toBe(1)
  expect(n(`${W} --summary "blocked -h`)).toBe(1)
  expect(n(`${W} --summary 'blocked --help`)).toBe(1)
})

test('the guard does not ask about a test file that only quotes the script (all read paths dead)', async ($, on) => {
  mock.store(on)
  mock.clock(on, { now: Date.parse('2026-10-07T12:00:00Z') })
  mock.env(on, {})
  on('mcp.call', () => { throw new Error('no connected MCP tool') })
  const asked: string[] = []
  let ran = 0
  on('tool.call', (_$: any, e: any) => {
    if (e.tool === 'AskUserQuestion') { asked.push(JSON.stringify(e)); return { result: { answers: {} }, text: 'Refuse' } as any }
    ran += 1
    return { result: 'ok', text: 'ok' } as any
  })
  await $.tool.call({ tool: 'Bash', command: `cat > tests/x.test.ts <<'EOF'\n${W}\nEOF\nclaude plugin test run-state` } as any)
  expect(asked.length).toBe(0)
  expect(ran).toBe(1)
  // The same shape with an expanding terminator is judged and asked about.
  await $.tool.call({ tool: 'Bash', command: `cat > f <<EOF\n$(${W})\nEOF` } as any)
  expect(asked.length).toBe(1)
  expect(ran).toBe(1)
})
