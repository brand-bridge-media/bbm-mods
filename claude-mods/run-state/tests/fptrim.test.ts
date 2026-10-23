import { expect } from 'claude-code/testing'
import { test } from './slow'

import { receiptWritesInBash } from '../hooks/logic'

// LC-1739, cut to the minimum after review: the precise risky-target rule (a `.git` COMPONENT, globs and quotes in a
// target, XDG git config, git hook names) plus two exact step forms (`git commit -m`, `mkdir -p`)
// next to a text write. Everything else that runs or edits files (head, tail, sed, test, chmod, mv, git push, gh,
// bun/npm test, make) asks, as on main.

const RUN = '896655cd-59e8-4f99-b127-6a275ab31e18'
const W = `python3 webflow/bulk-operations/refresh-receipt-writer/write_stage_receipt.py --run-id ${RUN} --stage 11 --part c5 --status pass`
const n = (cmd: string) => receiptWritesInBash(cmd).length
const body = (target = 'n.md') => `cat > ${target} <<'EOF'\n${W}\nEOF\n`

// The kept step forms, each of which must be exempt after a text write.
const KEPT = [
  "git commit -m 'docs: add notes (a); b'",
  'git commit -m docs',
  'git commit -a -m docs',
  "git commit -am 'docs'",
  'git add n.md && git commit -m docs',
  'mkdir -p docs/sub',
  'grep -r --include=f.sh x .',
  'ls --color=never',
  'git add n.md',
  'git status',
  'git diff',
  'ls -la',
  'grep -c stage n.md',
  'wc -l n.md',
]

test('EXEMPT: every kept step form follows a text write', () => {
  for (const next of KEPT) {
    expect(n(body() + next), next).toBe(0)
  }
  expect(n(`mkdir -p docs && cat > docs/n.md <<'EOF'\n${W}\nEOF`)).toBe(0)
  expect(n(`mkdir -p docs && cat > docs/n.md <<'EOF'\n${W}\nEOF\ngit add docs/n.md && git commit -m docs`)).toBe(0)
})

test('WRITE: cd is gone, so a write after it is judged (its real directory is unknown)', () => {
  const cfg = `[core]\n\tfsmonitor = ./write_stage_receipt.py --stage 3`
  for (const c of [
    `cd ../.config/git && cat > config <<'EOF'\n${cfg}\nEOF\ncd ../../repo && git status`,
    `cd /home/u/.config/git && cat > config <<'EOF'\n${cfg}\nEOF\ngit status`,
    `mkdir -p ../.config/git && cd ../.config/git && cat > config <<'EOF'\n${cfg}\nEOF\ncd - && git status`,
    `cd ../.git/info && cat > attributes <<'EOF'\n* diff=x\n${W}\nEOF\ngit status`,
    `cd docs && cat > n.md <<'EOF'\n${W}\nEOF`,
    `cd docs && cat > n.md <<'EOF'\n${W}\nEOF\ngit add n.md && git commit -m docs`,
    `cd docs; ${W}`,
  ]) {
    expect(n(c), c.slice(0, 40)).toBeGreaterThan(0)
  }
})

test('EXEMPT: ordinary files whose names merely start with .git are not risky targets', () => {
  for (const target of ['.gitignore', '.gitkeep', '.github/workflows/ci.yml', 'docs/.gitkeep', 'a/.gitignore', 'git-notes.md', 'x.git.md', 'docs/updates.md', 'docs/precommit-notes.md']) {
    expect(n(body(target) + 'git add -A'), `cat ${target}`).toBe(0)
    expect(n(`tee ${target} <<'EOF'\n${W}\nEOF\ngit status`), `tee ${target}`).toBe(0)
    expect(n(`echo "${W}" > ${target}; git status`), `echo ${target}`).toBe(0)
  }
})

test('EXEMPT: only the TARGET is checked, never the text being written', () => {
  expect(n(`echo "${W} .git/config" > notes.txt; git status`)).toBe(0)
  expect(n(`echo "${W} $HOME/.config/git/config $X" > notes.txt; git status`)).toBe(0)
  expect(n(`cat > notes.md <<'EOF'\n${W} .git/hooks/pre-commit\n$(x) \`y\` .g*t\nEOF\ngit add notes.md`)).toBe(0)
})

test('WRITE: a target the shell assembles or that git reads as configuration is judged', () => {
  for (const target of [
    '.g*t/config', '".g"it/config', "'.'git/config", '.?it/config', '.[g]it/config', '.g?t/hooks/pre-commit',
    '~/.config/git/config', '$HOME/.config/git/config', '.config/git/config',
    '.git/config', '.git/hooks/pre-commit', './.git/config', 'sub/.git/hooks/x', '.git',
    '~/.gitconfig', '.gitattributes', '.gitmodules', '$GIT_DIR/config', '"$GIT_DIR/config"',
  ]) {
    for (const next of ['git status', 'git add -A', 'git diff']) {
      expect(n(body(target) + next), `cat ${target} / ${next}`).toBeGreaterThan(0)
      expect(n(`tee ${target} <<'EOF'\n${W}\nEOF\n${next}`), `tee ${target} / ${next}`).toBeGreaterThan(0)
      expect(n(`echo "${W}" > ${target}; ${next}`), `echo ${target} / ${next}`).toBeGreaterThan(0)
    }
  }
})

