import { test, expect, mock } from 'claude-code/testing'

import { ADOPT_HEAD_MS, decide, findPr, prNumberFrom, LONG_MS, MAX_ERRORS, NO_CHECKS_MS, parseCheckRuns, parsePr, parsePushes, parseRemote, POLL_MS } from '../hooks/logic'

const T0 = Date.parse('2026-10-22T17:30:00Z')
const MIN = 60_000
const SHA = '76aa1f236a767211858f749205c16c66f01df9d8'
const W = { owner: 'acme', repo: 'infra', number: 7, server: 'github', sha: SHA, startedAt: T0 }
const run = (name: string, status = 'completed', conclusion: string | null = 'success') => ({ name, status, conclusion })
const pr = (runs: any[] | undefined, extra: Record<string, unknown> = {}) =>
  ({ kind: 'pr' as const, state: 'open', merged: false, headSha: SHA, runs, ...extra })

test('pushes are recognised with their directory, remote and branch; non-pushes are not', () => {
  expect(parsePushes('git push -u origin feat-x')).toEqual([{ dir: undefined, remote: 'origin', src: 'feat-x', branch: 'feat-x' }])
  expect(parsePushes('cd /r && git push origin HEAD:refs/heads/b')).toEqual([{ dir: '/r', remote: 'origin', src: 'HEAD', branch: 'b' }])
  expect(parsePushes('git -C /w push')).toEqual([{ dir: '/w', remote: undefined, src: undefined, branch: undefined }])
  expect(parsePushes('git push --dry-run origin b')).toEqual([])
  expect(parsePushes('git push origin :old')).toEqual([])
  expect(parsePushes('git commit -m "push it"')).toEqual([])
  expect(parsePushes('echo push')).toEqual([])
})

test('remote URLs of every shape give owner/repo', () => {
  expect(parseRemote('https://github.com/acme/infra.git')).toEqual({ owner: 'acme', repo: 'infra' })
  expect(parseRemote('git@github.com:acme/infra.git')).toEqual({ owner: 'acme', repo: 'infra' })
  expect(parseRemote('http://local_proxy@127.0.0.1:8080/git/acme/infra')).toEqual({ owner: 'acme', repo: 'infra' })
  expect(parseRemote('')).toBeUndefined()
})

test('MCP results are read, and unreadable ones are undefined', () => {
  const list = JSON.stringify([{ number: 7, state: 'open', head: { ref: 'feat-x', sha: SHA } }, { number: 8, state: 'open', head: { ref: 'other' } }])
  expect(findPr(list, 'feat-x')).toBe(7)
  expect(findPr(list, 'nope')).toBeUndefined()
  expect(findPr('garbage', 'feat-x')).toBeUndefined()
  expect(parsePr(JSON.stringify({ state: 'open', merged: false, head: { sha: SHA } }))).toEqual({ state: 'open', merged: false, headSha: SHA })
  expect(parsePr(JSON.stringify({ state: 'closed', merged_at: '2026-10-22', head: { sha: SHA } }))!.merged).toBe(true)
  expect(parseCheckRuns(JSON.stringify({ total_count: 1, check_runs: [run('a', 'IN_PROGRESS', null)] }))).toEqual([run('a', 'in_progress', null)])
  expect(parseCheckRuns('{"check_runs":[{"status":"completed"}]}')).toBeUndefined()
})

