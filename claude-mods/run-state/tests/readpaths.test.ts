import { test, expect, mock } from 'claude-code/testing'

import { helperOutput } from './fixture'
import { receiptWritesInBash } from '../hooks/logic'

// LC-1711: a cloud build session has no Supabase MCP server. run-state must read the plan over
// PostgREST there (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY), and stay fail-closed when NO read
// path works: ask, naming every path tried, and refuse when nobody answers.

const RUN = '896655cd-59e8-4f99-b127-6a275ab31e18'
const KEY = 'sb-secret-key-do-not-leak'
const WRITE_READY = `python3 write_stage_receipt.py --run-id ${RUN} --stage 9 --part c2 --status done`

type W = {
  env?: Record<string, string>
  http?: (url: string) => { status: number; ok: boolean; text: string }
  unanswered?: boolean
}

async function world($: any, on: any, w: W) {
  mock.store(on)
  mock.clock(on, { now: Date.parse('2026-10-07T12:00:00Z') })
  mock.env(on, w.env ?? {})
  const log = { urls: [] as string[], headers: [] as Record<string, string>[], asked: [] as string[], engine: 0 }
  // The cloud session: the Supabase MCP server does not exist.
  on('mcp.call', () => {
    throw new Error('$.mcp.call: no connected MCP tool "execute_sql" on a server named "Supabase"')
  })
  on('http.fetch', (_$: any, e: any) => {
    log.urls.push(e.url)
    log.headers.push(e.init?.headers ?? {})
    const r = (w.http ?? (() => ({ status: 200, ok: true, text: '[]' })))(e.url)
    return { value: { ...r, headers: {} } } as any
  })
  on('process.run', () => ({ value: { exitCode: 0, stdout: helperOutput(), stderr: '' } }) as any)
  on('tool.call', (_$: any, e: any) => {
    if (e.tool === 'AskUserQuestion') {
      log.asked.push(JSON.stringify(e))
      if (w.unanswered) throw new Error('nobody to ask')
      return { result: { answers: { [e.questions?.[0]?.question]: 'Refuse' } }, text: 'Refuse' } as any
    }
    log.engine += 1
    return { result: 'ok', text: 'ok' } as any
  })
  return log
}

const restRows = (url: string) => {
  if (url.includes('limit=5')) return { status: 200, ok: true, text: JSON.stringify([{ id: RUN, article_slug: 'most-comfortable-couches', status: 'in_progress' }]) }
  return { status: 200, ok: true, text: JSON.stringify([{ id: RUN, stages: [] }]) }
}

test('no MCP server: the plan is read over PostgREST and a READY write goes through without asking', async ($, on) => {
  const log = await world($, on, { env: { SUPABASE_URL: 'https://x.supabase.co/', SUPABASE_SERVICE_ROLE_KEY: KEY }, http: restRows })
  const out: any = await $.tool.call({ tool: 'Bash', command: WRITE_READY } as any)
  expect(out.deny).toBeUndefined()
  expect(log.asked.length).toBe(0)
  expect(log.engine).toBe(1)
  // Real PostgREST shape: base without the trailing slash, table, filter, and both auth headers.
  expect(log.urls.some(u => u.startsWith('https://x.supabase.co/rest/v1/refresh_runs?') && u.includes(`id=eq.${RUN}`))).toBe(true)
  expect(log.headers[0].apikey).toBe(KEY)
  expect(log.headers[0].Authorization).toBe(`Bearer ${KEY}`)
})

test('no MCP server: a BLOCKED section read over PostgREST is still denied', async ($, on) => {
  const log = await world($, on, { env: { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: KEY }, http: restRows })
  const out: any = await $.tool.call({ tool: 'Bash', command: `python3 write_stage_receipt.py --run-id ${RUN} --stage 11 --part c5 --status pass` } as any)
  expect(JSON.stringify(out)).toContain('v2_s11c5')
  expect(log.engine).toBe(0)
})

