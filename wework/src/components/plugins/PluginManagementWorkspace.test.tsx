import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import {
  clearPluginMarketplaceCache,
  pluginMarketplaceCacheKey,
  setPluginMarketplaceCache,
} from '@/features/plugins/pluginMarketplaceCache'
import { navigateTo } from '@/lib/navigation'
import '@/i18n'
import { PluginManagementWorkspace } from './PluginManagementWorkspace'
import type { InstalledPluginItem } from './PluginManagementRows'
import type { PluginMarketplaceItem } from '@/types/api'

vi.mock('@/lib/navigation', () => ({
  navigateTo: vi.fn(),
}))

function cachedInstalledPlugin(): InstalledPluginItem {
  return {
    id: 'cached-1',
    name: 'Cached Plugin',
    description: 'From module cache',
    enabled: true,
    version: '1.0.0',
    origin: 'market',
    sourceLabel: 'Wework官方',
    distribution: 'public',
    updateAvailable: false,
    componentCounts: {},
    raw: {
      apiVersion: 'agent.wecode.io/v1',
      kind: 'InstalledPlugin',
      metadata: {
        name: 'cached-plugin',
        namespace: 'default',
        labels: { id: 'cached-1' },
      },
      spec: {
        source: {
          type: 'marketplace',
          providerKey: 'wegent',
          pluginKey: 'cached-plugin',
        },
        origin: 'market',
        displayName: 'Cached Plugin',
        description: 'From module cache',
        version: '1.0.0',
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
        packageRef: null,
        sourcePayload: null,
      },
      status: { state: 'enabled', devices: [] },
    },
  }
}

