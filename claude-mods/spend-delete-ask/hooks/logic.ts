// Which tool calls ask the operator first (LCH-528, operator gate: irreversible money/data).
// Kept as a list, not a pattern: a broad `*__delete_*` would also ask before routine,
// reversible cleanup (a session deleting its own scheduled check-in) and stall unattended
// sessions. A tool named here asks; anything else is untouched.

/** Every tool on these MCP servers moves money. */
export const MONEY_SERVERS = ['mcp__Stripe__']

/** Tools that bill, invoice, buy or spend a finite balance. */
export const MONEY_TOOLS: readonly string[] = [
  'mcp__PayPal__create_invoice',
  'mcp__PayPal__create_bulk_invoices',
  'mcp__PayPal__send_invoice',
  'mcp__PayPal__send_bulk_invoices',
  'mcp__PayPal__create_payment_link',
  'mcp__Insert_Link__add_guest_post_to_cart',
  'mcp__Insert_Link__add_link_insertion_to_cart',
  'mcp__Roominate__create_scene',
  'mcp__Roominate__create_from_product',
  'mcp__Roominate__add_product_to_room',
  'mcp__Roominate__edit_image',
  'mcp__Roominate__make_video',
  'mcp__Roominate__publish_to_store',
  'mcp__plugin_small-business_intuit-quickbooks__qbo_sales_create_invoice',
  'mcp__plugin_small-business_intuit-quickbooks__qbo_sales_send_invoice',
  'mcp__plugin_small-business_intuit-quickbooks__qbo_sales_create_recurring_invoice',
  'mcp__plugin_small-business_intuit-quickbooks__qbo_sales_create_payment_link',
  'mcp__plugin_small-business_intuit-quickbooks__qbo_sales_send_payment_link',
  'mcp__plugin_small-business_intuit-quickbooks__qbo_payroll_create_employee',
  'mcp__plugin_small-business_intuit-quickbooks__money_onboarding_application_submit',
  'mcp__plugin_small-business_intuit-quickbooks__quickbooks_transaction_import',
]

/** Deletes and trash on systems with no undo from a session. */
export const DESTRUCTIVE_TOOLS: readonly string[] = [
  'mcp__Airtable__delete_records_for_table',
  'mcp__Airtable__delete_table',
  'mcp__Airtable__delete_automation',
  'mcp__Airtable__delete_interface',
  'mcp__Airtable__delete_page',
  'mcp__Notion__notion-delete-pages',
  'mcp__Notion__notion-delete-databases',
  'mcp__Google_Drive__trash_file',
  'mcp__GitHub_Custom__delete_repository',
  'mcp__GitHub_Custom__delete_file',
  'mcp__github__delete_file',
  'mcp__Cloudflare_Developer_Platform__d1_database_delete',
  'mcp__Cloudflare_Developer_Platform__kv_namespace_delete',
  'mcp__Cloudflare_Developer_Platform__r2_bucket_delete',
  'mcp__Cloudflare_Developer_Platform__hyperdrive_config_delete',
  'mcp__Supabase__delete_branch',
  'mcp__Supabase__reset_branch',
  'mcp__Supabase__pause_project',
  'mcp__Tailwind_-_Pinterest__delete_board',
  'mcp__Beehive__delete_podcast_show',
  'mcp__Beehive__delete_podcast_episode',
]

const MONEY = new Set(MONEY_TOOLS)
const DESTRUCTIVE = new Set(DESTRUCTIVE_TOOLS)

/** The ask text for a tool, or undefined when it does not ask. */
export function askFor(tool: string): string | undefined {
  if (MONEY.has(tool) || MONEY_SERVERS.some(p => tool.startsWith(p))) {
    return `[mod:spend-delete-ask] ${tool} moves money or spends a balance. Approve only if the operator asked for exactly this.`
  }
  if (DESTRUCTIVE.has(tool)) {
    return `[mod:spend-delete-ask] ${tool} deletes something a session cannot restore. Approve only if the operator asked for exactly this.`
  }
  return undefined
}
