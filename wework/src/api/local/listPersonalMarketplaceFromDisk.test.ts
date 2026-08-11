import { beforeEach, describe, expect, test, vi } from 'vitest'
import { listPersonalMarketplacePluginsFromDisk } from './codexPlugins'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  ensureLocalExecutorStarted: vi.fn(),
  getInitializedBundledPluginMarketplace: vi.fn(),
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mocks.invoke(...args),
}))

vi.mock('@/lib/runtime-environment', () => ({
  isTauriRuntime: () => true,
}))

vi.mock('@/tauri/localExecutor', () => ({
  ensureLocalExecutorStarted: () => mocks.ensureLocalExecutorStarted(),
  ensureBundledPluginMarketplaceRegistered: vi.fn(),
  getInitializedBundledPluginMarketplace: () => mocks.getInitializedBundledPluginMarketplace(),
  requestLocalExecutor: vi.fn(),
  resetLocalExecutorStateForTests: vi.fn(),
}))

describe('listPersonalMarketplacePluginsFromDisk', () => {
  beforeEach(() => {
    mocks.invoke.mockReset()
    mocks.ensureLocalExecutorStarted.mockReset()
    mocks.getInitializedBundledPluginMarketplace.mockReset()
    mocks.ensureLocalExecutorStarted.mockResolvedValue({ deviceId: 'local-device' })
    mocks.getInitializedBundledPluginMarketplace.mockReturnValue({
      id: 'wework-personal',
      path: '/tmp/wework-personal',
      pluginCount: 1,
    })
  })

  test('maps disk personal plugins without calling Codex plugin/list', async () => {
    mocks.invoke.mockResolvedValue({
      marketplaceId: 'wework-personal',
      marketplacePath: '/tmp/wework-personal',
      plugins: [
        {
          name: 'notes',
          version: '1.2.0',
          displayName: 'Notes',
          description: 'Take notes',
          logo: './logo.png',
          category: 'Productivity',
          pluginPath: '/tmp/wework-personal/plugins/notes',
          installed: true,
        },
      ],
    })

    const items = await listPersonalMarketplacePluginsFromDisk()
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      name: 'notes',
      displayName: 'Notes',
      visibility: 'personal',
      sourceProvider: 'user',
      installed: true,
      installedLocally: true,
      manifest: expect.objectContaining({ marketplaceId: 'wework-personal' }),
    })
    expect(mocks.ensureLocalExecutorStarted).not.toHaveBeenCalled()
    expect(mocks.invoke).toHaveBeenCalledWith('local_executor_list_personal_marketplace_plugins', {
      marketplacePath: '/tmp/wework-personal',
    })
    expect(
      mocks.invoke.mock.calls.some(
        ([command, args]) =>
          command === 'local_executor_request' &&
          (args as { method?: string })?.method === 'codex.app_server_request'
      )
    ).toBe(false)
  })

  test('invokes disk list with empty marketplacePath when bundled path is unavailable', async () => {
    mocks.getInitializedBundledPluginMarketplace.mockReturnValue(null)
    mocks.invoke.mockResolvedValue({
      marketplaceId: 'wework-personal',
      marketplacePath: '/Users/test/.wework/capabilities/bundled-marketplaces/wework-personal',
      plugins: [
        {
          name: 'dev-tools',
          version: '0.1.0',
          displayName: 'Dev Tools',
          description: 'Tools',
          pluginPath: '/Users/test/.wework/codex/plugins/cache/wework-personal/dev-tools/0.1.0',
          installed: true,
        },
      ],
    })

    const items = await listPersonalMarketplacePluginsFromDisk()
    expect(items).toHaveLength(1)
    expect(items[0]?.name).toBe('dev-tools')
    expect(mocks.invoke).toHaveBeenCalledWith('local_executor_list_personal_marketplace_plugins', {
      marketplacePath: '',
    })
  })
})
