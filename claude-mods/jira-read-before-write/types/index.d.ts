declare module 'claude-code' {
  interface PluginState {
    // Issue keys (upper-case) whose comments this session has read.
    'jira-read-before-write': { reads: string[] }
  }
}
