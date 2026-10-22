import { mock } from 'claude-code/testing'

// One fake world: the Python joint answers by command (the logic has its own --selftest), the Supabase /
// GitHub MCP answer from tables the test controls, and the engine beneath the plugin records what got through.

export type World = {
  trigger?: Record<string, unknown> // what `trigger` answers (default: nothing)
  triggers?: Record<string, unknown>[] // or, in order, one answer per `trigger` call (then nothing)
  tickets?: string[] // what `discover` finds
  prs?: number[]
  failSql?: string // any execute_sql whose text contains this answers isError
  throwProcess?: boolean
  noCard?: boolean // render answers nothing
  branch?: string // what `git rev-parse --abbrev-ref HEAD` prints
  ownTicket?: string // what branch_ticket finds
  gate?: Record<string, unknown> // what `gate` answers
  tools?: string[] // what `tool.list` answers (names, as the model sees them)
  servers?: string[] // the only MCP server names that exist: any other `mcp.call` throws, as the engine does
}

const env = (rows: unknown[]) => ({ isError: false, content: [{ type: 'text', text: 'Below...\n<untrusted-data-x>\n' + JSON.stringify(rows) + '\n</untrusted-data-x>' }] })

export function world(on: any, w: World = {}) {
  mock.store(on)
  const toasts: string[] = []
  const cmds: any[] = []
  const mcp: { server: string; tool: string; args: any }[] = []
  const reached: any[] = []
  const fail = { noCardOnce: false }
  on('ui.toast', (_$: any, e: any) => { toasts.push(e.text); return { value: undefined } as any })
  on('process.run', (_$: any, e: any) => {
    if (w.throwProcess) throw new Error('spawn failed')
    if (e.argv[0] === 'git') return { value: { exitCode: 0, stdout: (w.branch ?? 'main') + '\n', stderr: '' } } as any
    const p = JSON.parse(String(e.init?.stdin ?? '{}'))
    cmds.push(p)
    const out: Record<string, unknown> = {
      trigger: p.cmd !== 'trigger' ? {} : w.triggers ? (w.triggers.shift() ?? {}) : (w.trigger ?? {}),
      sql_knowledge: { sql: 'SQL:knowledge' },
      sql_production: { sql: 'SQL:production', asked: { slugs: [] } },
      sql_jira_fire: { sql: 'SQL:fire' },
      sql_jira_collect: { sql: 'SQL:collect' },
      parse_knowledge: { evidence: { ok: !p.error, from: 'knowledge' } },
      parse_production: { evidence: { ok: !p.error, from: 'production' } },
      discover: { tickets: w.tickets ?? [], prs: w.prs ?? [] },
      parse_jira: { evidence: { ok: !p.error, from: 'jira', error: p.error } },
      parse_prs: { evidence: { ok: !p.error, from: 'github' } },
      normalize: { kind: p.kind ?? 'diagnosis', topic: [...(p.tickets ?? []), ...(p.terms ?? [])].join(' '), tickets: p.tickets ?? [], terms: p.terms ?? [] },
      branch_ticket: { tickets: w.ownTicket ? [w.ownTicket] : [] },
      gate: w.gate ?? {},
      render: w.noCard || (p.cmd === 'render' && fail.noCardOnce && !(fail.noCardOnce = false)) ? {} : { card: 'WHERE WE STAND — x (as of 2026-10-22)\nVERDICT: CONFLICT\nline' },
    }
    return { value: { exitCode: 0, stdout: JSON.stringify(out[p.cmd] ?? {}), stderr: '' } } as any
  })
  if (w.tools) on('tool.list', () => ({ value: w.tools!.map(name => ({ name, description: '', mcp: name.startsWith('mcp__') })) }) as any)
  on('mcp.call', (_$: any, e: any) => {
    mcp.push({ server: e.server, tool: e.tool, args: e.args })
    if (w.servers && !w.servers.includes(e.server)) throw new Error(`$.mcp.call: no connected MCP tool "${e.tool}" on a server named "${e.server}"`)
    const q = String(e.args?.query ?? '')
    if (e.tool === 'execute_sql' && w.failSql && q.includes(w.failSql)) return { value: { isError: true, content: [{ type: 'text', text: 'boom' }] } } as any
    if (e.tool === 'pull_request_read') return { value: { isError: false, content: [{ type: 'text', text: '{"state":"closed","merged":true}' }] } } as any
    if (e.tool === 'list_edge_functions') return { value: env([{ slug: 'catalog-ingest', version: 3, updated_at: 1 }]) } as any
    if (q === 'SQL:fire') return { value: env([{ k: 'LC-1', kind: 'c', req: 7 }, { k: 'LC-1', kind: 'i', req: 8 }]) } as any
    if (q === 'SQL:collect') return { value: env([{ id: 7 }, { id: 8 }]) } as any
    return { value: env([{ j: {} }]) } as any
  })
  on('tool.call', (_$: any, e: any) => { reached.push(e); return { result: 'ok', text: 'ok' } as any })
  return { toasts, cmds, mcp, reached, fail }
}

export const JIRA = { tool: 'mcp__Atlassian__getJiraIssue', issueIdOrKey: 'LC-1345' } as any
export const DIAG = { tool: 'mcp__Supabase__execute_sql', project_id: 'p', query: "select * from pipeline_health_log where details ilike '%catalog-ingest%'" } as any
export const TICKET_TRIGGER = { kind: 'ticket-status', topic: 'LC-1345', tickets: ['LC-1345'], terms: [] }
export const DIAG_TRIGGER = { kind: 'diagnosis', topic: 'catalog-ingest', tickets: [], terms: ['catalog-ingest'] }
