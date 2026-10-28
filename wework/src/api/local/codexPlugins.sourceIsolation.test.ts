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
    expect(durable).not.toContain('installedPartial')
    expect(durable).not.toContain('installedReadGeneration')
    expect(JSON.parse(durable!).entries['|all|all-kinds'].state.catalogPartial).toBe(false)
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

  test.each(['installed', 'catalog'])(
    'keeps fresh disk personal rows after a failed Codex %s refresh',
    async read => {
      const api = createLocalCodexPluginApi()
      await api.readState({ mergeAllMarketplaces: true, refresh: true })
      await listLocalInstalledPluginsFromDisk()
      failures.add('plugin/installed')

      const plugins =
        read === 'installed'
          ? (await api.listInstalledPlugins({ refresh: true })).items
          : (await api.readState({ mergeAllMarketplaces: true, refresh: true })).installedPlugins
      expect(plugins.map(item => item.spec.source.pluginKey).sort()).toEqual([
        'managed-tool',
        'personal-tool',
      ])
    }
  )

  test.each(['executor.plugins.personal.list', 'executor.codex_home.config.read'])(
    'does not revive removed personal rows after a successful empty %s and a Codex failure',
    async source => {
      const api = createLocalCodexPluginApi()
      await api.readState({ mergeAllMarketplaces: true, refresh: true })
      await listLocalInstalledPluginsFromDisk()
      empty.add(source)
      await listLocalInstalledPluginsFromDisk()
      failures.add('plugin/installed')

      const result = await api.listInstalledPlugins({ refresh: true })
      expect(result.partial).toBe(true)
      expect(result.items.map(item => item.spec.source.pluginKey)).toEqual(['managed-tool'])
    }
  )

  test('retains other Codex markets beside fresh personal rows and clears them on empty recovery', async () => {
    const original = mocks.request.getMockImplementation()!
    mocks.request.mockImplementation(async (method, params) => {
      const source = method === 'codex.app_server_request' ? params.method : method
      if (source === 'plugin/installed' && !failures.has(source) && !empty.has(source)) {
        return {
          marketplaces: [
            marketplace,
            { name: 'openai-curated-remote', plugins: [{ name: 'native-tool', enabled: true }] },
          ],
        }
      }
      return original(method, params)
    })
    const api = createLocalCodexPluginApi()
    await api.listInstalledPlugins({ refresh: true })
    await listLocalInstalledPluginsFromDisk()
    failures.add('plugin/installed')
    expect(
      (await api.listInstalledPlugins({ refresh: true })).items
        .map(item => item.spec.source.pluginKey)
        .sort()
    ).toEqual(['managed-tool', 'native-tool', 'personal-tool'])

    failures.clear()
    empty.add('plugin/installed')
    expect(
      (await api.listInstalledPlugins({ refresh: true })).items.map(
        item => item.spec.source.pluginKey
      )
    ).toEqual(['managed-tool'])
  })

  test.each(['disk', 'installed'])(
    'publishes a successful catalog after a newer %s inventory read without rolling back membership',
    async source => {
      const api = createLocalCodexPluginApi()
      await api.readState({ mergeAllMarketplaces: true, refresh: true })
      const original = mocks.request.getMockImplementation()!
      let finish!: (value: unknown) => void
      mocks.request.mockImplementation(async (method, params) => {
        if (method === 'codex.app_server_request' && params.method === 'plugin/list')
          return new Promise(resolve => {
            finish = resolve
          })
        return original(method, params)
      })
      const pending = api.readState({ mergeAllMarketplaces: true, refresh: true })
      await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
      if (source === 'disk') await listLocalInstalledPluginsFromDisk()
      else {
        empty.add('plugin/installed')
        empty.add('executor.plugins.store.list')
        await api.listInstalledPlugins({ refresh: true })
      }
      finish({
        marketplaces: [
          {
            ...marketplace,
            plugins: [
              ...marketplace.plugins,
              { name: 'new-catalog-plugin', installed: false, enabled: false },
            ],
          },
        ],
      })

      const result = await pending
      expect(result.marketplaceItems.map(item => item.name)).toContain('new-catalog-plugin')
      expect(result.installedPlugins.map(item => item.spec.source.pluginKey).sort()).toEqual(
        source === 'disk' ? ['managed-tool', 'personal-tool'] : []
      )
      expect(result.marketplaceItems.find(item => item.name === 'codex-tool')?.installed).toBe(
        false
      )
      expect(peekLocalCodexPluginsReadState({ mergeAllMarketplaces: true })).toEqual(result)
    }
  )

  test('a delayed disk scan preserves a catalog that completed while the disk scan was in flight', async () => {
    const api = createLocalCodexPluginApi()
    await api.readState({ mergeAllMarketplaces: true, refresh: true })
    const original = mocks.request.getMockImplementation()!
    let finishCatalog!: (value: unknown) => void
    let finishPersonal!: (value: unknown) => void
    mocks.request.mockImplementation(async (method, params) => {
      if (method === 'codex.app_server_request' && params.method === 'plugin/list')
        return new Promise(resolve => {
          finishCatalog = resolve
        })
      if (method === 'executor.plugins.personal.list')
        return new Promise(resolve => {
          finishPersonal = resolve
        })
      return original(method, params)
    })
    const catalog = api.readState({ mergeAllMarketplaces: true, refresh: true })
    await vi.waitFor(() => expect(finishCatalog).toBeTypeOf('function'))
    const disk = listLocalInstalledPluginsFromDisk()
    await vi.waitFor(() => expect(finishPersonal).toBeTypeOf('function'))
    finishCatalog({
      marketplaces: [{ ...marketplace, plugins: [{ name: 'new-catalog-plugin', enabled: false }] }],
    })
    expect((await catalog).marketplaceItems.map(item => item.name)).toEqual(['new-catalog-plugin'])
    finishPersonal(personal)
    await disk

    const current = peekLocalCodexPluginsReadState({ mergeAllMarketplaces: true })!
    expect(current.marketplaceItems.map(item => item.name)).toEqual(['new-catalog-plugin'])
    expect(current.installedPlugins.map(item => item.spec.source.pluginKey).sort()).toEqual([
      'managed-tool',
      'personal-tool',
    ])
  })

  test.each(['catalog', 'inventory'])(
    'keeps %s failure ownership independent while rebasing a successful catalog refresh',
    async source => {
      const api = createLocalCodexPluginApi()
      await api.readState({ mergeAllMarketplaces: true, refresh: true })
      if (source === 'catalog') {
        failures.add('plugin/list')
        expect((await api.readState({ mergeAllMarketplaces: true, refresh: true })).partial).toBe(
          true
        )
        failures.clear()
      }
      const original = mocks.request.getMockImplementation()!
      let finish!: (value: unknown) => void
      mocks.request.mockImplementation(async (method, params) => {
        if (method === 'codex.app_server_request' && params.method === 'plugin/list')
          return new Promise(resolve => {
            finish = resolve
          })
        return original(method, params)
      })
      const catalog = api.readState({ mergeAllMarketplaces: true, refresh: true })
      await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
      if (source === 'inventory') failures.add('executor.plugins.store.list')
      await listLocalInstalledPluginsFromDisk()
      finish({ marketplaces: [marketplace] })

      expect(Boolean((await catalog).partial)).toBe(source === 'inventory')
      failures.clear()
      await api.listInstalledPlugins({ requireComplete: true })
      expect(peekLocalCodexPluginsReadState({ mergeAllMarketplaces: true })?.partial).not.toBe(true)
    }
  )

  test.each(['disk', 'installed'])(
    'only a newer complete installed read can clear a failed Codex source after a %s read',
    async newerRead => {
      const original = mocks.request.getMockImplementation()!
      let finish!: (value: unknown) => void
      let holdCatalog = false
      mocks.request.mockImplementation(async (method, params) => {
        if (method === 'executor.plugins.store.list')
          return {
            ...store,
            plugins: [{ ...store.plugins[0], marketplace: 'personal' }],
          }
        if (method === 'executor.plugins.personal.ensure')
          return { migrated: false, marketplacePath: '/personal', pluginName: 'managed-tool' }
        if (holdCatalog && method === 'codex.app_server_request' && params.method === 'plugin/list')
          return new Promise(resolve => {
            finish = resolve
          })
        return original(method, params)
      })
      const api = createLocalCodexPluginApi()
      await api.readState({ mergeAllMarketplaces: true, refresh: true })
      const migrationRequests = () =>
        mocks.request.mock.calls.filter(([method]) => method === 'executor.plugins.personal.ensure')
          .length
      const before = migrationRequests()
      expect(before).toBeGreaterThan(0)
      holdCatalog = true
      failures.add('plugin/installed')
      const catalog = api.readState({ mergeAllMarketplaces: true, refresh: true })
      await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
      await listLocalInstalledPluginsFromDisk()
      if (newerRead === 'installed') {
        failures.clear()
        await api.listInstalledPlugins({ requireComplete: true })
      }
      finish({
        marketplaces: [
          { ...marketplace, plugins: [{ name: 'new-catalog-plugin', enabled: false }] },
        ],
      })

      const result = await catalog
      expect(result.marketplaceItems.map(item => item.name)).toEqual(['new-catalog-plugin'])
      expect(Boolean(result.partial)).toBe(newerRead === 'disk')
      if (newerRead === 'disk') {
        expect(result.installedPlugins.map(item => item.spec.source.pluginKey).sort()).toEqual([
          'managed-tool',
          'personal-tool',
        ])
        expect(migrationRequests()).toBe(before)
      }
      failures.clear()
      await api.listInstalledPlugins({ requireComplete: true })
      expect(peekLocalCodexPluginsReadState({ mergeAllMarketplaces: true })?.partial).not.toBe(true)
    }
  )

  test('retains a failed cloud link read when rebasing a fresh catalog on newer disk membership', async () => {
    const api = createLocalCodexPluginApi()
    await api.readState({ mergeAllMarketplaces: true, refresh: true })
    const original = mocks.request.getMockImplementation()!
    let finish!: (value: unknown) => void
    mocks.request.mockImplementation(async (method, params) => {
      if (method === 'codex.app_server_request' && params.method === 'plugin/list')
        return new Promise(resolve => {
          finish = resolve
        })
      return original(method, params)
    })
    const catalog = api.readState({ mergeAllMarketplaces: true, refresh: true })
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    await listLocalInstalledPluginsFromDisk()
    failures.add('executor.plugins.links.list')
    finish({ marketplaces: [marketplace] })

    const result = await catalog
    expect(result.partial).toBe(true)
    expect(result.installedPlugins.map(item => item.spec.source.pluginKey).sort()).toEqual([
      'managed-tool',
      'personal-tool',
    ])
    failures.clear()
    await api.listInstalledPlugins({ requireComplete: true })
    expect(peekLocalCodexPluginsReadState({ mergeAllMarketplaces: true })?.partial).not.toBe(true)
  })

  test.each(['personal', 'empty-personal', 'empty-config'])(
    'keeps a completed %s disk result when a later installed read fails after waiting',
    async source => {
      const api = createLocalCodexPluginApi()
      const params = { mergeAllMarketplaces: true as const }
      await api.readState({ ...params, refresh: true })
      if (source !== 'personal') await listLocalInstalledPluginsFromDisk()
      if (source === 'empty-personal') empty.add('executor.plugins.personal.list')
      if (source === 'empty-config') empty.add('executor.codex_home.config.read')
      const original = mocks.request.getMockImplementation()!
      let releasePersonal!: (value: typeof personal) => void
      let rejectInstalled!: (error: Error) => void
      mocks.request.mockImplementation((method, args) => {
        if (method === 'executor.plugins.personal.list')
          return new Promise(resolve => {
            releasePersonal = resolve
          })
        if (method === 'codex.app_server_request' && args.method === 'plugin/installed')
          return new Promise((_resolve, reject) => {
            rejectInstalled = reject
          })
        return original(method, args)
      })

      const disk = listLocalInstalledPluginsFromDisk()
      await vi.waitFor(() => expect(releasePersonal).toBeTypeOf('function'))
      const installed = api.listInstalledPlugins({ refresh: true })
      await vi.waitFor(() => expect(rejectInstalled).toBeTypeOf('function'))
      releasePersonal(source === 'empty-personal' ? { ...personal, plugins: [] } : personal)
      await disk
      const expected = source === 'personal' ? ['managed-tool', 'personal-tool'] : ['managed-tool']
      expect(
        peekLocalCodexPluginsReadState(params)
          ?.installedPlugins.map(plugin => plugin.spec.source.pluginKey)
          .sort()
      ).toEqual(expected)
      rejectInstalled(new Error('Codex installed read failed after disk recovery'))

      const result = await installed
      expect(result.partial).toBe(true)
      expect(result.items.map(plugin => plugin.spec.source.pluginKey).sort()).toEqual(expected)
      expect(
        peekLocalCodexPluginsReadState(params)
          ?.installedPlugins.map(plugin => plugin.spec.source.pluginKey)
          .sort()
      ).toEqual(expected)
      mocks.request.mockImplementation(original)
      empty.add('plugin/installed')
      expect(
        (await api.listInstalledPlugins({ requireComplete: true })).items.map(
          plugin => plugin.spec.source.pluginKey
        )
      ).toEqual(['managed-tool'])
      expect(peekLocalCodexPluginsReadState(params)?.partial).not.toBe(true)
    }
  )

  test.each([true, false])(
    'keeps the target catalog partial=%s independent from another selection',
    async targetPartial => {
      const api = createLocalCodexPluginApi()
      const target = { mergeAllMarketplaces: true as const }
      await api.readState({ ...target, refresh: true })
      if (targetPartial) {
        failures.add('plugin/list')
        expect((await api.readState({ ...target, refresh: true })).partial).toBe(true)
      }
      failures.clear()
      if (!targetPartial) failures.add('plugin/list')
      await api.readState({ marketplaceId: 'wework-personal', refresh: true })
      await listLocalInstalledPluginsFromDisk()

      const peeked = peekLocalCodexPluginsReadState(target)!
      expect(Boolean(peeked.partial)).toBe(targetPartial)
      expect(peeked.installedPlugins.map(plugin => plugin.spec.source.pluginKey).sort()).toEqual([
        'managed-tool',
        'personal-tool',
      ])
      expect(Boolean((await api.readState(target)).partial)).toBe(targetPartial)
      failures.clear()
      await api.listInstalledPlugins({ requireComplete: true })
      expect(Boolean(peekLocalCodexPluginsReadState(target)?.partial)).toBe(targetPartial)
      expect((await api.readState({ ...target, refresh: true })).partial).not.toBe(true)
      expect(
        mocks.request.mock.calls.some(([method]) => method === 'executor.plugins.personal.ensure')
      ).toBe(false)
    }
  )

  test.each(['current', 'legacy'])(
    'hydrates %s catalog failures independently from inventory until a full recovery',
    async version => {
      const params = { mergeAllMarketplaces: true as const }
      const api = createLocalCodexPluginApi()
      await api.readState({ ...params, refresh: true })
      failures.add('plugin/list')
      expect((await api.readState({ ...params, refresh: true })).partial).toBe(true)
      if (version === 'legacy') {
        const key = 'wework.plugins.codexCatalog.v1'
        const durable = JSON.parse(localStorage.getItem(key)!)
        durable.version = 1
        delete durable.entries['|all|all-kinds'].state.catalogPartial
        localStorage.setItem(key, JSON.stringify(durable))
      }
      vi.resetModules()
      const cold = await import('./codexPlugins')
      try {
        expect(cold.peekLocalCodexPluginsReadState(params)?.partial).toBe(true)
        expect(cold.peekLocalCodexPluginsReadState(params)?.installedPlugins).toEqual([])
        failures.clear()
        await cold.createLocalCodexPluginApi().listInstalledPlugins({ requireComplete: true })
        expect(cold.peekLocalCodexPluginsReadState(params)?.partial).toBe(true)
        expect(
          (await cold.createLocalCodexPluginApi().readState({ ...params, refresh: true })).partial
        ).not.toBe(true)
      } finally {
        cold.clearLocalCodexPluginsReadStateCache()
      }
    }
  )
})
