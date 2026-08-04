export const WEGENT_SITES_PLUGIN_NAME = 'wegent-sites'
export const WEGENT_MINI_PROGRAM_PLUGIN_NAME = 'wegent-mini-program'
export const WEWORK_PERSONAL_MARKETPLACE_ID = 'wework-personal'
export const CODEX_PERSONAL_MARKETPLACE_ID = 'personal'

export function isPersonalMarketplaceId(id: string): boolean {
  return id === WEWORK_PERSONAL_MARKETPLACE_ID || id === CODEX_PERSONAL_MARKETPLACE_ID
}