test('finished CI wakes only after the same picture twice, and names the failures', () => {
  const runs = [run('lint'), run('review', 'completed', 'failure')]
  const first = decide(W, pr(runs), T0 + 4 * MIN)
  expect(first.done).toBe(false)
  expect(first.wake).toBeUndefined()
  const second = decide({ ...W, ...first.patch }, pr(runs), T0 + 6 * MIN)
  expect(second.done).toBe(true)
  expect(second.wake).toMatch(/^\[mod:pr-ci-watch\] acme\/infra#7: CI finished on 76aa1f2: 1 of 2 checks failed: review \(failure\)/)
  // A run that registered late changes the picture: no wake yet.
  const late = decide({ ...W, ...first.patch }, pr([...runs, run('slow', 'completed')]), T0 + 6 * MIN)
  expect(late.done).toBe(false)
})

test('all green says so; running CI waits, and says so once after an hour', () => {
  const green = [run('a'), run('b', 'completed', 'skipped')]
  const p = decide(W, pr(green), T0 + 4 * MIN).patch
  expect(decide({ ...W, ...p }, pr(green), T0 + 6 * MIN).wake).toContain('all 2 checks passed')
  const busy = [run('a'), run('b', 'queued', null)]
  expect(decide(W, pr(busy), T0 + 10 * MIN)).toEqual({ done: false, patch: { errors: 0, lastSig: undefined } })
  const long = decide(W, pr(busy), T0 + LONG_MS)
  expect(long.wake).toContain('still running after 60 min (b)')
  expect(decide({ ...W, warnedLong: true }, pr(busy), T0 + LONG_MS + POLL_MS).wake).toBeUndefined()
})

test('the previous head is not mistaken for the push; it is adopted only after a while', () => {
  const old = pr([run('a')], { headSha: 'f'.repeat(40) })
  expect(decide(W, old, T0 + 2 * MIN)).toEqual({ done: false, patch: { errors: 0 } })
  expect(decide(W, old, T0 + ADOPT_HEAD_MS).patch!.sha).toBe('f'.repeat(40))
  expect(decide({ ...W, sha: '' }, pr([run('a')]), T0 + MIN).patch!.sha).toBe(SHA)
})

test('no checks, merges, closes and read errors', () => {
  expect(decide(W, pr([]), T0 + 5 * MIN).wake).toBeUndefined()
  expect(decide(W, pr([]), T0 + NO_CHECKS_MS).wake).toContain('no checks have registered')
  const merged = decide(W, pr([], { merged: true, state: 'closed' }), T0 + MIN)
  expect(merged.done).toBe(true)
  expect(merged.wake).toMatch(/acme\/infra#7 merged\./)
  expect(decide(W, pr([], { state: 'closed' }), T0 + MIN).wake).toContain('closed without merging')
  expect(decide(W, pr(undefined), T0 + MIN).done).toBe(false)
  expect(decide({ ...W, errors: MAX_ERRORS - 2 }, { kind: 'error', detail: 'x' }, T0)).toEqual({ done: false, patch: { errors: MAX_ERRORS - 1 } })
  expect(decide({ ...W, errors: MAX_ERRORS - 1 }, { kind: 'error', detail: 'x' }, T0).wake).toContain('stopped watching')
})

test('end to end: a push is watched through git and the GitHub MCP, and the session is woken', async ($: any, on: any) => {
  const clock = mock.clock(on, { now: T0 })
  const prompts: string[] = []
  const calls: any[] = []
  let runs = [run('lint', 'in_progress', null)]
  on('ui.toast', () => ({ value: undefined }) as any)
  on('prompt.submit', (_$: any, e: any) => { prompts.push(e.text); return { text: e.text } as any })
  on('turn.complete', () => ({ text: 'done' }) as any)
  on('process.run', (_$: any, e: any) => {
    const a = e.argv.join(' ')
    const out = a.includes('get-url') ? 'https://github.com/acme/infra.git' : a.includes('--abbrev-ref') ? 'feat-x' : SHA
    return { value: { exitCode: 0, stdout: out + '\n', stderr: '' } } as any
  })
  on('mcp.call', (_$: any, e: any) => {
    calls.push(e)
    const text = e.tool === 'list_pull_requests' ? JSON.stringify([{ number: 7, state: 'open', head: { ref: 'feat-x' } }])
      : e.args.method === 'get' ? JSON.stringify({ state: 'open', merged: false, head: { sha: SHA } })
      : JSON.stringify({ check_runs: runs })
    return { value: { isError: false, content: [{ type: 'text', text }] } } as any
  })
  on('tool.call', () => ({ result: 'ok', text: 'pushed' }) as any)

  const r: any = await $.tool.call({ tool: 'Bash', command: 'git push -u origin feat-x' })
  expect(r.context[0]).toMatch(/^\[mod:pr-ci-watch\] Watching CI on acme\/infra#7/)
  expect(calls[0]).toMatchObject({ server: 'github', tool: 'list_pull_requests' })
  await clock.advance(POLL_MS) // running
  runs = [run('lint', 'completed', 'failure')]
  await clock.advance(POLL_MS) // finished, first sight
  expect(prompts).toEqual([])
  await clock.advance(POLL_MS) // same picture: wake
  await ($ as any).turn.complete({ reason: 'answer', answer: 'done' })
  await clock.advance(1)
  expect(prompts.join('\n')).toContain('1 of 1 checks failed: lint (failure)')
})

test('create_pull_request starts a watch from the PR URL; other commands are untouched', async ($: any, on: any) => {
  mock.clock(on, { now: T0 })
  on('tool.call', (_$: any, e: any) => (e.tool === 'Bash'
    ? { result: 'ok', text: 'done' }
    : { result: 'ok', text: '{"id":"1","url":"https://github.com/acme/infra/pull/9"}' }) as any)
  const r: any = await $.tool.call({ tool: 'mcp__github__create_pull_request', owner: 'acme', repo: 'infra', title: 't', head: 'h', base: 'main' })
  expect(r.context[0]).toContain('acme/infra#9')
  const plain: any = await $.tool.call({ tool: 'Bash', command: 'ls -la' })
  expect(plain.context).toBeUndefined()
})

test('neutral, null or unknown conclusions are never reported as passed', () => {
  for (const c of ['neutral', null, '', 'weird']) {
    const runs = [run('lint'), run('review', 'completed', c as any)]
    const p = decide(W, pr(runs), T0 + 4 * MIN).patch
    const d = decide({ ...W, ...p }, pr(runs), T0 + 6 * MIN)
    expect(d.done).toBe(true)
    expect(d.wake).not.toContain('passed.')
    expect(d.wake).toContain('1 of 2 checks did not clearly pass: review')
  }
})

test('the PR number comes from the JSON field, else the last /pull/ URL', () => {
  expect(prNumberFrom('{"number":12,"url":"https://github.com/a/b/pull/1"}')).toBe(12)
  expect(prNumberFrom('{"id":"1","url":"https://github.com/acme/infra/pull/9"}')).toBe(9)
  expect(prNumberFrom('see https://github.com/x/y/pull/1 then https://github.com/acme/infra/pull/9')).toBe(9)
  expect(prNumberFrom('nothing')).toBeUndefined()
})

test('unreadable check runs count as read errors and end in a wake, never a silent wait', () => {
  expect(decide(W, pr(undefined), T0 + MIN)).toEqual({ done: false, patch: { errors: 1 } })
  const last = decide({ ...W, errors: MAX_ERRORS - 1 }, pr(undefined), T0 + MIN)
  expect(last.done).toBe(true)
  expect(last.wake).toContain('could not read the check runs')
  // A readable read resets the count.
  expect(decide({ ...W, errors: 3 }, pr([run('a', 'queued', null)]), T0 + MIN).patch!.errors).toBe(0)
})
