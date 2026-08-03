import { WEWORK_PERSONAL_MARKETPLACE_ID } from '@/features/plugins/builtinPlugins'
import type { InstalledPlugin, PluginMarketplaceItem } from '@/types/api'

export type PluginDistribution = 'official' | 'workspace' | 'personal' | 'public'

export function marketplacePluginDistribution(plugin: PluginMarketplaceItem): PluginDistribution {
  if (plugin.sourceProvider === 'codex') return 'official'
  if (plugin.visibility === 'personal') return 'personal'
  if (plugin.visibility === 'public') return 'public'
  return 'workspace'
}

export function installedPluginDistribution(plugin: InstalledPlugin): PluginDistribution {
  if (plugin.spec.sourceProvider === 'codex') return 'official'
  if (
    plugin.spec.visibility === 'personal' ||
    plugin.spec.origin === 'created' ||
    plugin.spec.source.type === 'local' ||
    plugin.spec.source.providerKey === WEWORK_PERSONAL_MARKETPLACE_ID
  ) {
    return 'personal'
  }
  if (plugin.spec.visibility === 'public') return 'public'
  return 'workspace'
}
