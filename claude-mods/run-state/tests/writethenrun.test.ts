import { expect } from 'claude-code/testing'
import { test } from './slow'

import { receiptWritesInBash } from '../hooks/logic'

// LC-1736: text written to a FILE (a cat/tee heredoc body, an echo/printf redirect) is data only if
// nothing later runs that file. Naming the ways to run a file is a losing game, so the command is
// exempt only when the shell is plain AND every step is on a short allow-list; any other step and the
// whole command (bodies and payloads included) is judged.

const RUN = '896655cd-59e8-4f99-b127-6a275ab31e18'
const W = `python3 webflow/bulk-operations/refresh-receipt-writer/write_stage_receipt.py --run-id ${RUN} --stage 11 --part c5 --status pass`
const BARE = './write_stage_receipt.py --stage 3'
const n = (cmd: string) => receiptWritesInBash(cmd).length

test('a heredoc-written script that a later step runs is judged, however it is run', () => {
  const w = (body: string) => `cat > f.sh <<'EOF'\n${body}\nEOF\n`
  for (const body of [BARE, W]) {
    for (const run of [
      'sh f.sh', 'bash f.sh', './f.sh', 'timeout 5 sh f.sh', 'nohup sh f.sh', '( sh f.sh )', 'if true; then sh f.sh; fi',
      'x="sh f.sh"; $x', 'python3 p.py', '{ sh f.sh; }', '"sh" f.sh', 'source f.sh', '. f.sh', 'env sh f.sh', 'xargs sh f.sh',
      'npm run p', 'git push', 'make test', // (git commit -m is allow-listed since LC-1739; see fptrim.test.ts)
    ]) {
      expect(n(w(body) + run), run).toBeGreaterThan(0)
    }
  }
})

test('an echo / printf payload written to a file that a later step runs is judged', () => {
  expect(n(`echo "${W}" > run.sh; bash run.sh`)).toBeGreaterThan(0)
  expect(n(`echo "${W}" >> run.sh\nsh run.sh`)).toBeGreaterThan(0)
  expect(n(`printf '%s' '${W}' > run.sh && ./run.sh`)).toBeGreaterThan(0)
  expect(n(`echo "${W}" > run.sh; timeout 5 sh run.sh`)).toBeGreaterThan(0)
})

test('tee as the writer is judged the same way', () => {
  expect(n(`tee run.sh <<'EOF'\n${BARE}\nEOF\nsh run.sh`)).toBeGreaterThan(0)
  expect(n(`tee run.sh <<'EOF'\n${W}\nEOF\npython3 p.py`)).toBeGreaterThan(0)
})

test('a file written into .git (a hook, a config) or via a variable keeps the body judged even with git neighbours', () => {
  for (const target of ['.git/hooks/pre-commit', '.git/config', '.gitattributes', './.git/config', 'sub/.git/x', '~/.gitconfig', '$GIT_DIR/config', '"$GIT_DIR/config"']) {
    for (const next of ['git status', 'git add -A', 'git diff']) {
      expect(n(`cat > ${target} <<'EOF'\n${W}\nEOF\n${next}`), `cat ${target} / ${next}`).toBeGreaterThan(0)
      expect(n(`tee ${target} <<'EOF'\n${W}\nEOF\n${next}`), `tee ${target} / ${next}`).toBeGreaterThan(0)
      expect(n(`echo "${W}" > ${target}; ${next}`), `echo ${target} / ${next}`).toBeGreaterThan(0)
    }
  }
})

test('tee into .git with input redirected from a file is a write too (the other step then carries the writer text)', () => {
  expect(n(`tee .git/hooks/pre-commit < in.txt; echo "${W}"`)).toBeGreaterThan(0)
  expect(n(`tee $GIT_DIR/config < in.txt; echo "${W}"`)).toBeGreaterThan(0)
  // `2>&1` is a descriptor copy, not a file write: a `$` in a print-only step is fine.
  expect(n(`echo "${W} $HOME" 2>&1`)).toBe(0)
  expect(n(`echo "${W} $HOME" > $HOME/notes.txt`)).toBeGreaterThan(0)
})

test('a help / dry-run step does not excuse an unlisted step next to it', () => {
  expect(n(`${W} --help; sh x.sh`)).toBeGreaterThan(0)
  expect(n(`${W} --dry-run && python3 p.py`)).toBeGreaterThan(0)
})

test('MUST STAY EXEMPT: print-only, file-writing text, help / dry-run, and the allow-listed neighbours', () => {
  expect(n(`${W} --help`)).toBe(0)
  expect(n(`${W} --dry-run`)).toBe(0)
  expect(n(`echo "${W}"`)).toBe(0)
  expect(n(`cat > notes.md <<'EOF'\n${W}\nEOF`)).toBe(0)
  expect(n(`cat > notes.md <<'EOF'\n${W}\nEOF\ngit add notes.md`)).toBe(0)
  expect(n('cat claude-mods/run-state/hooks/logic.ts')).toBe(0)
  expect(n(`cat > notes.md <<'EOF'\n# Title\n${W}\nEOF`)).toBe(0)
  expect(n(`tee notes.md <<'EOF'\n${W}\nEOF\ngit status\ngit diff`)).toBe(0)
  expect(n(`echo "${W}" > notes.txt`)).toBe(0)
  expect(n(`echo "${W}" > notes.txt; git add notes.txt`)).toBe(0)
  expect(n(`printf '%s' '${W}' > notes.txt && ls -la`)).toBe(0)
  expect(n(`cat > t.test.ts <<'EOF'\n${W}\nEOF\nclaude plugin test run-state 2>&1`)).toBe(0)
  expect(n(`cat > t.test.ts <<'EOF'\n${W}\nEOF\nclaude plugin validate claude-mods/run-state`)).toBe(0)
  expect(n(`cat > t.test.ts <<'EOF'\n${W}\nEOF\ngrep -c stage t.test.ts\nwc -l t.test.ts`)).toBe(0)
  expect(n(`${W} --help; ls`)).toBe(0)
  expect(n(`cat > t.test.ts <<'EOF'\n${W}\nEOF\ngit add t.test.ts && git status`)).toBe(0)
})

test('a real invocation is still judged, alone or with an allow-listed neighbour', () => {
  expect(n(W)).toBe(1)
  expect(n(`${W}; ls`)).toBe(1)
  expect(n(`git status && ${W}`)).toBe(1)
})
