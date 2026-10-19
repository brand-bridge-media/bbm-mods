import { test, expect } from 'claude-code/testing'

import { hasSkip, parsePushes, resolveDir, splitCommands, trimLines } from '../hooks/logic'

// What counts as a push (LC-1846). The choice for `echo "git push"`: NOT a push, because commands are
// split and tokenised with quotes removed and only the program word (`git`) is examined.

const isPush = (c: string) => parsePushes(c).length > 0

test('plain pushes match', async () => {
  for (const c of ['git push', 'git push origin lc1846-x', 'git push -u origin HEAD', 'git push --force-with-lease origin b',
    'git -C /work/repo push', 'git -c core.x=1 push', 'git --no-pager push', 'cd /work/repo && git push', 'git add . && git commit -m x && git push -u origin b',
    'FOO=1 git push', 'env GIT_SSH=ssh git push', 'git push\n', 'true; git push', 'git push origin +b', 'bash -c "git push origin b"', 'sh -c \'cd /x && git push\'']) {
    expect(isPush(c)).toBe(true)
  }
})

test('things that are not a push', async () => {
  for (const c of ['git status', 'git pull', 'git commit -m "git push later"', 'echo "git push"', "echo 'git push origin x'", 'grep "git push" CLAUDE.md',
    'cat notes.md # git push', 'git log --grep push', 'gh pr create', 'git stash push -m x'.replace('stash push', 'stash save'), 'git remote add push-origin url']) {
    expect(isPush(c)).toBe(false)
  }
})

test('--dry-run, --delete and delete refspecs are ignored', async () => {
  for (const c of ['git push --dry-run', 'git push -n origin b', 'git push --dry-run origin b', 'git push --delete origin b', 'git push -d origin b',
    'git push origin :b', 'git -C x push --dry-run', 'git push -fn origin b']) {
    expect(isPush(c)).toBe(false)
  }
})

test('git -C and cd set the directory; the branch comes from the refspec', async () => {
  expect(parsePushes('git -C /work/repo push')[0]).toMatchObject({ dir: '/work/repo', isDirUnresolved: false })
  expect(parsePushes('git -C a -C b push')[0]?.dir).toBe('a/b')
  expect(parsePushes('cd /work && cd repo && git push')[0]?.dir).toBe('/work/repo')
  expect(parsePushes('git push')[0]?.dir).toBeUndefined()
  expect(parsePushes('git push origin HEAD:refs/heads/feat-1')[0]?.branch).toBe('feat-1')
  expect(parsePushes('git push -u origin feat-2')[0]?.branch).toBe('feat-2')
  expect(parsePushes('git push origin HEAD')[0]?.branch).toBeUndefined()
  expect(parsePushes('git -C "$REPO" push')[0]?.isDirUnresolved).toBe(true)
  expect(parsePushes('cd ~/x && git push')[0]?.isDirUnresolved).toBe(true)
})

test('two pushes in one command are both found', async () => {
  expect(parsePushes('git push origin a && git -C ../o push origin b').length).toBe(2)
})

test('splitCommands honours quotes and separators', async () => {
  expect(splitCommands('a "b && c" d && e | f; g')).toEqual([['a', 'b && c', 'd'], ['e'], ['f'], ['g']])
  expect(resolveDir('/a/b', '../c')).toBe('/a/c')
  expect(resolveDir(undefined, 'x/./y')).toBe('x/y')
})

test('PREFLIGHT_SKIP=1 is recognised as a word, not inside another name', async () => {
  expect(hasSkip('PREFLIGHT_SKIP=1 git push')).toBe(true)
  expect(hasSkip('git push && echo x; PREFLIGHT_SKIP=1 git push')).toBe(true)
  expect(hasSkip('git push')).toBe(false)
  expect(hasSkip('MY_PREFLIGHT_SKIP=1 git push')).toBe(false)
  expect(hasSkip('PREFLIGHT_SKIP=10 git push')).toBe(false)
  expect(hasSkip('PREFLIGHT_SKIP=0 git push')).toBe(false)
})

test('trimLines keeps head and the summary tail', async () => {
  const text = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n')
  const t = trimLines(text, 40).split('\n')
  expect(t.length).toBe(40)
  expect(t[0]).toBe('line 0')
  expect(t[t.length - 1]).toBe('line 99')
  expect(t.some(l => l.includes('lines trimmed'))).toBe(true)
  expect(trimLines('a\nb', 40)).toBe('a\nb')
})