describe('PluginManagementWorkspace cache', () => {
  beforeEach(() => {
    clearPluginMarketplaceCache()
    vi.mocked(navigateTo).mockReset()
    window.localStorage.clear()
  })

  test('renders cached installed plugins immediately without the loading state', async () => {
    const key = pluginMarketplaceCacheKey('/api', 'cloud-token')
    setPluginMarketplaceCache({
      cacheKey: key,
      marketplaceItems: [],
      installedPlugins: [cachedInstalledPlugin()],
      marketplaces: [],
      selectedMarketplaceKey: '',
      deviceId: 'device-1',
      fetchedAt: Date.now(),
    })

    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise(() => {
            // Keep background refresh pending so the first paint is cache-only.
          })
      )
    )

    render(<PluginManagementWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)

    expect(screen.queryByText('正在加载插件')).not.toBeInTheDocument()
    expect(screen.getByText('Cached Plugin')).toBeInTheDocument()
    expect(screen.getByTestId('plugin-management-installed-list')).toBeInTheDocument()

    await waitFor(() => expect(fetch).toHaveBeenCalled())
  })

  test('opens marketplace plugin detail instead of a separate management detail page', async () => {
    const key = pluginMarketplaceCacheKey('/api', 'cloud-token')
    const installed = cachedInstalledPlugin()
    installed.id = 267250
    installed.name = '快速建站'
    installed.raw.metadata = {
      name: 'wegent-sites',
      namespace: 'default',
      labels: { id: 267250 },
    }
    installed.raw.spec.pluginId = 267250
    installed.raw.spec.source.pluginKey = 'wegent-sites'
    installed.raw.spec.displayName = '快速建站'
    const marketplaceItem = {
      id: 267250,
      remotePluginId: 'wegent-sites',
      name: 'wegent-sites',
      displayName: '快速建站',
      description: '',
      featured: false,
      installed: true,
      installedPluginId: 267250,
      enabled: true,
      sourceType: 'marketplace' as const,
      visibility: 'workspace' as const,
      ownerUserId: 1,
      components: installed.raw.spec.components,
      manifest: {},
      latestReleaseId: 6,
    } satisfies PluginMarketplaceItem
    setPluginMarketplaceCache({
      cacheKey: key,
      marketplaceItems: [marketplaceItem],
      installedPlugins: [installed],
      marketplaces: [],
      selectedMarketplaceKey: '',
      deviceId: 'device-1',
      fetchedAt: Date.now(),
    })

    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise(() => {
            // Keep background refresh pending so the first paint is cache-only.
          })
      )
    )

    render(<PluginManagementWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)

    await userEvent.click(screen.getByRole('button', { name: '查看 快速建站 详情' }))
    expect(navigateTo).toHaveBeenCalledWith('/plugins?plugin=wegent-sites&marketplace=wegent')
    expect(screen.queryByTestId('plugin-detail-toggle-267250')).not.toBeInTheDocument()
  })

  test('routes personal plugin publication to the canonical plugin workspace flow', async () => {
    const key = pluginMarketplaceCacheKey('/api', 'cloud-token')
    const installed = cachedInstalledPlugin()
    installed.id = 'created-1'
    installed.name = '智能工作台开发助手'
    installed.origin = 'created'
    installed.raw.metadata = {
      name: 'smart-workbench-dev-assistant',
      namespace: 'default',
      labels: { id: 'created-1' },
    }
    installed.raw.spec.origin = 'created'
    installed.raw.spec.source = {
      type: 'local',
      providerKey: 'local',
      pluginKey: 'smart-workbench-dev-assistant',
    }
    installed.raw.spec.displayName = installed.name
    setPluginMarketplaceCache({
      cacheKey: key,
      marketplaceItems: [],
      installedPlugins: [installed],
      marketplaces: [],
      selectedMarketplaceKey: '',
      deviceId: 'device-1',
      fetchedAt: Date.now(),
    })

    const fetchMock = vi.fn(
      () =>
        new Promise<Response>(() => {
          // Keep background refresh pending; publication must only navigate.
        })
    )
    vi.stubGlobal('fetch', fetchMock)

    render(<PluginManagementWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)

    await userEvent.click(screen.getByTestId('installed-plugin-actions-created-1'))
    await userEvent.click(screen.getByTestId('installed-plugin-publish-created-1'))

    expect(navigateTo).toHaveBeenCalledWith(
      '/plugins?plugin=smart-workbench-dev-assistant&marketplace=wework-personal'
    )
    expect(fetchMock).not.toHaveBeenCalledWith(
      expect.stringContaining('/plugins/submissions'),
      expect.objectContaining({ method: 'POST' })
    )
  })

  test('routes personal plugin access management to the same canonical workspace flow', async () => {
    const key = pluginMarketplaceCacheKey('/api', 'cloud-token')
    const installed = cachedInstalledPlugin()
    installed.id = 'created-owner'
    installed.name = '团队助手'
    installed.origin = 'created'
    installed.raw.metadata = {
      name: 'team-helper',
      namespace: 'default',
      labels: { id: 'created-owner' },
    }
    installed.raw.spec.origin = 'created'
    installed.raw.spec.source = {
      type: 'local',
      providerKey: 'local',
      pluginKey: 'team-helper',
    }
    installed.raw.spec.displayName = installed.name
    const ownedListing = {
      id: 901,
      remotePluginId: 'team-helper',
      name: 'team-helper',
      displayName: installed.name,
      description: '',
      featured: false,
      installed: true,
      installedPluginId: 'created-owner',
      enabled: true,
      sourceType: 'marketplace' as const,
      visibility: 'personal' as const,
      ownerUserId: 1,
      accessRole: 'owner' as const,
      components: installed.raw.spec.components,
      manifest: {},
      latestReleaseId: 12,
    } satisfies PluginMarketplaceItem
    setPluginMarketplaceCache({
      cacheKey: key,
      marketplaceItems: [ownedListing],
      installedPlugins: [installed],
      marketplaces: [],
      selectedMarketplaceKey: '',
      deviceId: 'device-1',
      fetchedAt: Date.now(),
    })

    const fetchMock = vi.fn(
      () =>
        new Promise<Response>(() => {
          // Keep background refresh pending; access management must only navigate.
        })
    )
    vi.stubGlobal('fetch', fetchMock)

    render(<PluginManagementWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)

    await userEvent.click(screen.getByTestId('installed-plugin-actions-created-owner'))
    await userEvent.click(screen.getByTestId('installed-plugin-share-created-owner'))

    expect(navigateTo).toHaveBeenCalledWith(
      '/plugins?plugin=team-helper&marketplace=wework-personal'
    )
    expect(fetchMock).not.toHaveBeenCalledWith(
      expect.stringContaining('/plugins/marketplace/901/access'),
      expect.anything()
    )
  })
})
