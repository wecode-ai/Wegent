export {
  WEWORK_PERSONAL_MARKETPLACE_ID,
  CODEX_PERSONAL_MARKETPLACE_ID,
  isPersonalMarketplaceId,
} from '@wegent/chat-core/personal-plugin-identity'
export const WEGENT_SITES_PLUGIN_NAME = 'wegent-sites'
export const WEGENT_MINI_PROGRAM_PLUGIN_NAME = 'weibo-miniapp-h5-develop-agent'
/**
 * System connectors that power Applications (Sites / Mini Programs).
 * Keep them synced to the local MCP runtime, but do not list them in the
 * composer "available plugins" picker — product entry is Applications Create.
 */
export function isSystemApplicationConnectorSlug(slug: string): boolean {
  return slug === WEGENT_SITES_PLUGIN_NAME || slug === WEGENT_MINI_PROGRAM_PLUGIN_NAME
}
