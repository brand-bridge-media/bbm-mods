import { test, expect } from 'claude-code/testing'

import { isPipeline, repoPath } from '../hooks/register'

function engineBeneath(on: any, answer: any = { result: 'ok' }) {
  const reached: any[] = []
  on('tool.call', (_$: any, e: any) => { reached.push(e); return answer })
  return reached
}

test('the first pipeline edit gets the note once, and the edit still runs', async ($: any, on: any) => {
  const reached = engineBeneath(on)
  const r: any = await $.tool.call({ tool: 'Edit', file_path: '/home/u/bbm-infrastructure/.github/workflows/quick.yml', old_string: 'a', new_string: 'b' })
  expect(String(r.context ?? '')).toContain('[mod:pipeline-change-nudge]')
  expect(String(r.context ?? '')).toContain('## Pipeline change')
  expect(r.deny).toBeUndefined()
  expect(reached.length).toBe(1)
  const again: any = await $.tool.call({ tool: 'Write', file_path: '/home/u/bbm-infrastructure/scripts/ci/x.py', content: 'x' })
  expect(again.context).toBeUndefined()
  expect(reached.length).toBe(2)
})

test('a failed edit does not use up the one note', async ($: any, on: any) => {
  let fail = true
  on('tool.call', () => (fail ? { isError: true, result: 'no' } : { result: 'ok' }))
  const r1: any = await $.tool.call({ tool: 'Edit', file_path: '/w/bbm-infrastructure/.mergify.yml', old_string: 'a', new_string: 'b' })
  expect(r1.context).toBeUndefined()
  fail = false
  const r2: any = await $.tool.call({ tool: 'Edit', file_path: '/w/bbm-infrastructure/.mergify.yml', old_string: 'a', new_string: 'b' })
  expect(String(r2.context ?? '')).toContain('pipeline-change-nudge')
})

for (const path of ['/w/bbm-infrastructure/docs/a.md', '/w/bbm-guardrails/.github/workflows/x.yml', '/w/bbm-infrastructure/webflow/bulk-operations/t.py', '/w/other/scripts/ci/x.py']) {
  test(`${path} is not a pipeline edit here`, async ($: any, on: any) => {
    const reached = engineBeneath(on)
    const r: any = await $.tool.call({ tool: 'Write', file_path: path, content: 'x' })
    expect(r.context).toBeUndefined()
    expect(reached.length).toBe(1)
  })
}

test('path rules', () => {
  expect(repoPath('/a/bbm-infrastructure/scripts/ci/x.py')).toBe('scripts/ci/x.py')
  expect(repoPath('./scripts/ci/x.py')).toBe('scripts/ci/x.py')
  expect(repoPath('/a/elsewhere/x.py')).toBeUndefined()
  for (const p of ['.github/workflows/a.yml', 'scripts/ci/quick_checks.d/x.sh', '.trunk/trunk.yaml', 'scripts/quality/expected_required_checks.json', 'infra/pipeline-register.json']) {
    expect(isPipeline(p)).toBe(true)
  }
  for (const p of ['scripts/quality/rules/x.py', '.github/PIPELINE.md', 'infra/servers.json', '.mergify.yml.bak']) {
    expect(isPipeline(p)).toBe(false)
  }
})
