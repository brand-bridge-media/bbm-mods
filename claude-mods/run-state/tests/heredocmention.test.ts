import { expect, mock } from 'claude-code/testing'
import { test } from './slow'

import { helperOutput, sqlReply } from './fixture'
import { receiptWritesInBash } from '../hooks/logic'

// LC-1732 (observed 2026-10-08, LC-1731 build): `mkdir` + `cat > plugin.json <<EOF` while scaffolding a mod ran in a
// child session with no Supabase MCP. The heredoc text only DESCRIBED refresh_runs and the receipt writers, nothing
// was written, yet run-state read the body as a receipt write, could not read the plan and asked a human who was not
// there. An UNQUOTED-terminator heredoc whose body has no expansion is data, the same as a quoted one. The bad cases
// (a real writer call, an expansion in the body, a later step that runs the file) must still be judged.

const RUN = '896655cd-59e8-4f99-b127-6a275ab31e18'
const W = `python3 webflow/bulk-operations/refresh-receipt-writer/write_stage_receipt.py --run-id ${RUN} --stage 11 --part c5 --status pass`
const n = (cmd: string) => receiptWritesInBash(cmd).length

const BODY = [
  '{',
  '  "name": "run-state",',
  '  "description": "Guards writes to refresh_runs.stages and refresh_run_sections; names write_stage_receipt.py --stage and article_audit.py --write-receipt"',
  '}',
].join('\n')
// The ticket's shape: a mkdir, then cat > file <<EOF (unquoted) whose text mentions the receipt tables and writers.
const TICKET = `mkdir -p claude-mods/newmod/.claude-plugin\ncat > claude-mods/newmod/.claude-plugin/plugin.json <<EOF\n${BODY}\nEOF`

test('VALID: the ticket heredoc (unquoted EOF, body only mentions refresh_runs and the writers) is not a receipt write', () => {
  expect(n(TICKET)).toBe(0)
  expect(n(`mkdir -p a/b && cat > a/b/plugin.json <<EOF\n${BODY}\nEOF`)).toBe(0)
  expect(n(`cat <<EOF > plugin.json\n${BODY}\nEOF`)).toBe(0)
  expect(n(`tee plugin.json <<-EOF\n\t${BODY.replace(/\n/g, '\n\t')}\n\tEOF`)).toBe(0)
  expect(n(`${TICKET}\ngit status`)).toBe(0)
})

test('BAD: a real writer call next to the heredoc is still judged', () => {
  expect(n(`${TICKET}\n${W}`)).toBeGreaterThan(0)
  expect(n(`cat > f.json <<EOF\n${BODY}\nEOF\n${W}`)).toBeGreaterThan(0)
})

test('BAD: an expansion in the unquoted body still runs, so the body is judged', () => {
  expect(n(`cat > f <<EOF\n$(${W})\nEOF`)).toBeGreaterThan(0)
  expect(n(`cat > f <<EOF\n\`${W}\`\nEOF`)).toBeGreaterThan(0)
  expect(n(`cat > f <<EOF\n${BODY}\n$(${W})\nEOF`)).toBeGreaterThan(0)
})

test('BAD: the file the heredoc wrote is run by a later step, so the body is judged', () => {
  for (const run of ['sh f.sh', 'bash f.sh', './f.sh', 'timeout 5 sh f.sh', 'python3 p.py', 'git push']) {
    expect(n(`cat > f.sh <<EOF\n${W}\nEOF\n${run}`), run).toBe(1)
  }
})

test('BAD: a heredoc inside an open quote is not rewritten, and a non-cat consumer keeps its body judged', () => {
  expect(n(`echo 'x\ncat > f <<EOF\n${BODY}\nEOF\n'; ${W}`)).toBeGreaterThan(0)
  expect(n(`bash <<EOF\n${W}\nEOF`)).toBeGreaterThan(0)
})

// ---- through the guard, as the ticket's child session ran it: no plan can be read and nobody can answer.
async function guard($: any, on: any) {
  mock.store(on)
  mock.clock(on, { now: Date.parse('2026-10-08T18:10:00Z') })
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
  void helperOutput
  return seen
}

test('VALID through the guard: the ticket command reaches the shell with no question when the plan is unreadable', async ($, on) => {
  const seen = await guard($, on)
  const out: any = await $.tool.call({ tool: 'Bash', command: TICKET } as any)
  expect(out.deny).toBeUndefined()
  expect(seen.asked).toBe(0)
  expect(seen.reached).toBe(1)
})

test('BAD through the guard: a real writer call beside the heredoc is still stopped when the plan is unreadable', async ($, on) => {
  const seen = await guard($, on)
  const out: any = await $.tool.call({ tool: 'Bash', command: `${TICKET}\n${W}` } as any)
  expect(JSON.stringify(out)).toContain('[mod:run-state]')
  expect(seen.reached).toBe(0)
})
