import { mock } from 'claude-code/testing'

// One fake world: a repo checkout, scripts/ci/preflight.sh (a stub whose exit code and output the
// test sets), a GitHub MCP that answers get_check_runs, a clock, and the engine beneath the plugin
// that records which tool calls the mod let through.

export const NOW = Date.parse('2026-10-19T12:00:00Z')
export const MIN = 60_000

export type World = {
  top?: string | null // git toplevel; null = not a repo
  hasScript?: boolean
  exit?: number // preflight exit code
  output?: string
  hangMs?: number // the script "runs" this long on the mock clock before the throw
  throwMsg?: string // process.run rejects with this (a timeout, say) for the preflight script
  branch?: string
  checks?: unknown // body get_check_runs returns (JSON-stringified unless a string)
  checksError?: boolean
  checksThrow?: boolean
  engineError?: boolean // the underlying tool reports isError (a failed push)
  // LCH-582: the open-PR lookup
  remote?: string | null // `git remote get-url origin` stdout; null = the command fails
  prs?: unknown // list_pull_requests answer (JSON-stringified)
  prGet?: unknown // pull_request_read `get` answer
  failServers?: string[] // MCP servers whose calls throw
}

export function world(on: any, w: World = {}) {
  mock.store(on)
  const clock = mock.clock(on, { now: NOW })
  const toasts: string[] = []
  const preflightRuns: { argv: string[]; cwd?: string; timeoutMs?: number }[] = []
  const gitCalls: string[][] = []
  const mcpCalls: { server: string; tool: string; args: any }[] = []
  const reached: any[] = []
  const writes: { body: string; path: string }[] = []
  const top = w.top === undefined ? '/work/repo' : w.top
  on('ui.toast', (_$: any, e: any) => { toasts.push(e.text); return { value: undefined } as any })
  on('fs.exists', (_$: any, e: any) => ({ value: (w.hasScript ?? true) && String(e.path).endsWith('scripts/ci/preflight.sh') }) as any)
  on('process.run', async (_$: any, e: any) => {
    const argv: string[] = [...e.argv]
    if (argv[0] === 'git') {
      gitCalls.push(argv)
      if (argv.includes('--show-toplevel')) return { value: top === null ? { exitCode: 128, stdout: '', stderr: 'not a git repository' } : { exitCode: 0, stdout: top + '\n', stderr: '' } } as any
      if (argv.includes('--abbrev-ref')) return { value: { exitCode: 0, stdout: (w.branch ?? 'lc1846-x') + '\n', stderr: '' } } as any
      if (argv.includes('get-url')) {
        const url = w.remote === undefined ? 'https://github.com/brand-bridge-media/bbm-infrastructure.git' : w.remote
        return { value: url === null ? { exitCode: 2, stdout: '', stderr: 'no remote' } : { exitCode: 0, stdout: url + '\n', stderr: '' } } as any
      }
      if (argv.includes('--absolute-git-dir')) return { value: { exitCode: 0, stdout: `${top}/.git\n`, stderr: '' } } as any
    }
    if (argv[0] === 'sh') {
      writes.push({ body: argv[4]!, path: argv[5]! })
      return { value: { exitCode: 0, stdout: '', stderr: '' } } as any
    }
    if (argv[0] === 'bash') {
      preflightRuns.push({ argv, cwd: e.init?.cwd, timeoutMs: e.init?.timeoutMs })
      if (w.hangMs) await clock.advance(w.hangMs) // the child ran this long, then the engine rejected
      if (w.throwMsg) throw new Error(w.throwMsg)
      return { value: { exitCode: w.exit ?? 0, stdout: w.output ?? 'preflight: 1 passed, 0 failed, 0 not checked\n', stderr: '' } } as any
    }
    return { value: { exitCode: 0, stdout: '', stderr: '' } } as any
  })
  on('mcp.call', (_$: any, e: any) => {
    mcpCalls.push({ server: e.server, tool: e.tool, args: e.args })
    if (w.failServers?.includes(e.server)) throw new Error(`no such server ${e.server}`)
    if (e.tool === 'list_pull_requests') return { value: { isError: false, content: [{ type: 'text', text: JSON.stringify(w.prs ?? []) }] } } as any
    if (e.tool === 'pull_request_read' && e.args?.method === 'get') {
      return { value: { isError: false, content: [{ type: 'text', text: JSON.stringify(w.prGet ?? {}) }] } } as any
    }
    if (w.checksThrow) throw new Error('mcp down')
    if (w.checksError) return { value: { isError: true, content: [{ type: 'text', text: 'boom' }] } } as any
    const body = typeof w.checks === 'string' ? w.checks : JSON.stringify(w.checks ?? { total_count: 0, check_runs: [] })
    return { value: { isError: false, content: [{ type: 'text', text: body }] } } as any
  })
  // The engine beneath the plugin: runs only when the mod let the call through.
  on('tool.call', (_$: any, e: any) => {
    reached.push(e)
    return (w.engineError ? { result: 'fatal: rejected', text: 'fatal: rejected', isError: true } : { result: 'ok', text: 'ok' }) as any
  })
  return { toasts, preflightRuns, gitCalls, mcpCalls, reached, clock, writes }
}

export const runs = (...r: [string, string, string | null][]) =>
  ({ total_count: r.length, check_runs: r.map(([name, status, conclusion]) => ({ name, status, conclusion })) })

export const bash = (command: string) => ({ tool: 'Bash', command }) as any
export const UPDATE = (tool = 'mcp__github__update_pull_request_branch') =>
  ({ tool, owner: 'o', repo: 'r', pullNumber: 7 }) as any
