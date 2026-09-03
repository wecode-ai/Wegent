import { describe, expect, test } from 'vitest'
import type { InstalledPlugin, PluginMarketplaceItem } from '@/types/api'
import {
  installedPluginDistribution,
  installedPluginMarketplaceId,
  marketplaceItemMarketplaceId,
  marketplacePluginDistribution,
} from './pluginDistribution'

const emptyComponents = {
  skills: [],
  commands: [],
  agents: [],
  hooks: [],
  mcps: [],
  lsps: [],
  monitors: [],
  bins: [],
  connectors: [],
}

function marketplaceItem(
  overrides: Partial<PluginMarketplaceItem> &
    Pick<PluginMarketplaceItem, 'name' | 'sourceProvider' | 'visibility'>
): PluginMarketplaceItem {
  return {
    id: overrides.name,
    remotePluginId: overrides.name,
    displayName: overrides.name,
    description: '',
    version: '1.0.0',
    author: null,
    featured: false,
    installed: false,
    installedPluginId: null,
    enabled: false,
    sourceType: 'marketplace',
    interface: null,
    components: emptyComponents,
    ownerUserId: 0,
    sourceLabel: '',
    latestReleaseId: null,
    manifest: {},
    ...overrides,
  }
}

function installedPlugin(input: {
  name: string
  sourceProvider: NonNullable<InstalledPlugin['spec']['sourceProvider']>
  visibility: NonNullable<InstalledPlugin['spec']['visibility']>
  marketplace?: string | null
  marketplaceName?: string
  namespace?: string
  pluginId?: number
  origin?: InstalledPlugin['spec']['origin']
  sourceType?: InstalledPlugin['spec']['source']['type']
  providerKey?: string
}): InstalledPlugin {
  return {
    apiVersion: 'agent.wecode.io/v1',
    kind: 'InstalledPlugin',
    metadata: {
      name: input.name,
      namespace: input.namespace ?? 'default',
      labels: { id: input.name },
    },
    spec: {
      source: {
        type: input.sourceType ?? 'marketplace',
        providerKey: input.providerKey ?? input.namespace ?? 'default',
        pluginKey: input.name,
        catalogItemId: input.name,
        marketplace: input.marketplace ?? null,
      },
      origin: input.origin ?? 'market',
      sourceProvider: input.sourceProvider,
      sourceLabel: '',
      visibility: input.visibility,
      displayName: input.name,
      description: '',
      version: '1.0.0',
      installState: 'installed',
      enabled: true,
      componentStates: {},
      manifest: {},
      components: emptyComponents,
      interface: null,
      packageRef: null,
      pluginId: input.pluginId,
      sourcePayload: {
        marketplaceName: input.marketplaceName,
      },
    },
    status: { state: 'enabled' },
  }
}

describe('pluginDistribution', () => {
  test('maps personal marketplace plugins to personal distribution', () => {
    expect(
      marketplacePluginDistribution(
        marketplaceItem({
          name: 'my-skill',
          sourceProvider: 'user',
          visibility: 'workspace',
          manifest: { marketplaceId: 'wework-personal' },
        })
      )
    ).toBe('personal')
    expect(
      marketplacePluginDistribution(
        marketplaceItem({
          name: 'code-review',
          sourceProvider: 'user',
          visibility: 'public',
          manifest: { marketplaceId: 'personal' },
        })
      )
    ).toBe('personal')
    expect(
      marketplacePluginDistribution(
        marketplaceItem({
          name: 'legacy-public-creation',
          sourceProvider: 'user',
          visibility: 'public',
          accessRole: 'owner',
        })
      )
    ).toBe('personal')
  })

  test('maps OpenAI local marketplaces to official and user-added ones to external', () => {
    expect(
      marketplacePluginDistribution(
        marketplaceItem({
          name: 'mailagent',
          sourceProvider: 'codex',
          visibility: 'public',
          manifest: { marketplaceId: 'openai-bundled' },
        })
      )
    ).toBe('official')
    expect(
      marketplacePluginDistribution(
        marketplaceItem({
          name: 'superpowers',
          sourceProvider: 'codex',
          visibility: 'public',
          manifest: { marketplaceId: 'awesome-codex-plugins' },
        })
      )
    ).toBe('external')
  })

  test('maps wegent device marketplace plugins to workspace', () => {
    expect(
      marketplacePluginDistribution(
        marketplaceItem({
          name: 'echoid',
          sourceProvider: 'wegent',
          visibility: 'workspace',
          manifest: { marketplaceId: 'wegent' },
        })
      )
    ).toBe('workspace')
    expect(
      installedPluginDistribution(
        installedPlugin({
          name: 'echoid',
          namespace: 'wegent',
          marketplace: 'wegent',
          sourceProvider: 'wegent',
          visibility: 'workspace',
        })
      )
    ).toBe('workspace')
  })

  test('keeps cloud codex mirrors in official while preserving workspace cloud plugins', () => {
    expect(
      marketplacePluginDistribution(
        marketplaceItem({
          name: 'documents',
          sourceProvider: 'codex',
          visibility: 'public',
          latestReleaseId: 11,
        })
      )
    ).toBe('official')
    expect(
      marketplacePluginDistribution(
        marketplaceItem({
          name: 'dingtalk',
          sourceProvider: 'wegent',
          visibility: 'workspace',
          latestReleaseId: 12,
        })
      )
    ).toBe('workspace')
  })

  test('reads marketplace ids from catalog manifests and installed plugin sources', () => {
    expect(
      marketplaceItemMarketplaceId(
        marketplaceItem({
          name: 'aegis',
          sourceProvider: 'codex',
          visibility: 'public',
          manifest: { marketplaceId: 'awesome-codex-plugins' },
        })
      )
    ).toBe('awesome-codex-plugins')
    expect(
      installedPluginMarketplaceId(
        installedPlugin({
          name: 'echoid',
          marketplaceName: 'wegent',
          sourceProvider: 'wegent',
          visibility: 'workspace',
        })
      )
    ).toBe('wegent')
  })
})
