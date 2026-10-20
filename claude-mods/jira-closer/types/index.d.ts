// queued: the PR only had auto-merge armed, so it has not merged yet (LC-1884).
export type PendingTicket = { key: string; pr: string; nagged: boolean; queued?: boolean }

declare module 'claude-code' {
  interface PluginState {
    'jira-closer': { pending: PendingTicket[]; titles: Record<string, string> }
  }
}
