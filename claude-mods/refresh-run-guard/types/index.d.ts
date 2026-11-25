export type PassAEntry = {
  slug: string
  runId: string
  /** ms epoch of the exit-0 `article_audit.py --pass a --write-receipt` */
  at: number
  stale: boolean
  /** ms epoch of the Webflow item write that invalidated it; 0 while fresh */
  staleAt: number
}

/** A Products / Brands item's staged fields as this session last read them from Webflow (LC-2297). */
export type CatalogSeen = {
  collection: string
  fieldData: Record<string, unknown>
  isArchived: boolean
  /** ms epoch of the read */
  readAt: number
}

/** One row of the canonical catalog-context read (CONTEXT_SQL in register.ts), by Webflow item id. */
export type CatalogCtx = {
  row: Record<string, unknown>
  /** ms epoch of the read */
  readAt: number
}

declare module 'claude-code' {
  interface PluginState {
    'refresh-run-guard': {
      passA: Record<string, PassAEntry>
      /** Webflow item id -> count of lc-deal-pill spans seen in its live post-body */
      pills: Record<string, number>
      /** Webflow item id -> its staged Products / Brands fields, cleared by any Webflow write */
      catalogSeen: Record<string, CatalogSeen>
      /** Webflow item id -> its canonical Supabase context row */
      catalogCtx: Record<string, CatalogCtx>
      /** Webflow item id -> its canonical dead-link read row (LCH-370) */
      deadLinks: Record<string, CatalogCtx>
    }
  }
}
