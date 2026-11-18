/** mod name -> fingerprint of the code loaded at session start (see hooks/mod-freshness.py). */
export type Fingerprints = Record<string, string>

declare module 'claude-code' {
  interface PluginState {
    'mod-freshness': {
      loaded: Fingerprints
      /** True when any mod came from the claude.ai account copy (project threads, LC-2217). */
      account: boolean
      /** Mods already reported stale this session (each is reported once). */
      warned: string[]
    }
  }
}
