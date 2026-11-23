import { expect, mock } from 'claude-code/testing'
import { test } from './slow'

import { sqlReply } from './fixture'
import { isReadOnlyStep, receiptWritesInBash } from '../hooks/logic'

// LC-1932 (2): a child session read the receipt writer's SOURCE with grep / sed -n and got
// `[mod:run-state] ... confirm this receipt write` (no Supabase MCP, nobody to answer). A command that only reads a file
// that names the writer is not a write. The bad cases (the writer actually run, anything that writes or runs through a
// read command) must still be judged.

const WRITER = 'webflow/bulk-operations/refresh-receipt-writer/write_stage_receipt.py'
const STAGE = '_shared/supabase/stage_receipt.py'
const RUN = '896655cd-59e8-4f99-b127-6a275ab31e18'
const REAL = `python3 ${WRITER} --run-id ${RUN} --stage 11 --part c5 --status pass`
const n = (cmd: string) => receiptWritesInBash(cmd).length

test('VALID: read-only commands over the writer source are not receipt writes (the ticket commands)', () => {
  for (const cmd of [
    `grep -n "def " ${WRITER} ${STAGE}`,
    `grep -n 'stage' ${WRITER}`,
    `sed -n '1,80p' ${WRITER}`,
    `sed -n 1,80p ${WRITER}`,
    `sed -n "120,200p" ${WRITER} ${STAGE}`,
    `grep -rn receipt ${WRITER} | head -40`,
    `grep -c "stage" ${WRITER} 2>/dev/null`,
    `cat ${WRITER} | wc -l`,
    `head -50 ${WRITER}`,
    `tail -n 30 ${WRITER} 2>&1`,
    `wc -l ${WRITER} ${STAGE}`,
    `ls -la webflow/bulk-operations/refresh-receipt-writer/ && grep -n "argparse" ${WRITER}`,
    `rg -n "stage" ${WRITER}`,
    `git log --oneline -5 -- ${WRITER}`,
    `git diff origin/main -- ${WRITER}`,
    `grep -E "a|b" ${WRITER}`,
  ]) {
    expect(n(cmd), cmd).toBe(0)
  }
})

test('BAD: the writer actually run is still judged, alone or beside a read', () => {
  expect(n(REAL)).toBe(1)
  expect(n(`grep -n stage ${WRITER} && ${REAL}`)).toBe(1)
  expect(n(`grep -n stage ${WRITER}; ${REAL}`)).toBe(1)
  expect(n(`cat ${WRITER} | ${REAL}`)).toBe(1)
  expect(n(`grep -n stage ${WRITER} | python3 ${WRITER} --stage 9`)).toBe(1)
})

test('BAD: a read command that writes or runs something is still judged', () => {
  for (const cmd of [
    `cat ${WRITER} > .git/hooks/pre-commit`,
    `grep -n stage ${WRITER} > ${WRITER}`,
    `grep -n x $(${REAL})`,
    `grep -n x \`${REAL}\``,
    `head ${WRITER} < ${WRITER}`,
    `rg --pre 'python3 ${WRITER}' x .`,
    `git log --output=out.txt -- ${WRITER}`,
    `sed -n '1e ${REAL}' ${WRITER}`,
    `sed -i 's/a/b/' ${WRITER}`,
    `sed -n '1,5p' ${WRITER} > ${STAGE}`,
    `FOO=1 grep x ${WRITER}`,
    `python3 ${WRITER} --stage 9 --dry-run2`,
    `find . -name write_stage_receipt.py -exec python3 {} --stage 9 \\;`,
    `xargs python3 ${WRITER}`,
    `git push origin ${WRITER}`,
    `git -c core.pager=${WRITER} log`,
  ]) {
    expect(n(cmd), cmd).toBeGreaterThan(0)
  }
})

test('isReadOnlyStep: a pipe stage that is not a read makes the whole step not read-only', () => {
  expect(isReadOnlyStep(`grep x ${WRITER} | head`)).toBe(true)
  expect(isReadOnlyStep(`grep x ${WRITER} | sh`)).toBe(false)
  expect(isReadOnlyStep(`grep "a|b" ${WRITER}`)).toBe(true)
  expect(isReadOnlyStep(`grep x ${WRITER} |`)).toBe(false)
})

// ---- through the guard, as in the ticket's child: no plan readable, nobody to answer.
async function guard($: any, on: any) {
  mock.store(on)
  mock.clock(on, { now: Date.parse('2026-10-28T15:39:00Z') })
  const seen = { reached: 0, asked: 0 }
  on('mcp.call', () => ({ value: sqlReply([]) }) as any)
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: 'no connected MCP tool' } }) as any)
  on('tool.call', (_$: any, e: any) => {
    if (e.tool === 'AskUserQuestion') {
      seen.asked += 1
      return { result: { answers: { [e.questions?.[0]?.question]: 'Refuse' } }, text: 'Refuse' } as any
    }
    seen.reached += 1
    return { result: 'ok', text: 'ok' } as any
  })
  return seen
}

test('VALID through the guard: grep / sed -n over the writer reaches the shell with no question when the plan is unreadable', async ($, on) => {
  const seen = await guard($, on)
  for (const command of [`grep -n "def " ${WRITER} ${STAGE}`, `sed -n '1,80p' ${WRITER}`]) {
    const out: any = await $.tool.call({ tool: 'Bash', command } as any)
    expect(out.deny).toBeUndefined()
  }
  expect(seen.asked).toBe(0)
  expect(seen.reached).toBe(2)
})

test('BAD through the guard: the writer run, even after a read, is stopped when the plan is unreadable', async ($, on) => {
  const seen = await guard($, on)
  const out: any = await $.tool.call({ tool: 'Bash', command: `grep -n stage ${WRITER} && ${REAL}` } as any)
  expect(JSON.stringify(out)).toContain('[mod:run-state]')
  expect(seen.reached).toBe(0)
})
