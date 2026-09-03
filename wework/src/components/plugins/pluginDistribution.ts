import { isPersonalMarketplaceId } from '@/features/plugins/builtinPlugins'
import {
  isInternalDeviceMarketplaceId,
  isOpenAiOfficialMarketplaceId,
} from '@/features/plugins/marketplaceIdentity'
import type { InstalledPlugin, PluginMarketplaceItem } from '@/types/api'

export type PluginDistribution = 'official' | 'workspace' | 'personal' | 'public' | 'external'

export function marketplaceItemMarketplaceId(plugin: PluginMarketplaceItem): string | null {
  const marketplaceId = plugin.manifest?.marketplaceId
  return typeof marketplaceId === 'string' && marketplaceId.trim() ? marketplaceId.trim() : null
}

export function installedPluginMarketplaceId(plugin: InstalledPlugin): string | null {
  const payloadMarketplace = plugin.spec.sourcePayload?.marketplaceName
  const candidates = [
    plugin.spec.source.marketplace,
    typeof payloadMarketplace === 'string' ? payloadMarketplace : null,
    plugin.spec.source.providerKey,
    typeof plugin.metadata.namespace === 'string' ? plugin.metadata.namespace : null,
  ]
  return candidates.find(candidate => candidate?.trim())?.trim() ?? null
}

export function marketplacePluginDistribution(plugin: PluginMarketplaceItem): PluginDistribution {
  // User submissions remain personal creations even when a legacy release was
  // made public before enterprise publication gained its own plugin identity.
  if (plugin.accessRole === 'owner' && plugin.sourceProvider === 'user') return 'personal'
  if (plugin.visibility === 'personal') return 'personal'
  const marketplaceId = marketplaceItemMarketplaceId(plugin)
  if (marketplaceId && isPersonalMarketplaceId(marketplaceId)) return 'personal'
  if (isInternalDeviceMarketplaceId(marketplaceId)) return 'workspace'
  if (plugin.latestReleaseId == null && plugin.sourceProvider === 'codex') {
    return isOpenAiOfficialMarketplaceId(marketplaceId) ? 'official' : 'external'
  }
  if (plugin.sourceProvider === 'codex') return 'official'
  if (plugin.visibility === 'public') return 'public'
  return 'workspace'
}

export function installedPluginDistribution(plugin: InstalledPlugin): PluginDistribution {
  if (
    plugin.spec.visibility === 'personal' ||
    plugin.spec.origin === 'created' ||
    plugin.spec.source.type === 'local' ||
    isPersonalMarketplaceId(plugin.spec.source.providerKey)
  ) {
    return 'personal'
  }
  if (plugin.spec.pluginId != null) {
    if (plugin.spec.sourceProvider === 'codex') return 'official'
    if (plugin.spec.visibility === 'public') return 'public'
    return 'workspace'
  }
  const marketplaceId = installedPluginMarketplaceId(plugin)
  if (isInternalDeviceMarketplaceId(marketplaceId)) return 'workspace'
  if (plugin.spec.sourceProvider === 'codex') {
    return isOpenAiOfficialMarketplaceId(marketplaceId) ? 'official' : 'external'
  }
  if (plugin.spec.visibility === 'public') return 'public'
  return 'workspace'
}
