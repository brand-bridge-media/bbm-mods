export type PendingTicket = { key: string; pr: string; nagged: boolean }

declare module 'claude-code' {
  interface PluginState {
    'jira-closer': { pending: PendingTicket[]; titles: Record<string, string> }
  }
}
