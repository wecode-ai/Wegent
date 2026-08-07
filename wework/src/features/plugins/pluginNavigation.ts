export interface PluginReference {
  pluginName: string
  marketplaceName: string
}

export const WEGENT_CLOUD_MARKETPLACE_ALIASES = new Set([
  'default',
  'wework',
  'wegent',
  'wegent-market',
  'wegent-marketplace',
])

const PLUGIN_MENTION_REFERENCE_PATTERN = /^\[\$[^\]]+]\((plugin:\/\/[^)\n]+)\)$/

export function isWegentCloudMarketplace(marketplaceName: string): boolean {
  return WEGENT_CLOUD_MARKETPLACE_ALIASES.has(marketplaceName.trim().toLowerCase())
}

export function parsePluginUri(uri: string): PluginReference | null {
  if (!uri.startsWith('plugin://')) return null

  const identity = uri.slice('plugin://'.length)
  const separatorIndex = identity.lastIndexOf('@')
  if (separatorIndex <= 0 || separatorIndex === identity.length - 1) return null

  const pluginName = identity.slice(0, separatorIndex).trim()
  const marketplaceName = identity.slice(separatorIndex + 1).trim()
  if (!pluginName || !marketplaceName) return null

  return { pluginName, marketplaceName }
}

export function parsePluginMentionReference(reference: string): PluginReference | null {
  const uri = reference.match(PLUGIN_MENTION_REFERENCE_PATTERN)?.[1]
  return uri ? parsePluginUri(uri) : null
}

export function buildPluginDetailRoute(reference: PluginReference): string {
  const searchParams = new URLSearchParams()
  searchParams.set('plugin', reference.pluginName)
  searchParams.set('marketplace', reference.marketplaceName)
  return `/plugins?${searchParams.toString()}`
}

export function parsePluginDetailRoute(search: string): PluginReference | null {
  const searchParams = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
  const pluginName = searchParams.get('plugin')?.trim() ?? ''
  const marketplaceName = searchParams.get('marketplace')?.trim() ?? ''
  if (!pluginName || !marketplaceName) return null

  return { pluginName, marketplaceName }
}
