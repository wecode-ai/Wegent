import { beforeEach, describe, expect, test, vi } from 'vitest'
import {
  clearLocalCodexPluginsReadStateCache,
  listLocalInstalledPluginsFromDisk,
  listWegentStorePluginsFromDisk,
} from './codexPlugins'

const mocks = vi.hoisted(() => ({
  requestLocalExecutor: vi.fn(),
}))

vi.mock('@/lib/runtime-environment', () => ({
  isDesktopRuntime: () => true,
  isElectronRuntime: () => true,
}))

vi.mock('@/desktop/localExecutor', () => ({
  ensureLocalExecutorStarted: vi.fn(),
  ensureBundledPluginMarketplaceRegistered: vi.fn(),
  getInitializedBundledPluginMarketplace: vi.fn(),
  requestLocalExecutor: (...args: unknown[]) => mocks.requestLocalExecutor(...args),
  resetLocalExecutorStateForTests: vi.fn(),
}))

describe('listWegentStorePluginsFromDisk', () => {
  beforeEach(() => {
    mocks.requestLocalExecutor.mockReset()
    clearLocalCodexPluginsReadStateCache()
  })

  test('maps unpacked store directories as local Codex membership', async () => {
    mocks.requestLocalExecutor.mockResolvedValue({
      storePath: '/Users/test/.wework/apps/com.weibo.wework/capabilities/store/plugins',
      plugins: [
        {
          name: 'sina-email',
          packageId: '269646-wegent-sina-email-0.1.11',
          installedPluginId: 269646,
          marketplace: 'wegent',
          version: '0.1.11',
          enabled: true,
          displayName: 'Sina Email',
          description: 'Read email',
          logo: './assets/icon.png',
          category: 'Productivity',
          pluginPath:
            '/Users/test/.wework/apps/com.weibo.wework/capabilities/store/plugins/269646-wegent-sina-email-0.1.11',
        },
      ],
    })

    const plugins = await listWegentStorePluginsFromDisk()

    expect(plugins).toHaveLength(1)
    expect(plugins[0]).toMatchObject({
      metadata: {
        name: 'sina-email',
        namespace: 'wegent',
        labels: { id: '269646-wegent-sina-email-0.1.11' },
      },
      spec: {
        source: {
          type: 'marketplace',
          marketplace: 'wegent',
          pluginKey: 'sina-email',
        },
        origin: 'market',
        displayName: 'Sina Email',
        description: 'Read email',
        version: '0.1.11',
        installState: 'installed',
        interface: {
          displayName: 'Sina Email',
          logo: '/Users/test/.wework/apps/com.weibo.wework/capabilities/store/plugins/269646-wegent-sina-email-0.1.11/assets/icon.png',
          category: 'Productivity',
        },
        sourcePayload: {
          managedByWegent: true,
          cloudInstalledPluginId: 269646,
        },
      },
    })
    expect(plugins[0]?.spec.pluginId).toBeUndefined()
    expect(mocks.requestLocalExecutor).toHaveBeenCalledWith('executor.plugins.store.list')
  })

  test('lists local Codex installs without requesting either remote catalog', async () => {
    mocks.requestLocalExecutor.mockImplementation(async (method: string) => {
      if (method === 'executor.plugins.store.list') {
        return { storePath: '/store', plugins: [] }
      }
      if (method === 'executor.plugins.personal.list') {
        return {
          marketplaceId: 'wework-personal',
          marketplacePath: '/tmp/wework-personal',
          plugins: [
            {
              name: 'installed-tool',
              pluginPath: '/tmp/wework-personal/plugins/installed-tool',
            },
            {
              name: 'available-tool',
              pluginPath: '/tmp/wework-personal/plugins/available-tool',
            },
          ],
        }
      }
      if (method === 'executor.codex_home.config.read') {
        return {
          codexHome: '/tmp/codex',
          configPath: '/tmp/codex/config.toml',
          remoteAppsEnabled: true,
          enabledPluginKeys: ['installed-tool@wework-personal'],
        }
      }
      if (method === 'executor.plugins.links.list') return []
      throw new Error(`Unexpected executor method: ${method}`)
    })

    const plugins = await listLocalInstalledPluginsFromDisk()

    expect(plugins.map(plugin => plugin.metadata.name)).toEqual(['installed-tool'])
    expect(
      mocks.requestLocalExecutor.mock.calls.some(
        ([method]) => method === 'codex.app_server_request'
      )
    ).toBe(false)
  })

  test('keeps a managed personal share linked to its cloud catalog identity', async () => {
    mocks.requestLocalExecutor.mockResolvedValue({
      storePath: '/Users/test/.wework/apps/com.weibo.wework/capabilities/store/plugins',
      plugins: [
        {
          name: 'dailydata-monitor',
          packageId: '524804-wework-personal-dailydata-monitor-0.16.3',
          installedPluginId: 524804,
          cloudPluginId: 32,
          marketplace: 'wework-personal',
          version: '0.16.3',
          enabled: true,
          displayName: 'Daily Data Monitor',
          pluginPath:
            '/Users/test/.wework/apps/com.weibo.wework/capabilities/store/plugins/524804-wework-personal-dailydata-monitor-0.16.3',
        },
      ],
    })

    const plugins = await listWegentStorePluginsFromDisk()

    expect(plugins).toHaveLength(1)
    expect(plugins[0]).toMatchObject({
      spec: {
        origin: 'market',
        source: {
          type: 'marketplace',
          marketplace: 'wework-personal',
          pluginKey: 'dailydata-monitor',
        },
        sourcePayload: {
          managedByWegent: true,
          cloudPluginId: 32,
          cloudInstalledPluginId: 524804,
        },
      },
    })
  })

  test('treats a missing disk listing as empty membership', async () => {
    mocks.requestLocalExecutor.mockResolvedValue(undefined)

    await expect(listWegentStorePluginsFromDisk()).resolves.toEqual([])
  })
})
