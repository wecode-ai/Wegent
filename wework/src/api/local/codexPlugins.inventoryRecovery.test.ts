import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  deviceId: 'device-a',
  failCodex: false,
  emptyCodex: false,
}))

vi.mock('@/lib/runtime-environment', () => ({
  isDesktopRuntime: () => true,
  isElectronRuntime: () => true,
}))
vi.mock('@/desktop/localExecutor', () => ({
  ensureLocalExecutorStarted: async () => ({ deviceId: mocks.deviceId }),
  getKnownLocalExecutorDeviceId: () => mocks.deviceId,
  ensureBundledPluginMarketplaceRegistered: async () => {},
  getInitializedBundledPluginMarketplace: () => null,
  requestLocalExecutor: async (method: string, params: { method?: string }) => {
    const source = method === 'codex.app_server_request' ? params.method : method
    if (source === 'executor.plugins.store.list') return { storePath: '/store', plugins: [] }
    if (source === 'plugin/installed') {
      if (mocks.failCodex) throw new Error('Codex membership unavailable')
      return {
        marketplaces: mocks.emptyCodex
          ? []
          : [
              {
                name: 'openai-curated-remote',
                path: '/remote',
                plugins: [{ name: 'codex-tool', installed: true, enabled: true }],
              },
            ],
      }
    }
    throw new Error(`Unexpected inventory source: ${source}`)
  },
}))

async function inventorySession() {
  const { createLocalCodexPluginApi } = await import('./codexPlugins')
  const cache = await import('@/features/plugins/pluginMarketplaceCache')
  const { refreshInstalledPluginInventory } = await import('@/features/plugins/pluginInventory')
  const api = createLocalCodexPluginApi()
  return {
    ...cache,
    refresh: (cacheKey = 'account-a') =>
      refreshInstalledPluginInventory({
        cacheKey,
        deviceId: mocks.deviceId,
        readLocal: () => api.listInstalledPlugins({ refresh: true }),
        readCloud: async () => ({ items: [] }),
        isCurrent: () => true,
      }),
  }
}

beforeEach(() => {
  window.localStorage.clear()
  window.sessionStorage.clear()
  mocks.deviceId = 'device-a'
  mocks.failCodex = false
  mocks.emptyCodex = false
  vi.resetModules()
})

afterEach(async () => {
  const { clearPluginMarketplaceCache } = await import('@/features/plugins/pluginMarketplaceCache')
  clearPluginMarketplaceCache()
})

describe('persistent installed source recovery', () => {
  test('retains failed Codex membership across restart, then clears only on successful empty reads', async () => {
    let session = await inventorySession()
    await session.refresh()
    const fetchedAt = session.getPluginMarketplaceCache('account-a')!.installedPluginsFetchedAt
    session.flushPluginMarketplaceCachePersist()

    vi.resetModules()
    session = await inventorySession()
    mocks.failCodex = true
    await expect(session.refresh()).rejects.toThrow('incomplete')
    expect(
      session
        .getPluginMarketplaceCache('account-a')
        ?.installedPlugins.map(plugin => plugin.spec.source.pluginKey)
    ).toEqual(['codex-tool'])
    expect(session.getPluginMarketplaceCache('account-a')?.installedPluginsFetchedAt).toBe(
      fetchedAt
    )
    session.flushPluginMarketplaceCachePersist()

    vi.resetModules()
    session = await inventorySession()
    await expect(session.refresh()).rejects.toThrow('incomplete')
    expect(session.getPluginMarketplaceCache('account-a')?.installedPlugins).toHaveLength(1)

    mocks.failCodex = false
    await session.refresh()
    expect(session.getPluginMarketplaceCache('account-a')?.installedPlugins).toHaveLength(1)
    mocks.emptyCodex = true
    await session.refresh()
    expect(session.getPluginMarketplaceCache('account-a')?.installedPlugins).toEqual([])
    session.flushPluginMarketplaceCachePersist()

    vi.resetModules()
    session = await inventorySession()
    mocks.failCodex = true
    await expect(session.refresh()).rejects.toThrow('incomplete')
    expect(session.getPluginMarketplaceCache('account-a')?.installedPlugins).toEqual([])
  })

  test.each(['account', 'device'] as const)(
    'never restores a failed source from another %s',
    async scope => {
      let session = await inventorySession()
      await session.refresh()
      session.flushPluginMarketplaceCachePersist()
      vi.resetModules()
      session = await inventorySession()
      mocks.failCodex = true
      if (scope === 'device') mocks.deviceId = 'device-b'
      const key = scope === 'account' ? 'account-b' : 'account-a'
      await expect(session.refresh(key)).rejects.toThrow('incomplete')
      expect(session.getPluginMarketplaceCache(key)?.installedPlugins ?? []).toEqual([])
    }
  )
})
