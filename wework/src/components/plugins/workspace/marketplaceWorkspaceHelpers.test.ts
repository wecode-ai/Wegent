import { navigateTo } from '@/lib/navigation'
import type { InstalledPlugin, PluginMarketplaceItem } from '@/types/api'
import { describe, expect, test, vi } from 'vitest'
import type { InstalledPluginItem } from '../PluginManagementRows'
import {
  createDefaultPluginApi,
  marketplacePluginDetailSelectionKey,
  pluginDetailActionErrorMessage,
  pluginUsesWegentConnectorOAuth,
  queueMarketplacePluginTrial,
  requiredConnectionNames,
  resolveMarketplaceUninstallId,
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

test('account connections do not require legacy login during plugin installation', () => {
  const item = githubMarketplaceItem()
  item.components = {
    ...emptyComponents,
    connectors: [
      {
        slug: 'github',
        authPolicy: 'on_install',
        accountAuth: { protocolVersion: 1, credentialType: 'oauth2', adapter: 'scripts/auth.py' },
      },
    ],
  }
  expect(requiredConnectionNames(item)).toEqual([])
  delete item.components.connectors![0].accountAuth
  expect(requiredConnectionNames(item)).toEqual(['GitHub'])
})

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

describe('resolveMarketplaceUninstallId', () => {
  test('prefers the actual installed inventory record over a stale marketplace id', () => {
    const item: PluginMarketplaceItem = {
      ...githubMarketplaceItem(),
      id: 54,
      installedPluginId: 54,
      name: 'documents',
      displayName: '文档',
      sourceProvider: 'wegent',
      sourceLabel: 'Wegent 官方',
      manifest: { marketplaceId: 'wegent' },
    }
    const installed = githubInstalledItem()
    installed.id = '269646-wegent-documents-0.1.3'
    installed.name = '文档'
    installed.raw.metadata = {
      name: 'documents',
      namespace: 'wegent',
      labels: { id: '269646-wegent-documents-0.1.3' },
    }
    installed.raw.spec.source = {
      type: 'marketplace',
      providerKey: 'wegent',
      pluginKey: 'documents',
      marketplace: 'wegent',
    }
    installed.raw.spec.sourcePayload = {
      managedByWegent: true,
      cloudInstalledPluginId: 269646,
      marketplaceName: 'wegent',
    }

    expect(resolveMarketplaceUninstallId(item, [installed])).toBe('269646-wegent-documents-0.1.3')
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

describe('marketplacePluginDetailSelectionKey', () => {
  test('separates same-name personal and enterprise cloud listings', () => {
    const enterprise = githubMarketplaceItem()
    enterprise.id = 22
    enterprise.name = 'ip-location'
    enterprise.version = '0.3.0'
    enterprise.visibility = 'workspace'
    enterprise.accessRole = 'catalog'
    enterprise.sourceProvider = 'wegent'
    enterprise.manifest = {}

    const personal = {
      ...enterprise,
      id: 21,
      version: '0.1.0',
      visibility: 'personal' as const,
      accessRole: 'owner' as const,
      sourceProvider: 'user' as const,
    }

    expect(marketplacePluginDetailSelectionKey(enterprise)).not.toBe(
      marketplacePluginDetailSelectionKey(personal)
    )
  })
})

describe('plugin HTTP profile credentials', () => {
  test('captures the implicit token so an old API cannot read a replacement account token', async () => {
    localStorage.setItem('auth_token', 'original-account')
    const api = createDefaultPluginApi('/api')
    localStorage.setItem('auth_token', 'replacement-account')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ items: [] })))
    try {
      await api.listInstalledPlugins()
      const options = vi.mocked(fetch).mock.calls[0][1]
      expect(new Headers(options?.headers).get('Authorization')).toBe('Bearer original-account')
    } finally {
      localStorage.removeItem('auth_token')
      vi.unstubAllGlobals()
    }
  })

  test.each([
    { token: undefined, redirects: true },
    { token: 'explicit-cloud-account', redirects: false },
    { token: null, redirects: false },
  ])('preserves the existing 401 redirect policy: %o', async ({ token, redirects }) => {
    localStorage.setItem('auth_token', 'implicit-account')
    vi.mocked(navigateTo).mockClear()
    const api = createDefaultPluginApi('/api', token)
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(Response.json({ detail: 'Unauthorized' }, { status: 401 }))
    )
    try {
      await expect(api.listInstalledPlugins()).rejects.toMatchObject({ status: 401 })
      if (redirects) expect(navigateTo).toHaveBeenCalledExactlyOnceWith('/login')
      else expect(navigateTo).not.toHaveBeenCalled()
    } finally {
      localStorage.removeItem('auth_token')
      vi.mocked(navigateTo).mockClear()
      vi.unstubAllGlobals()
    }
  })
})