test('WRITE: a target named for any git hook, or inside a hooks dir, is judged (git commit runs them)', () => {
  for (const hook of ['pre-commit', 'commit-msg', 'post-rewrite', 'pre-merge-commit', 'applypatch-msg', 'pre-push', 'post-checkout', 'reference-transaction', 'fsmonitor-watchman', 'h/pre-commit', 'h/post-rewrite', 'hooks/foo', 'a/hooks/b']) {
    expect(n(body(hook) + "git commit -m 'x'"), hook).toBeGreaterThan(0)
  }
})

test('WRITE: the clobber redirect >| and process-substitution targets are judged', () => {
  expect(n(`cat >| .git/hooks/pre-commit <<'EOF'\n${W}\nEOF\ngit status`), 'cat >| hook').toBeGreaterThan(0)
  expect(n(`echo "${W}" >|.git/config; git status`), 'echo >|.git/config').toBeGreaterThan(0)
  expect(n(`echo "${W}" >|pre-commit; git commit -m x`), 'echo >|pre-commit').toBeGreaterThan(0)
  expect(n(`cat > >(sh) <<'EOF'\n${W}\nEOF`)).toBeGreaterThan(0)
  expect(n(`tee >(sh) <<'EOF'\n${W}\nEOF`)).toBeGreaterThan(0)
})

test('WRITE: the dropped steps ask again, as on main', () => {
  for (const next of [
    'head n.md', 'tail -5 n.md', "sed -n '1,5p' n.md", 'sed -n 3p n.md', "sed -n '1p' -e e./f.sh n.md",
    'test -f n.md', '[ -f n.md ]', 'chmod 644 n.md', 'chmod 0600 n.md', 'mv n.md notes.md', 'mv -f n.md docs/', 'mv n.md f.sh',
    '/usr/bin/git status', '/bin/git add n.md',
  ]) {
    expect(n(body() + next), next).toBeGreaterThan(0)
  }
})

test('WRITE: steps that run arbitrary repo code stay out of the allow-list', () => {
  for (const next of [
    'git push', 'git push origin main', 'gh pr create --body-file n.md', 'bun test', 'npm test', 'npm run test', 'make', 'make test',
    'git commit', 'git commit -a', 'git commit --amend', 'git commit -F msg.txt', 'git commit -m "double quoted"', "git commit -m 'a' -m 'b'",
    "git commit -m 'a' --amend", 'git commit -m a b', "git -c core.hooksPath=h commit -m x", 'git config core.fsmonitor ./f.sh',
    'git log', 'git log --oneline -5', 'git log --output=.git/hooks/pre-commit', 'git diff --output=f.sh', 'git diff --output f.sh', 'git log --output f.sh', 'git add --chmod=+x f.sh', 'git add --chmod +x f.sh',
    'mkdir -p .git/hooks', 'mkdir -p docs/.git/x', 'cd', 'cd docs', 'cd .git', 'cd ../.git/hooks', 'mkdir -p docs sub', 'mkdir docs', 'cd ~', 'cd $HOME',
    'test -f n.md || sh f.sh', 'cd docs && sh f.sh', 'mkdir -p docs && sh f.sh',
  ]) {
    expect(n(body() + next), next).toBeGreaterThan(0)
  }
})

test('WRITE: each kept form with a substitution, pipe, redirect, group or chain appended or embedded is judged', () => {
  const evil = ['$(sh f.sh)', '`sh f.sh`', '| sh', '> f.sh', '>> f.sh', '<(sh f.sh)', '; sh f.sh', '& sh f.sh', '&& sh f.sh', '{ sh f.sh; }']
  for (const kept of KEPT) {
    for (const e of evil) {
      expect(n(body('f.sh') + `${kept} ${e}`), `${kept} ${e}`).toBeGreaterThan(0)
      const [first, ...rest] = kept.split(' ')
      expect(n(body('f.sh') + [first, e, ...rest].join(' ')), `${first} ${e} ...`).toBeGreaterThan(0)
    }
  }
})

test('WRITE: a substitution inside double quotes, or an unclosed quote, in a print step is judged', () => {
  for (const next of [
    'echo "$(sh f.sh)" > out.txt', 'printf "$(sh f.sh)"', 'cat "$(sh f.sh)"', 'echo "`sh f.sh`" > out.txt', 'cat $(sh f.sh)', 'cat `sh f.sh`',
    'echo "unclosed $(sh f.sh) > out.txt', "echo 'unclosed `sh f.sh` > out.txt", 'echo "a" "$(sh f.sh)"',
    'echo done & sh f.sh', 'echo hi | sh f.sh', 'echo hi | sh', 'cat n.md | sh', 'printf x & ./f.sh',
    'echo done; sh f.sh', 'echo done && sh f.sh', 'echo hi > g.txt & sh f.sh', 'echo $(sh f.sh) > out.txt',
  ]) {
    expect(n(body('f.sh') + next), next).toBeGreaterThan(0)
  }
  expect(n(`tee f.sh <<'EOF' | sh\n${W}\nEOF`)).toBeGreaterThan(0)
  expect(n(`${W} --help & sh f.sh`)).toBeGreaterThan(0)
  // Long malformed input must not stall the scan.
  const t0 = Date.now()
  n(body('f.sh') + 'echo "' + '$(a) "\''.repeat(5000))
  expect(Date.now() - t0).toBeLessThan(2000)
})

test('the allow-list additions do not excuse a real writer call', () => {
  expect(n(`git add n.md && git commit -m docs && ${W}`)).toBe(1)
  expect(n(`mkdir -p docs && ${W}`)).toBe(1)
})
