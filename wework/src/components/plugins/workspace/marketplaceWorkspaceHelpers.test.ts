import { describe, expect, test, vi } from 'vitest'
import { navigateTo } from '@/lib/navigation'
import type { InstalledPlugin, PluginMarketplaceItem } from '@/types/api'
import type { InstalledPluginItem } from '../PluginManagementRows'
import {
  keepRicherMarketplacePluginDetail,
  pluginDetailActionErrorMessage,
  pluginUsesWegentConnectorOAuth,
  queueMarketplacePluginTrial,
} from './marketplaceWorkspaceHelpers'

vi.mock('@/lib/navigation', () => ({
  navigateTo: vi.fn(),
}))

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

function githubMarketplaceItem(): PluginMarketplaceItem {
  return {
    id: 'github@openai-curated-remote',
    remotePluginId: 'plugin_connector_1p_github',
    name: 'github',
    displayName: 'GitHub',
    description: 'Connect GitHub',
    version: '0.1.8',
    visibility: 'public',
    featured: false,
    installed: true,
    installedPluginId: 'github@openai-curated-remote',
    installedLocally: true,
    enabled: true,
    sourceType: 'marketplace',
    sourceProvider: 'codex',
    sourceLabel: 'OpenAI 官方',
    components: emptyComponents,
    manifest: { marketplaceId: 'openai-curated-remote' },
    ownerUserId: 0,
    latestReleaseId: null,
    interface: {
      displayName: 'GitHub',
      shortDescription: 'Connect GitHub',
      category: 'Developer Tools',
      defaultPrompt: ['Inspect pull requests and failing checks'],
    },
  }
}

function githubInstalledItem(): InstalledPluginItem {
  const raw: InstalledPlugin = {
    apiVersion: 'agent.wecode.io/v1',
    kind: 'InstalledPlugin',
    metadata: {
      name: 'github',
      namespace: 'openai-curated-remote',
      labels: { id: 'github@openai-curated-remote' },
    },
    spec: {
      source: {
        type: 'marketplace',
        providerKey: 'openai-curated-remote',
        pluginKey: 'github',
        marketplace: 'openai-curated-remote',
      },
      origin: 'market',
      displayName: 'GitHub',
      description: 'Connect GitHub',
      version: '0.1.8',
      installState: 'installed',
      enabled: true,
      componentStates: {},
      components: emptyComponents,
      interface: {
        displayName: 'GitHub',
        defaultPrompt: ['Inspect pull requests and failing checks'],
      },
      packageRef: null,
      sourcePayload: { marketplaceName: 'openai-curated-remote', pluginName: 'github' },
    },
    status: { state: 'enabled' },
  }
  return {
    id: 'github@openai-curated-remote',
    name: 'GitHub',
    description: 'Connect GitHub',
    enabled: true,
    version: '0.1.8',
    origin: 'market',
    sourceLabel: 'OpenAI 官方',
    distribution: 'official',
    updateAvailable: false,
    componentCounts: {},
    raw,
  }
}

describe('queueMarketplacePluginTrial', () => {
  test('queues an OpenAI official plugin from in-memory detail without extra Codex reads', () => {
    const rememberMarketplaceSelection = vi.fn()
    vi.mocked(navigateTo).mockClear()
    window.sessionStorage.clear()

    expect(
      queueMarketplacePluginTrial({
        item: githubMarketplaceItem(),
        installed: githubInstalledItem(),
        rememberMarketplaceSelection,
      })
    ).toBe(true)

    expect(rememberMarketplaceSelection).toHaveBeenCalledWith('openai-curated-remote')
    expect(navigateTo).toHaveBeenCalledWith('/')
    expect(
      JSON.parse(window.sessionStorage.getItem('wework:pending-plugin-trial') ?? '{}')
    ).toEqual(
      expect.objectContaining({
        input:
          '[$GitHub](plugin://github@openai-curated-remote) Inspect pull requests and failing checks',
        pluginName: 'GitHub',
        openInNewChat: true,
      })
    )
  })
})

describe('pluginUsesWegentConnectorOAuth', () => {
  test('skips Wegent OAuth for OpenAI official marketplace and installed plugins', () => {
    expect(pluginUsesWegentConnectorOAuth(githubMarketplaceItem())).toBe(false)
    expect(pluginUsesWegentConnectorOAuth(githubInstalledItem())).toBe(false)
  })

  test('uses Wegent OAuth for cloud marketplace plugins', () => {
    const item: PluginMarketplaceItem = {
      ...githubMarketplaceItem(),
      id: 101,
      remotePluginId: 'wegent-github',
      latestReleaseId: 1001,
      sourceProvider: 'wegent',
      sourceLabel: 'Wegent 官方',
      manifest: { marketplaceId: 'default' },
    }
    expect(pluginUsesWegentConnectorOAuth(item)).toBe(true)
  })
})

describe('pluginDetailActionErrorMessage', () => {
  test('only returns the message for the plugin that produced the error', () => {
    const error = {
      pluginId: 'github@openai-curated-remote',
      message: 'Connector app not found',
    }
    expect(pluginDetailActionErrorMessage(error, 'github@openai-curated-remote')).toBe(
      'Connector app not found'
    )
    expect(pluginDetailActionErrorMessage(error, 'gmail@openai-curated-remote')).toBeNull()
    expect(pluginDetailActionErrorMessage(null, 'github@openai-curated-remote')).toBeNull()
  })
})

describe('keepRicherMarketplacePluginDetail', () => {
  test('keeps previously loaded skills when a later catalog row has empty components', () => {
    const empty = githubInstalledItem()
    const rich: InstalledPluginItem = {
      ...empty,
      raw: {
        ...empty.raw,
        spec: {
          ...empty.raw.spec,
          components: {
            ...emptyComponents,
            skills: [{ name: 'ci-debug', description: 'Debug failing checks', path: 'ci-debug' }],
            apps: [
              {
                name: 'GitHub',
                path: 'github',
                description: 'Access repositories, issues, and pull requests.',
              },
            ],
          },
        },
      },
    }

    const kept = keepRicherMarketplacePluginDetail(rich, empty)
    expect(kept.raw.spec.components.skills).toEqual([
      { name: 'ci-debug', description: 'Debug failing checks', path: 'ci-debug' },
    ])
    expect(kept.raw.spec.components.apps).toEqual([
      {
        name: 'GitHub',
        path: 'github',
        description: 'Access repositories, issues, and pull requests.',
      },
    ])
  })
})
