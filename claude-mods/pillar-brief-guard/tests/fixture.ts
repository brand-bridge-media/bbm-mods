import { mock } from 'claude-code/testing'

// One fake world for every test: a clock, a Supabase MCP that answers the guard's two queries
// from a table the test controls, an engine beneath the plugin that records what got through,
// and the question dialog the guard asks through.

export const NOW = Date.parse('2026-10-08T12:00:00Z')
export const DAY = 86_400_000
export const RUN = '896655cd-59e8-4f99-b127-6a275ab31e18'
export const ARTICLE = '11111111-2222-4333-8444-555555555555'

export type World = {
  brief?: { version?: number; approved_at?: string; approved_by?: string | null } | null // null = no approved row
  runs?: Record<string, { article_id: string; article_slug: string }>
  sqlError?: boolean
  throwSql?: boolean
  answer?: string
  files?: Record<string, string> // fs.read / fs.exists
  articles?: string[] // slugs present in public.articles (default: best-sofas)
  wrapped?: boolean // reply in the JSON-wrapped shape: {"result":"...<untrusted-data>..."}
  garbage?: string // reply with this raw text instead of rows
}

const plainText = (rows: unknown[]) => 'Below is the result...\n\n<untrusted-data-x>\n' + JSON.stringify(rows) + '\n</untrusted-data-x>'

export function world(on: any, w: World = {}) {
  // The Supabase MCP has answered in both shapes: the plain text, and that text wrapped as JSON
  // {"result":"..."} (quotes inside escaped). The guard must read both and deny on anything else.
  const envelope = (rows: unknown[]) => ({
    isError: false,
    content: [{ type: 'text', text: w.garbage ?? (w.wrapped ? JSON.stringify({ result: plainText(rows) }) : plainText(rows)) }],
  })
  mock.store(on)
  mock.clock(on, { now: NOW })
  const toasts: string[] = []
  const queries: string[] = []
  const asked: string[] = []
  const reached: string[] = []
  on('ui.toast', (_$: any, e: any) => { toasts.push(e.text); return { value: undefined } as any })
  on('fs.exists', (_$: any, e: any) => ({ value: Object.prototype.hasOwnProperty.call(w.files ?? {}, e.path) }) as any)
  on('fs.read', (_$: any, e: any) => {
    // The engine resolves a relative path against the cwd, so match on the tail.
    const hit = Object.keys(w.files ?? {}).find(k => e.path === k || e.path.endsWith('/' + k))
    if (hit) return { value: (w.files as Record<string, string>)[hit] } as any
    throw new Error('ENOENT')
  })
  on('mcp.call', (_$: any, e: any) => {
    const q = String(e.args.query)
    queries.push(q)
    if (w.throwSql) throw new Error('mcp down')
    if (w.sqlError) return { value: { isError: true, content: [{ type: 'text', text: 'boom' }] } } as any
    if (q.startsWith('select id from public.articles')) {
      const slug = /slug = '([^']+)'/.exec(q)?.[1] ?? ''
      return { value: envelope((w.articles ?? ['best-sofas']).includes(slug) ? [{ id: ARTICLE }] : []) } as any
    }
    if (q.includes('refresh_runs')) {
      const id = /id = '([^']+)'/.exec(q)?.[1] ?? ''
      const r = (w.runs ?? { [RUN]: { article_id: ARTICLE, article_slug: 'best-sofas' } })[id]
      return { value: envelope(r ? [r] : []) } as any
    }
    const b = w.brief === undefined
      ? { version: 1, approved_at: '2026-09-01T00:00:00Z', approved_by: 'The operator' }
      : w.brief
    return { value: envelope(b ? [{ id: 'b1', article_slug: 'best-sofas', ...b }] : []) } as any
  })
  // The engine beneath the plugin: only runs when the guard let the call through.
  on('tool.call', (_$: any, e: any) => {
    if (e.tool === 'AskUserQuestion') {
      asked.push(JSON.stringify(e))
      const a = w.answer ?? 'Refuse'
      return { result: { answers: { [e.questions?.[0]?.question]: a } }, text: a } as any
    }
    reached.push(e.tool)
    return { result: 'ok', text: 'ok' } as any
  })
  return { toasts, queries, asked, reached, w }
}

export const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString()
