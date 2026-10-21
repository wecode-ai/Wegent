import { beforeEach, describe, expect, test, vi } from 'vitest'
import {
  clearLocalCodexPluginsReadStateCache,
  createLocalCodexPluginApi,
  listLocalInstalledPluginsFromDisk,
  listPersonalMarketplacePluginsFromDisk,
  peekLocalCodexPluginsReadState,
} from './codexPlugins'

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  deviceId: 'device-a',
  bundled: null as { id: string; path: string } | null,
}))
vi.mock('@/lib/runtime-environment', () => ({
  isDesktopRuntime: () => true,
  isElectronRuntime: () => true,
}))
vi.mock('@/desktop/localExecutor', () => ({
  requestLocalExecutor: (...args: unknown[]) => mocks.request(...args),
  ensureLocalExecutorStarted: async () => ({ deviceId: mocks.deviceId }),
  ensureBundledPluginMarketplaceRegistered: async () => {},
  getKnownLocalExecutorDeviceId: () => mocks.deviceId,
  getInitializedBundledPluginMarketplace: () => mocks.bundled,
}))

describe('local plugin source isolation', () => {
  const marketplace = {
    name: 'wework-personal',
    path: '/personal',
    plugins: [{ name: 'codex-tool', installed: true, enabled: true }],
  }
  const store = {
    storePath: '/store',
    plugins: [
      {
        name: 'managed-tool',
        packageId: 'managed-tool@wegent',
        marketplace: 'wegent',
        enabled: true,
        pluginPath: '/store/managed-tool',
      },
    ],
  }
  const personal = {
    marketplaceId: 'wework-personal',
    marketplacePath: '/personal',
    plugins: [{ name: 'personal-tool', pluginPath: '/personal/personal-tool' }],
  }
  let failures: Set<string>
  let empty: Set<string>
  beforeEach(() => {
    clearLocalCodexPluginsReadStateCache()
    mocks.deviceId = 'device-a'
    mocks.bundled = null
    failures = new Set()
    empty = new Set()
    mocks.request.mockReset().mockImplementation(async (method, params) => {
      const source = method === 'codex.app_server_request' ? params.method : method
      if (failures.has(source)) throw new Error(`${source} unavailable`)
      if (source === 'executor.plugins.store.list')
        return empty.has(source) ? { ...store, plugins: [] } : store
      if (source === 'executor.plugins.personal.list')
        return empty.has(source) ? { ...personal, plugins: [] } : personal
      if (source === 'executor.codex_home.config.read')
        return { enabledPluginKeys: empty.has(source) ? [] : ['personal-tool@wework-personal'] }
      if (source === 'executor.plugins.links.list') return []
      if (source === 'plugin/installed' || source === 'plugin/list')
        return { marketplaces: empty.has(source) ? [] : [marketplace] }
      throw new Error(`Unexpected source ${source}`)
    })
  })

  test.each([
    ['plugin/installed', 'managed-tool'],
    ['executor.plugins.store.list', 'codex-tool'],
  ])('returns a healthy source when %s fails and strict reads reject', async (source, retained) => {
    failures.add(source)
    const api = createLocalCodexPluginApi()
    const result = await api.listInstalledPlugins({ refresh: true })
    expect(result.items.map(item => item.spec.source.pluginKey)).toEqual([retained])
    expect(result.partial).toBe(true)
    await expect(api.listInstalledPlugins({ requireComplete: true })).rejects.toThrow('unavailable')
  })

  test('keeps only a failed source and clears it after an authoritative empty recovery', async () => {
    const api = createLocalCodexPluginApi()
    await api.listInstalledPlugins({ refresh: true })
    failures.add('executor.plugins.store.list')
    empty.add('plugin/installed')
    const partial = await api.listInstalledPlugins({ refresh: true })
    expect(partial.items.map(item => item.spec.source.pluginKey)).toEqual(['managed-tool'])
    expect(partial.partial).toBe(true)
    failures.clear()
    empty.add('executor.plugins.store.list')
    expect((await api.listInstalledPlugins({ refresh: true })).items).toEqual([])
  })

  test('does not retain another device and rejects a cold total failure', async () => {
    const api = createLocalCodexPluginApi()
    await api.listInstalledPlugins({ refresh: true })
    mocks.deviceId = 'device-b'
    failures.add('plugin/installed')
    failures.add('executor.plugins.store.list')
    await expect(api.listInstalledPlugins({ refresh: true })).rejects.toThrow('unavailable')
  })

  test.each(['executor.plugins.personal.list', 'executor.codex_home.config.read'])(
    'keeps managed and prior personal installs when %s fails',
    async source => {
      await listLocalInstalledPluginsFromDisk()
      failures.add(source)
      const result = await listLocalInstalledPluginsFromDisk()
      expect(result.map(item => item.spec.source.pluginKey).sort()).toEqual([
        'managed-tool',
        'personal-tool',
      ])
      empty.add(
        source === 'executor.plugins.personal.list'
          ? 'executor.codex_home.config.read'
          : 'executor.plugins.personal.list'
      )
      expect(
        (await listLocalInstalledPluginsFromDisk()).map(item => item.spec.source.pluginKey)
      ).toEqual(['managed-tool'])
    }
  )

  test('personal catalog errors reject while a successful empty directory clears it', async () => {
    failures.add('executor.plugins.personal.list')
    await expect(listPersonalMarketplacePluginsFromDisk()).rejects.toThrow('unavailable')
    failures.clear()
    empty.add('executor.plugins.personal.list')
    await expect(listPersonalMarketplacePluginsFromDisk()).resolves.toEqual([])
  })

  test.each(['plugin/installed', 'plugin/list', 'executor.plugins.store.list'])(
    'keeps the full read usable after %s fails',
    async source => {
      const api = createLocalCodexPluginApi()
      await api.readState({ mergeAllMarketplaces: true, refresh: true })
      failures.add(source)
      const result = await api.readState({ mergeAllMarketplaces: true, refresh: true })
      expect(result.partial).toBe(true)
      expect(result.marketplaceItems.map(item => item.name)).toEqual(['codex-tool'])
      expect(result.installedPlugins.map(item => item.spec.source.pluginKey).sort()).toEqual([
        'codex-tool',
        'managed-tool',
      ])
    }
  )

  test('a failed catalog cannot revive installs removed by successful membership reads', async () => {
    const api = createLocalCodexPluginApi()
    await api.readState({ mergeAllMarketplaces: true, refresh: true })
    failures.add('plugin/list')
    empty.add('plugin/installed')
    empty.add('executor.plugins.store.list')
    const result = await api.readState({ mergeAllMarketplaces: true, refresh: true })
    expect(result.marketplaceItems).toHaveLength(1)
    expect(result.installedPlugins).toEqual([])
    expect(result.marketplaceItems[0].installed).toBe(false)
  })

  test.each(['plugin/installed', 'plugin/list', 'executor.plugins.store.list'])(
    'isolates malformed rows in %s',
    async source => {
      const original = mocks.request.getMockImplementation()!
      mocks.request.mockImplementation(async (method, params) => {
        const current = method === 'codex.app_server_request' ? params.method : method
        if (current === source)
          return source === 'executor.plugins.store.list'
            ? { ...store, plugins: [null] }
            : { marketplaces: [{ ...marketplace, plugins: [null] }] }
        return original(method, params)
      })
      const result = await createLocalCodexPluginApi().readState({
        mergeAllMarketplaces: true,
        refresh: true,
      })
      expect(result.partial).toBe(true)
      expect(result.installedPlugins.length + result.marketplaceItems.length).toBeGreaterThan(0)
    }
  )

  test('does not migrate personal plugins from a partial snapshot', async () => {
    const original = mocks.request.getMockImplementation()!
    mocks.request.mockImplementation(async (method, params) =>
      method === 'codex.app_server_request'
        ? { marketplaces: [{ ...marketplace, name: 'personal' }] }
        : original(method, params)
    )
    failures.add('executor.plugins.store.list')
    expect(
      (await createLocalCodexPluginApi().readState({ mergeAllMarketplaces: true, refresh: true }))
        .partial
    ).toBe(true)
    expect(
      mocks.request.mock.calls.some(([method]) => method === 'executor.plugins.personal.ensure')
    ).toBe(false)
  })

  test('keeps source ownership session-only in the existing cache', async () => {
    await createLocalCodexPluginApi().readState({ mergeAllMarketplaces: true, refresh: true })
    const durable = window.localStorage.getItem('wework.plugins.codexCatalog.v1')
    expect(durable).toBeTruthy()
    expect(durable).not.toContain('installedSources')
  })

  test('publishes a fresh personal disk install over an older Codex personal cache', async () => {
    const api = createLocalCodexPluginApi()
    await api.readState({ mergeAllMarketplaces: true, refresh: true })
    await listLocalInstalledPluginsFromDisk()
    expect(
      (await api.listInstalledPlugins()).items.map(item => item.spec.source.pluginKey).sort()
    ).toEqual(['managed-tool', 'personal-tool'])
  })

  test('clears recovered inventory partial status while retaining an independent catalog failure', async () => {
    const api = createLocalCodexPluginApi()
    failures.add('executor.plugins.store.list')
    await api.readState({ mergeAllMarketplaces: true, refresh: true })
    failures.clear()
    await api.listInstalledPlugins({ refresh: true })
    expect(peekLocalCodexPluginsReadState({ mergeAllMarketplaces: true })?.partial).not.toBe(true)
    failures.add('plugin/list')
    await api.readState({ mergeAllMarketplaces: true, refresh: true })
    await api.listInstalledPlugins({ refresh: true })
    expect(peekLocalCodexPluginsReadState({ mergeAllMarketplaces: true })?.partial).toBe(true)
  })

  test('does not write a late disk read into another device cache', async () => {
    const original = mocks.request.getMockImplementation()!
    let resolveOld!: (value: typeof store) => void
    mocks.request.mockImplementation(async (method, params) => {
      if (method === 'executor.plugins.store.list' && mocks.deviceId === 'device-a')
        return new Promise(resolve => {
          resolveOld = resolve
        })
      if (method === 'executor.plugins.store.list' && !failures.has(method))
        return {
          ...store,
          plugins: [
            { ...store.plugins[0], name: 'device-b-tool', packageId: 'device-b-tool@wegent' },
          ],
        }
      return original(method, params)
    })
    const old = listLocalInstalledPluginsFromDisk()
    mocks.deviceId = 'device-b'
    await listLocalInstalledPluginsFromDisk()
    resolveOld(store)
    await old
    failures.add('executor.plugins.store.list')
    expect(
      (await listLocalInstalledPluginsFromDisk()).map(item => item.spec.source.pluginKey)
    ).toContain('device-b-tool')
  })

  test('treats malformed config keys as a failure instead of an empty enabled list', async () => {
    await listLocalInstalledPluginsFromDisk()
    const original = mocks.request.getMockImplementation()!
    mocks.request.mockImplementation(async (method, params) =>
      method === 'executor.codex_home.config.read'
        ? { enabledPluginKeys: [42] }
        : original(method, params)
    )
    expect(
      (await listLocalInstalledPluginsFromDisk()).map(item => item.spec.source.pluginKey)
    ).toContain('personal-tool')
  })

  test('retains failed link reads as partial and clears links only on successful empty reads', async () => {
    const original = mocks.request.getMockImplementation()!
    let linked = true
    mocks.request.mockImplementation(async (method, params) =>
      method === 'executor.plugins.links.list' && !failures.has(method)
        ? linked
          ? [{ localPluginName: 'codex-tool', cloudPluginId: 9, cloudReleaseId: 8 }]
          : []
        : original(method, params)
    )
    const api = createLocalCodexPluginApi()
    await api.readState({ mergeAllMarketplaces: true, refresh: true })
    failures.add('executor.plugins.links.list')
    const partial = await api.readState({ mergeAllMarketplaces: true, refresh: true })
    expect(partial.partial).toBe(true)
    expect(
      partial.installedPlugins.find(item => item.spec.source.pluginKey === 'codex-tool')?.spec
        .sourcePayload
    ).toMatchObject({ cloudPluginId: 9, cloudReleaseId: 8 })
    mocks.bundled = { id: 'wework-personal', path: '/personal' }
    await expect(api.listInstalledPlugins({ requireComplete: true })).rejects.toThrow('unavailable')
    failures.clear()
    linked = false
    const cleared = await api.readState({ mergeAllMarketplaces: true, refresh: true })
    expect(cleared.partial).not.toBe(true)
    const payload = cleared.installedPlugins.find(
      item => item.spec.source.pluginKey === 'codex-tool'
    )?.spec.sourcePayload
    expect(payload?.cloudPluginId).toBeUndefined()
    expect(payload?.cloudReleaseId).toBeUndefined()
  })

  test('keeps session membership when a different catalog selection peeks a durable directory', async () => {
    const api = createLocalCodexPluginApi()
    await api.readState({ mergeAllMarketplaces: true, refresh: true })
    await api.readState({ marketplaceId: 'wework-personal', refresh: true })
    failures.add('plugin/installed')
    failures.add('executor.plugins.store.list')
    const result = await api.listInstalledPlugins({ refresh: true })
    expect(result.partial).toBe(true)
    expect(result.items.map(item => item.spec.source.pluginKey).sort()).toEqual([
      'codex-tool',
      'managed-tool',
    ])
  })
})
