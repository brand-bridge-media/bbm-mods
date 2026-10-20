import { test, expect } from 'claude-code/testing'

// The Python check is tested by its own --selftest (claude-mods.yml runs it). These tests pin
// the mod's plumbing: which calls reach the check, what it is sent, how its verdict maps.

export function world(on: any, answer: { exitCode?: number; stdout?: string; throws?: boolean } = {}) {
  const runs: { argv: string[]; stdin: string }[] = []
  const toasts: string[] = []
  const reached: any[] = []
  on('process.run', (_$: any, e: any) => {
    runs.push({ argv: [...e.argv], stdin: String(e.init?.stdin ?? '') })
    if (answer.throws) throw new Error('spawn failed')
    return { value: { exitCode: answer.exitCode ?? 0, stdout: answer.stdout ?? '', stderr: '' } } as any
  })
  on('ui.toast', (_$: any, e: any) => { toasts.push(e.text); return { value: undefined } as any })
  on('tool.call', (_$: any, e: any) => { reached.push(e); return { result: 'ok', text: 'ok' } as any })
  return { runs, toasts, reached }
}

const BLOCK = JSON.stringify({ decision: 'block', reason: '[mod:reply-footer-check] footer missing' })

test('a block from the check blocks the stop; the stop payload is what the check reads', async ($: any, on: any) => {
  const w = world(on, { stdout: BLOCK })
  on('classic.Stop', () => ({}))
  const r: any = await $.classic.Stop({ stop_hook_active: false, transcript_path: '/t.jsonl' })
  expect(r.block).toBe('[mod:reply-footer-check] footer missing')
  expect(w.toasts[0]).toContain('[mod:reply-footer-check]')
  const sent = JSON.parse(w.runs[0]!.stdin)
  expect(sent.transcript_path).toBe('/t.jsonl')
  expect(sent.stop_hook_active).toBe(false)
})

for (const [label, answer] of [['silence', { stdout: '' }], ['a non-zero exit', { exitCode: 1, stdout: BLOCK }],
  ['junk output', { stdout: 'not json' }], ['a spawn failure', { throws: true }]] as const) {
  test(`${label} from the check lets the turn end`, async ($: any, on: any) => {
    world(on, answer as any)
    on('classic.Stop', () => ({}))
    const r: any = await $.classic.Stop({ stop_hook_active: false })
    expect(r.block).toBeUndefined()
  })
}
