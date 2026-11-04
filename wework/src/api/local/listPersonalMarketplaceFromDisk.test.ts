// @vitest-environment node

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
