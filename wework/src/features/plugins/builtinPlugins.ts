export const WEGENT_SITES_PLUGIN_NAME = 'wegent-sites'
export const WEWORK_PERSONAL_MARKETPLACE_ID = 'wework-personal'
export const CODEX_PERSONAL_MARKETPLACE_ID = 'personal'

export function isPersonalMarketplaceId(id: string): boolean {
  return id === WEWORK_PERSONAL_MARKETPLACE_ID || id === CODEX_PERSONAL_MARKETPLACE_ID
}
