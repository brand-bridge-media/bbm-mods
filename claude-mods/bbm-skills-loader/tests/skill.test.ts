// Why (LC-2227): this plugin carries one skill and no behaviour. The skill file itself is checked by
// hooks/check_skill.py --selftest (claude-mods.yml runs every hooks/*.py selftest), because a mod test
// cannot read files. Here we prove the empty hooks module really is inert: it must never change a call.
import { test, expect } from 'claude-code/testing'

test('a tool call passes through untouched', async ($: any, on: any) => {
  const reached: any[] = []
  on('tool.call', (_$: any, e: any) => { reached.push(e); return { result: 'ok' } })
  const r: any = await $.tool.call({ tool: 'mcp__github__get_file_contents', owner: 'brand-bridge-media', repo: 'claude-skills', path: 'x' })
  expect(reached.length).toBe(1)
  expect(r.result).toBe('ok')
  expect(r.deny).toBeUndefined()
  expect(r.context).toBeUndefined()
})
