import { beforeEach, describe, expect, test, vi } from 'vitest'
import { listPersonalMarketplacePluginsFromDisk } from './codexPlugins'

const mocks = vi.hoisted(() => ({
  requestLocalExecutor: vi.fn(),
  ensureLocalExecutorStarted: vi.fn(),
  getInitializedBundledPluginMarketplace: vi.fn(),
}))

vi.mock('@/lib/runtime-environment', () => ({
  isDesktopRuntime: () => true,
  isElectronRuntime: () => true,
}))

vi.mock('@/desktop/localExecutor', () => ({
  ensureLocalExecutorStarted: () => mocks.ensureLocalExecutorStarted(),
  ensureBundledPluginMarketplaceRegistered: vi.fn(),
  getInitializedBundledPluginMarketplace: () => mocks.getInitializedBundledPluginMarketplace(),
  requestLocalExecutor: (...args: unknown[]) => mocks.requestLocalExecutor(...args),
  resetLocalExecutorStateForTests: vi.fn(),
}))

describe('listPersonalMarketplacePluginsFromDisk', () => {
  beforeEach(() => {
    mocks.requestLocalExecutor.mockReset()
    mocks.ensureLocalExecutorStarted.mockReset()
    mocks.getInitializedBundledPluginMarketplace.mockReset()
    mocks.ensureLocalExecutorStarted.mockResolvedValue({ deviceId: 'local-device' })
    mocks.getInitializedBundledPluginMarketplace.mockReturnValue({
      id: 'wework-personal',
      path: '/tmp/wework-personal',
      pluginCount: 1,
    })
  })

  test('maps disk personal plugins as available without inferring installation', async () => {
    mocks.requestLocalExecutor.mockResolvedValue({
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
          marketplacePath: '/Users/test/.agents/plugins/marketplace.json',
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
      installed: false,
      installedLocally: false,
      installedPluginId: null,
      enabled: false,
      manifest: expect.objectContaining({
        marketplaceId: 'wework-personal',
        marketplacePath: '/Users/test/.agents/plugins/marketplace.json',
      }),
    })
    expect(mocks.ensureLocalExecutorStarted).not.toHaveBeenCalled()
    expect(mocks.requestLocalExecutor).toHaveBeenCalledWith('executor.plugins.personal.list', {
      marketplacePath: '/tmp/wework-personal',
    })
    expect(
      mocks.requestLocalExecutor.mock.calls.some(
        ([method]) => method === 'codex.app_server_request'
      )
    ).toBe(false)
  })

  test('invokes disk list with empty marketplacePath when bundled path is unavailable', async () => {
    mocks.getInitializedBundledPluginMarketplace.mockReturnValue(null)
    mocks.requestLocalExecutor.mockResolvedValue({
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
    expect(items[0]).toMatchObject({
      name: 'dev-tools',
      installed: false,
      installedLocally: false,
      installedPluginId: null,
    })
    expect(mocks.requestLocalExecutor).toHaveBeenCalledWith('executor.plugins.personal.list', {
      marketplacePath: '',
    })
  })
})