test('no read path at all: asks, names every path tried, and never leaks the key', async ($, on) => {
  const log = await world($, on, { env: {} })
  const out: any = await $.tool.call({ tool: 'Bash', command: WRITE_READY } as any)
  expect(log.asked.length).toBe(1)
  const msg = log.asked[0]
  expect(msg).toContain('Supabase MCP')
  expect(msg).toContain('PostgREST')
  expect(msg).toContain('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY not set')
  expect(log.engine).toBe(0)
  expect(JSON.stringify(out)).toContain('refused')
})

test('PostgREST answering 401 is a failed path, named with its status, and the key stays out of the message', async ($, on) => {
  const log = await world($, on, {
    env: { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: KEY },
    http: () => ({ status: 401, ok: false, text: `{"message":"bad key ${KEY}"}` }),
  })
  const out: any = await $.tool.call({ tool: 'Bash', command: WRITE_READY } as any)
  expect(log.asked.length).toBe(1)
  expect(log.asked[0]).toContain('HTTP 401')
  expect(log.asked[0]).toContain('Supabase MCP')
  expect(JSON.stringify(out)).not.toContain(KEY)
  expect(log.asked[0]).not.toContain(KEY)
  expect(log.engine).toBe(0)
})

test('no read path and nobody to answer: the write is refused', async ($, on) => {
  const log = await world($, on, { env: {}, unanswered: true })
  const out: any = await $.tool.call({ tool: 'Bash', command: WRITE_READY } as any)
  expect(log.asked.length).toBe(1)
  expect(log.engine).toBe(0)
  expect(JSON.stringify(out)).toContain('no one answered')
})

test('--help / -h is not a receipt write; a quoted "-h" inside a real write still is', async () => {
  const w = 'python3 webflow/bulk-operations/refresh-receipt-writer/write_stage_receipt.py'
  expect(receiptWritesInBash(`${w} --help`)).toEqual([])
  expect(receiptWritesInBash(`${w} -h`)).toEqual([])
  expect(receiptWritesInBash(`${w} --stage 3 --part x --help`)).toEqual([])
  expect(receiptWritesInBash('python3 article_audit.py --help')).toEqual([])
  expect(receiptWritesInBash(`${w} --run-id ${RUN} --stage 9 --status done --summary "see -h docs"`).length).toBe(1)
  expect(receiptWritesInBash(`${w} --run-id ${RUN} --stage 9 --status done --summary 'x --help y'`).length).toBe(1)
  // An unclosed quote hides the rest of the line: the "-h" there is not a help flag (fail closed).
  expect(receiptWritesInBash(`${w} --run-id ${RUN} --stage 9 --status done --summary "blocked -h`).length).toBe(1)
  expect(receiptWritesInBash(`${w} --run-id ${RUN} --stage 9 --status done --summary 'blocked --help`).length).toBe(1)
  // Not a flag at all.
  expect(receiptWritesInBash(`${w} --stage 9 --status done --note a-h`).length).toBe(1)
})

test('a --help run never touches the plan, even with every read path dead', async ($, on) => {
  const log = await world($, on, { env: {} })
  const out: any = await $.tool.call({ tool: 'Bash', command: 'python3 write_stage_receipt.py --stage 3 --help' } as any)
  expect(out.deny).toBeUndefined()
  expect(log.asked.length).toBe(0)
  expect(log.engine).toBe(1)
})

test('PostgREST answering [] for the active-run list is NOT "no active run": the guard asks and says why', async ($, on) => {
  // A key that cannot see refresh_runs gets [] (row-level security), exactly like a quiet day. Trusting
  // it would switch the guard off for every write that names no run.
  const log = await world($, on, {
    env: { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: KEY },
    http: () => ({ status: 200, ok: true, text: '[]' }),
  })
  const out: any = await $.tool.call({ tool: 'Bash', command: 'python3 write_stage_receipt.py --stage 9 --part c2 --status done' } as any)
  expect(log.asked.length).toBe(1)
  expect(log.asked[0]).toContain('returned no active runs')
  expect(log.asked[0]).toContain('Supabase MCP')
  expect(log.engine).toBe(0)
  expect(JSON.stringify(out)).toContain('refused')
})
