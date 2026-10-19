import { test, expect } from 'claude-code/testing'

// LC-1734: a cat/tee heredoc body written to a file (a test that quotes the Webflow publish URL) is
// data and must not read as a publish attempt. The exemption is an ALLOW-LIST and fails closed: the
// command must be plain (no comment, escape or expansion the code does not model) AND every other step
// must be a cat/tee heredoc write or a short read-only / test-runner command. Anything else is judged
// whole, exactly as before. The guard only ever hooks Bash, SQL and Webflow tools: Write / Edit never
// reach it.

const URL_CALL = 'curl -X POST https://api.webflow.com/v2/sites/abc/publish -d {}'
const SQ = "curl -X POST 'https://api.webflow.com/v2/sites/x/publish'"
const passthrough = (on: any) =>
  on('tool.call', () => ({ result: { stdout: 'ran', stderr: '', interrupted: false }, text: 'ran' }) as any)
const bash = ($: any, command: string): Promise<any> => $.tool.call({ tool: 'Bash', command } as any)
const DENY = /^\[mod:refresh-run-guard\] /

test('a quoted-terminator cat/tee heredoc that only writes the URL into a file is allowed', async ($, on) => {
  passthrough(on)
  for (const cmd of [
    `cat > tests/x.test.ts <<'EOF'\n${URL_CALL}\nEOF`,
    `cat > tests/x.test.ts <<'EOF'\nconst c = '${URL_CALL}'\nEOF`,
    `cat > tests/x.test.ts <<"EOF"\n${URL_CALL}\nEOF`,
    `cat <<-'EOF' > f\n\t${URL_CALL}\n\tEOF`,
    `tee notes.md <<'DOC'\n${URL_CALL}\nDOC`,
    `tee tests/x.test.ts <<'EOF'\n${URL_CALL}\nEOF`,
    // Followed by the commands a test-writing session actually runs next.
    `cat > tests/x.test.ts <<'EOF'\n${URL_CALL}\nEOF\ngit add tests/x.test.ts`,
    `tee tests/x.test.ts <<'EOF'\n${URL_CALL}\nEOF\ngit add tests/x.test.ts`,
    `cat > tests/x.test.ts <<'EOF'\n${URL_CALL}\nEOF\nclaude plugin test run-state 2>&1`,
    `cat > tests/x.test.ts <<'EOF'\n${URL_CALL}\nEOF\nclaude plugin validate claude-mods/run-state`,
    `cat > f <<'EOF'\n${URL_CALL}\nEOF\ngit status\ngit diff\nls -la\ngrep -c publish f\nwc -l f`,
    // A markdown heading, a backslash or a backtick INSIDE the body is just data.
    `cat > notes.md <<'EOF'\n# Title\n${URL_CALL}\n\\ \`tick\` $(x)\nEOF`,
  ]) {
    const r = await bash($, cmd)
    expect(r.deny, cmd).toBeUndefined()
  }
})

test('Write / Edit / NotebookEdit never reach this guard, whatever the content quotes', async ($, on) => {
  passthrough(on)
  for (const tool of ['Write', 'Edit', 'NotebookEdit']) {
    const r: any = await $.tool.call({ tool, file_path: '/x/tests/a.test.ts', content: URL_CALL, new_string: URL_CALL } as any)
    expect(r.deny, tool).toBeUndefined()
  }
})

test('a real publish is still denied, however it follows a heredoc', async ($, on) => {
  passthrough(on)
  for (const cmd of [
    URL_CALL,
    `cat > f <<'EOF'\nx\nEOF\n${URL_CALL}`,
    `cat > f <<'EOF' && ${URL_CALL}\nx\nEOF`,
    `${URL_CALL} && cat > f <<'EOF'\nx\nEOF`,
  ]) {
    const r = await bash($, cmd)
    expect(r.deny, cmd).toMatch(DENY)
  }
})

