import type { PluginMarketplaceItem } from '@/types/api'
import type { InstalledPluginItem } from '@/components/plugins/PluginManagementRows'

export function item(
  overrides: Partial<PluginMarketplaceItem> & Pick<PluginMarketplaceItem, 'id' | 'name'>
): PluginMarketplaceItem {
  return {
    remotePluginId: String(overrides.id),
    displayName: overrides.name,
    description: '',
    version: '1.0.0',
    author: null,
    visibility: 'public',
    featured: false,
    installed: false,
    installedPluginId: null,
    enabled: false,
    sourceType: 'marketplace',
    interface: null,
    components: {
      skills: [],
      commands: [],
      agents: [],
      hooks: [],
      mcps: [],
      lsps: [],
      monitors: [],
      bins: [],
      connectors: [],
    },
    ownerUserId: 0,
    sourceLabel: '',
    latestReleaseId: null,
    manifest: {},
    ...overrides,
  }
}

export function installedItem(
  id: string,
  marketplaceId: string,
  pluginKey: string
): InstalledPluginItem {
  return {
    id,
    name: pluginKey,
    description: '',
    enabled: true,
    version: '1.0.0',
    origin: 'market',
    sourceLabel: marketplaceId,
    distribution: 'personal',
    updateAvailable: false,
    componentCounts: {},
    raw: {
      apiVersion: 'v1',
      kind: 'InstalledPlugin',
      metadata: { name: pluginKey, namespace: marketplaceId, labels: { id } },
      spec: {
        source: {
          type: 'local',
          providerKey: marketplaceId,
          pluginKey,
          marketplace: marketplaceId,
        },
        origin: 'market',
        displayName: pluginKey,
        description: '',
        installState: 'installed',
        enabled: true,
        componentStates: {},
        components: {
          skills: [],
          commands: [],
          agents: [],
          hooks: [],
          mcps: [],
          lsps: [],
          monitors: [],
          bins: [],
          connectors: [],
        },
        interface: null,
      },
      status: { state: 'enabled' },
    },
  }
}
