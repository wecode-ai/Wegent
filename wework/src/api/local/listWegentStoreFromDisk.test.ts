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
          name: '269646-wegent-sina-email-0.1.11',
          version: '0.1.11',
          pluginPath:
            '/Users/test/.wework/apps/com.weibo.wework/capabilities/store/plugins/269646-wegent-sina-email-0.1.11',
        },
      ],
    })

    const plugins = await listWegentStorePluginsFromDisk()

    expect(plugins).toHaveLength(1)
    expect(plugins[0]).toMatchObject({
      metadata: {
        name: '269646-wegent-sina-email-0.1.11',
        namespace: 'wegent',
        labels: { id: '269646-wegent-sina-email-0.1.11' },
      },
      spec: {
        source: {
          type: 'marketplace',
          marketplace: 'wegent',
          pluginKey: '269646-wegent-sina-email-0.1.11',
        },
        origin: 'market',
        version: '0.1.11',
        installState: 'installed',
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