test('text that can RUN is judged: unquoted bodies, interpreters, pipes, process substitution', async ($, on) => {
  passthrough(on)
  for (const cmd of [
    `cat > f <<EOF\n${URL_CALL}\nEOF`,
    `cat > f <<-EOF\n\t${URL_CALL}\n\tEOF`,
    `python3 - <<'EOF'\nimport os; os.system("${URL_CALL}")\nEOF`,
    `bash <<'EOF'\n${URL_CALL}\nEOF`,
    `cat <<'EOF' | bash\n${URL_CALL}\nEOF`,
    `tee >(bash) <<'EOF'\n${URL_CALL}\nEOF`,
    `cat > f <<'EOF' & ${URL_CALL}\nx\nEOF`,
    `cat > f <<'EOF'\n$(${URL_CALL})\nEOF\n${URL_CALL}`,
    `perl <<'EOF'\n${URL_CALL}\nEOF`,
    `ruby <<'EOF'\n${URL_CALL}\nEOF`,
    `node <<'EOF'\n${URL_CALL}\nEOF`,
    `ssh host <<'EOF'\n${URL_CALL}\nEOF`,
    `bash -c "$(cat <<'EOF'\n${URL_CALL}\nEOF\n)"`,
    `eval "$(cat <<'EOF'\n${URL_CALL}\nEOF\n)"`,
    `source <(cat <<'EOF'\n${URL_CALL}\nEOF\n)`,
    // An unclosed quote anywhere means the command is not understood, so nothing is dropped.
    `cat > f <<'EOF'\n${URL_CALL}\nEOF\necho "open`,
  ]) {
    const r = await bash($, cmd)
    expect(r.deny, cmd).toMatch(DENY)
  }
})

test('B a file written by a heredoc and RUN by any later step keeps its body judged (allow-list)', async ($, on) => {
  passthrough(on)
  const w = `cat > f.sh <<'EOF'\n${URL_CALL}\nEOF\n`
  for (const run of [
    'sh f.sh', 'bash f.sh', 'zsh f.sh', 'python3 p.py', 'node x.js', 'perl x.pl', './f.sh', '/tmp/f.sh', 'source f.sh', '. f.sh',
    // The review's bypass shapes: wrappers, compound commands, quoting tricks, runners, hooks.
    'timeout 5 sh f.sh', 'sudo bash f.sh', 'env sh f.sh', 'time ./f.sh', 'FOO=1 bash f.sh', 'nohup sh f.sh',
    'if true; then sh f.sh; fi', '{ sh f.sh; }', '(sh f.sh)', '"sh" f.sh', 's\\h f.sh', 'x="sh f.sh"; $x',
    'npm run p', 'make test', 'git commit -m done', 'git push', 'git -c core.hooksPath=h add f', 'echo done', 'xargs sh f.sh',
  ]) {
    const r = await bash($, w + run)
    expect(r.deny, run).toMatch(DENY)
  }
})

test('H1 / HIGH-2 comments are never parsed: an apostrophe or a backtick cannot hide a later publish', async ($, on) => {
  passthrough(on)
  for (const cmd of [
    `cat f # it's\n${SQ}`,
    `echo hi # don't\n${URL_CALL}`,
    `ls # can't\ncat g\n${SQ}`,
    `# it's\n${URL_CALL}`,
    `cat f # it's\n${SQ} | tee out`,
    `echo hi # don't\n${URL_CALL} | cat`,
    'echo `echo a # b`; ' + URL_CALL,
    'echo $(echo a # b); ' + URL_CALL,
    // Comment text is judged like any other text (a false positive on purpose).
    `ls # ${URL_CALL}`,
    `# ${URL_CALL}`,
    // A `#` in a URL is not a comment.
    `curl -X POST https://api.webflow.com/v2/sites/a#b/publish`,
  ]) {
    const r = await bash($, cmd)
    expect(r.deny, cmd).toMatch(DENY)
  }
})

