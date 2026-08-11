import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { invoke, isTauri } from '@tauri-apps/api/core'
import {
  clearPluginMarketplaceCache,
  pluginMarketplaceCacheKey,
  setPluginMarketplaceCache,
} from '@/features/plugins/pluginMarketplaceCache'
import '@/i18n'
import { PluginManagementWorkspace } from './PluginManagementWorkspace'
import type { InstalledPluginItem } from './PluginManagementRows'

vi.mock('@tauri-apps/api/core', () => ({
  convertFileSrc: vi.fn((path: string) => `asset://localhost/${path.replace(/^\/+/, '')}`),
  invoke: vi.fn(),
  isTauri: vi.fn(() => false),
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
    vi.mocked(invoke).mockReset()
    vi.mocked(isTauri).mockReturnValue(false)
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
      canPublish: false,
      canSharePersonalPlugins: true,
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
})
