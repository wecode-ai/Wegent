import { beforeEach, describe, expect, test, vi } from 'vitest'
import {
  clearLocalCodexPluginsReadStateCache,
  listWegentStorePluginsFromDisk,
} from './codexPlugins'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mocks.invoke(...args),
}))

vi.mock('@/lib/runtime-environment', () => ({
  isDesktopRuntime: () => true,
  isTauriRuntime: () => true,
}))

vi.mock('@/tauri/localExecutor', () => ({
  ensureLocalExecutorStarted: vi.fn(),
  ensureBundledPluginMarketplaceRegistered: vi.fn(),
  getInitializedBundledPluginMarketplace: vi.fn(),
  requestLocalExecutor: vi.fn(),
  resetLocalExecutorStateForTests: vi.fn(),
}))

describe('listWegentStorePluginsFromDisk', () => {
  beforeEach(() => {
    mocks.invoke.mockReset()
    clearLocalCodexPluginsReadStateCache()
  })

  test('maps unpacked store directories as local Codex membership', async () => {
    mocks.invoke.mockResolvedValue({
      storePath: '/Users/test/.wework/apps/com.weibo.wework/capabilities/store/plugins',
      plugins: [
        {
          name: 'sina-email',
          packageId: '269646-wegent-sina-email-0.1.11',
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
      },
    })
    expect(plugins[0]?.spec.pluginId).toBeUndefined()
    expect(mocks.invoke).toHaveBeenCalledWith('local_executor_list_wegent_store_plugins')
  })

  test('treats a missing disk listing as empty membership', async () => {
    mocks.invoke.mockResolvedValue(undefined)

    await expect(listWegentStorePluginsFromDisk()).resolves.toEqual([])
  })
})