test('round 3 A: a backslash outside quotes escapes the next character (ordinary shell quoting must not hide a publish)', async ($, on) => {
  passthrough(on)
  const PUB = 'https://api.webflow.com/v2/sites/x/publish'
  for (const cmd of [
    `echo 'don'\\''t stop'; curl -X POST ${PUB} -H 'Authorization: Bearer t'`,
    `echo 'it'\\''s'\ncurl -X POST ${PUB} -d '{"a":1}'`,
    `jq -r '.name == "it'\\''s"' x.json; curl -X POST ${PUB} -H 'X: y'`,
    `echo don\\'t; curl -X POST ${PUB} -H 'X: y'`,
    `echo "say \\"hi\\""; curl -X POST ${PUB} -H 'X: y'`,
  ]) {
    const r = await bash($, cmd)
    expect(r.deny, cmd).toMatch(DENY)
  }
})

test('round 3 belt and braces: an apostrophe inside a heredoc body cannot hide a later publish', async ($, on) => {
  passthrough(on)
  const PUB = 'https://api.webflow.com/v2/sites/x/publish'
  for (const cmd of [
    `cat > n.md <<'EOF'\nit's here\nEOF\ncurl -X POST ${PUB} -H 'A: b'`,
    `git commit -F - <<'EOF'\nfix: don't\nEOF\ncurl -X POST ${PUB} -H 'A: b'`,
    `git commit -F - <<EOF\nfix: don't\nEOF\ncurl -X POST ${PUB} -H 'A: b'`,
    `tee n.md <<'EOF'\nit's here\nEOF\nnode x.js\ncurl -X POST ${PUB} -H 'A: b'`,
    // The body itself publishes (an interpreter runs it): still denied through the raw view.
    `python3 - <<'EOF'\nimport os; os.system("${URL_CALL}")\nEOF\nls`,
  ]) {
    const r = await bash($, cmd)
    expect(r.deny, cmd).toMatch(DENY)
  }
  // The exemption itself is unchanged: a test file that merely quotes the URL, an apostrophe in the body included.
  const ok = await bash($, `cat > t.test.ts <<'EOF'\nit's a test of ${URL_CALL}\nEOF\ngit add t.test.ts`)
  expect(ok.deny).toBeUndefined()
})

test('round 3 B: a heredoc that writes into .git (hooks, config, attributes) keeps its body judged', async ($, on) => {
  passthrough(on)
  for (const target of ['.git/hooks/pre-commit', '.git/config', '.gitattributes', './.git/config', 'sub/.git/hooks/x', '/abs/.git/config',
    '~/.gitconfig', '"$GIT_DIR/config"', '$GIT_DIR/config', '.gitmodules']) {
    for (const next of ['git status', 'git add -A', 'git diff']) {
      const r = await bash($, `cat > ${target} <<'EOF'\n${URL_CALL}\nEOF\n${next}`)
      expect(r.deny, `${target} / ${next}`).toMatch(DENY)
      const t = await bash($, `tee ${target} <<'EOF'\n${URL_CALL}\nEOF\n${next}`)
      expect(t.deny, `tee ${target} / ${next}`).toMatch(DENY)
    }
  }
  // An ordinary target next to .git-named files in the same repo stays allowed.
  const ok = await bash($, `cat > tests/gitlike.test.ts <<'EOF'\n${URL_CALL}\nEOF\ngit add tests/gitlike.test.ts`)
  expect(ok.deny).toBeUndefined()
})

test('H2 $\'...\' (ANSI-C) quoting: its escaped quote must not hide a publish', async ($, on) => {
  passthrough(on)
  const r = await bash($, `echo $'\\' '; ${URL_CALL}; echo ' #'`)
  expect(r.deny).toMatch(DENY)
})

test('a heredoc operator hidden in a string or comment, or never terminated, is not a heredoc', async ($, on) => {
  passthrough(on)
  for (const cmd of [
    `cat "<<'EOF'"\n${URL_CALL}\nEOF`,
    `cat x # <<'EOF'\n${URL_CALL}\nEOF`,
    `cat > f <<'EOF'\n${URL_CALL}\n`,
    `echo \\"; ${URL_CALL} #"`,
    // An escaped quote before a real heredoc: the backslash alone removes the exemption (fail closed).
    `echo \\" ; cat > f <<'EOF'\n${URL_CALL}\nEOF`,
  ]) {
    const r = await bash($, cmd)
    expect(r.deny, cmd).toMatch(DENY)
  }
})
