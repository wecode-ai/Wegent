import { beforeEach, describe, expect, test, vi } from 'vitest'
import {
  clearLocalCodexPluginsReadStateCache,
  createLocalCodexPluginApi,
  listLocalInstalledPluginsFromDisk,
  listPersonalMarketplacePluginsFromDisk,
  peekLocalCodexPluginsReadState,
  peekLocalInstalledPluginInventory,
  readLocalInstalledInventoryFromDisk,
  type LocalCodexPluginsState,
} from './codexPlugins'
import { resolveLocalPluginInventory } from '@/features/plugins/pluginInventorySources'
import { writePluginInventory } from '@/features/plugins/pluginInventory'
import {
  clearPluginMarketplaceCache,
  getPluginMarketplaceCache,
} from '@/features/plugins/pluginMarketplaceCache'

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  deviceId: 'device-a',
  bundled: null as { id: string; path: string } | null,
}))
vi.mock('@/api/local/runtimeAuthStatus', () => ({
  getLocalCodexAuthStatus: vi.fn().mockResolvedValue({ sha256: 'test-account' }),
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
    plugins: [{ name: 'personal-tool', installed: true, enabled: true }],
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
    clearPluginMarketplaceCache()
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

  function consumeSnapshot(state: LocalCodexPluginsState, expected: string[]) {
    expected = [...expected].sort()
    const local = resolveLocalPluginInventory(
      getPluginMarketplaceCache('source-generations'),
      {
        items: state.installedPlugins,
        deviceId: state.deviceId,
        sourceReads: state.sourceReads,
        partial: state.partial,
      },
      state.deviceId
    )
    const keys = (items: typeof local.items) => items.map(item => item.spec.source.pluginKey).sort()
    expect(keys(state.installedPlugins)).toEqual(expected)
    expect(keys(local.items)).toEqual(expected)
    const shared = writePluginInventory('source-generations', state.deviceId, {
      installedPlugins: local.items,
      localInstalledSources: local.localInstalledSources,
      localInstalledSourceStatus: local.localInstalledSourceStatus,
    })
    expect(keys(shared.installedPlugins)).toEqual(expected)
    expect(shared.localInstalledSourceStatus).toEqual(local.localInstalledSourceStatus)
    return local
  }

  test.each(['membership-only', 'catalog-pending'] as const)(
    'observes live %s inventory without selecting or mutating a catalog',
    async mode => {
      expect(peekLocalInstalledPluginInventory()).toBeNull()
      const api = createLocalCodexPluginApi()
      let release!: (value: unknown) => void
      let catalog: Promise<LocalCodexPluginsState> | undefined
      if (mode === 'catalog-pending') {
        const original = mocks.request.getMockImplementation()!
        mocks.request.mockImplementation((method, args) => {
          if (method === 'codex.app_server_request' && args.method === 'plugin/list')
            return new Promise(resolve => {
              release = resolve
            })
          return original(method, args)
        })
        catalog = api.readState({
          mergeAllMarketplaces: true,
          marketplaceKinds: ['local'],
          refresh: true,
        })
        await vi.waitFor(() => expect(release).toBeTypeOf('function'))
      } else {
        await api.listInstalledPlugins({ refresh: true })
      }
      try {
        const requestCount = mocks.request.mock.calls.length
        const snapshot = peekLocalInstalledPluginInventory()!
        expect(snapshot.sourceReads?.store?.status).toBe('fulfilled')
        expect(
          snapshot.sourceReads?.store?.items?.map(plugin => plugin.spec.source.pluginKey)
        ).toEqual(['managed-tool'])
        expect(snapshot.items.map(plugin => plugin.spec.source.pluginKey).sort()).toEqual([
          'managed-tool',
          'personal-tool',
        ])
        expect(
          peekLocalCodexPluginsReadState({
            mergeAllMarketplaces: true,
            marketplaceKinds: ['local'],
          })
        ).toBeNull()
        expect(mocks.request).toHaveBeenCalledTimes(requestCount)
        mocks.deviceId = 'device-b'
        expect(peekLocalInstalledPluginInventory()).toBeNull()
        mocks.deviceId = ''
        expect(peekLocalInstalledPluginInventory()).toBeNull()
        mocks.deviceId = 'device-a'
        expect(peekLocalInstalledPluginInventory()).toEqual(snapshot)
      } finally {
        if (catalog) {
          release({ marketplaces: [marketplace] })
          await catalog
        }
      }
      clearLocalCodexPluginsReadStateCache()
      expect(peekLocalInstalledPluginInventory()).toBeNull()
    }
  )

  test.each([
    ['installed', 'remove'],
    ['installed', 'add'],
    ['installed', 'failure'],
    ['disk', 'remove'],
    ['disk', 'add'],
    ['disk', 'failure'],
  ] as const)(
    'keeps flat, source and shared records consistent after a newer %s %s overtakes a catalog',
    async (source, outcome) => {
      if (outcome === 'add') {
        empty.add('plugin/installed')
        empty.add('executor.plugins.store.list')
      }
      const nativeRequest = mocks.request.getMockImplementation()!
      mocks.request.mockImplementation(async (method, args) => {
        const result = await nativeRequest(method, args)
        return source === 'installed' &&
          method === 'codex.app_server_request' &&
          ['plugin/installed', 'plugin/list'].includes(args.method)
          ? {
              ...result,
              marketplaces: result.marketplaces.map((market: typeof marketplace) => ({
                ...market,
                name: 'openai-curated-remote',
              })),
            }
          : result
      })
      if (source === 'installed' || outcome === 'add') empty.add('executor.plugins.personal.list')
      const api = createLocalCodexPluginApi()
      const params = { mergeAllMarketplaces: true as const, refresh: true }
      consumeSnapshot(
        await api.readState(params),
        outcome === 'add' ? [] : ['personal-tool', 'managed-tool']
      )
      const original = mocks.request.getMockImplementation()!
      let release!: (value: unknown) => void
      let addedCodex = false
      mocks.request.mockImplementation((method, args) => {
        if (method === 'codex.app_server_request' && args.method === 'plugin/list')
          return new Promise(resolve => {
            release = resolve
          })
        if (
          addedCodex &&
          method === 'codex.app_server_request' &&
          args.method === 'plugin/installed'
        )
          return {
            marketplaces: [
              {
                ...marketplace,
                name: 'openai-curated-remote',
                plugins: [{ name: 'new-tool', installed: true, enabled: true }],
              },
            ],
          }
        return original(method, args)
      })
      const pending = api.readState(params)
      await vi.waitFor(() => expect(release).toBeTypeOf('function'))
      try {
        empty.add('plugin/installed')
        if (source === 'disk' && outcome !== 'add') empty.add('executor.plugins.personal.list')
        if (outcome === 'remove') empty.add('executor.plugins.store.list')
        if (outcome === 'add') {
          if (source === 'disk') empty.delete('executor.plugins.store.list')
          else addedCodex = true
        }
        if (outcome === 'failure') failures.add('executor.plugins.store.list')
        if (source === 'disk') await readLocalInstalledInventoryFromDisk()
        else await api.listInstalledPlugins({ refresh: true })
      } finally {
        release({ marketplaces: [marketplace] })
      }
      const state = await pending
      const expected =
        outcome === 'remove'
          ? []
          : outcome === 'add' && source === 'installed'
            ? ['new-tool']
            : ['managed-tool']
      const expectedStore =
        outcome === 'add' && source === 'installed'
          ? []
          : outcome === 'remove'
            ? []
            : ['managed-tool']
      const local = consumeSnapshot(state, expected)
      expect(state.sourceReads?.store?.status).toBe(
        outcome === 'failure' ? 'rejected' : 'fulfilled'
      )
      expect(local.localInstalledSourceStatus.store).toBe(state.sourceReads?.store?.status)
      expect(state.sourceReads?.store?.items?.map(item => item.spec.source.pluginKey)).toEqual(
        expectedStore
      )
      expect(Boolean(state.partial)).toBe(outcome === 'failure')
      expect(peekLocalCodexPluginsReadState({ mergeAllMarketplaces: true })).toEqual(state)
    }
  )

  test('publishes a catalog membership failure before a newer disk scan inherits its source outcomes', async () => {
    const api = createLocalCodexPluginApi()
    const params = { mergeAllMarketplaces: true as const, refresh: true }
    consumeSnapshot(await api.readState(params), ['personal-tool', 'managed-tool'])
    failures.add('plugin/installed')
    const original = mocks.request.getMockImplementation()!
    let release!: (value: unknown) => void
    mocks.request.mockImplementation((method, args) => {
      if (method === 'codex.app_server_request' && args.method === 'plugin/list')
        return new Promise(resolve => {
          release = resolve
        })
      return original(method, args)
    })
    const pending = api.readState(params)
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    try {
      await readLocalInstalledInventoryFromDisk()
    } finally {
      release({ marketplaces: [marketplace] })
    }
    const state = await pending
    expect(state.sourceReads?.codex?.status).toBe('rejected')
    expect(state.sourceReads?.personal?.status).toBe('fulfilled')
    expect(state.partial).toBe(true)
    consumeSnapshot(state, ['managed-tool', 'personal-tool'])
  })

  test('keeps detailed components in the source records consumed by the shared inventory', async () => {
    const api = createLocalCodexPluginApi()
    const params = { mergeAllMarketplaces: true as const, refresh: true }
    const original = mocks.request.getMockImplementation()!
    mocks.request.mockImplementation((method, args) => {
      if (
        method === 'codex.app_server_request' &&
        args.method === 'plugin/installed' &&
        !failures.has('plugin/installed')
      )
        return {
          marketplaces: [
            marketplace,
            { ...marketplace, name: 'openai-curated-remote', path: '/remote' },
          ],
        }
      if (method === 'codex.app_server_request' && args.method === 'plugin/read')
        return {
          plugin: {
            summary: { name: 'personal-tool' },
            skills: [{ name: 'detail-skill', path: 'skills/detail' }],
          },
        }
      if (method === 'executor.plugins.manifest.read') return { connectors: [] }
      return original(method, args)
    })
    const initial = await api.readState(params)
    await api.readInstalledPluginDetail(
      initial.installedPlugins.find(item => item.spec.source.marketplace === 'wework-personal')!
    )
    const current = peekLocalCodexPluginsReadState({ mergeAllMarketplaces: true })!
    const local = consumeSnapshot(current, ['personal-tool', 'personal-tool', 'managed-tool'])
    const detailed = local.items.find(item => item.spec.source.marketplace === 'wework-personal')!
    expect(detailed.spec.components.skills.map(skill => skill.name)).toContain('detail-skill')
    expect(
      local.items.find(item => item.spec.source.marketplace === 'openai-curated-remote')?.spec
        .components.skills
    ).toEqual([])
    failures.add('plugin/installed')
    const failed = await api.listInstalledPlugins({ refresh: true })
    expect(
      failed.items
        .find(item => item.spec.source.marketplace === 'wework-personal')
        ?.spec.components.skills.map(skill => skill.name)
    ).toContain('detail-skill')
  })

  test.each([
    ['plugin/installed', ['managed-tool', 'personal-tool']],
    ['executor.plugins.store.list', ['personal-tool']],
  ])('returns a healthy source when %s fails and strict reads reject', async (source, retained) => {
    failures.add(source)
    const api = createLocalCodexPluginApi()
    const result = await api.listInstalledPlugins({ refresh: true })
    expect(result.items.map(item => item.spec.source.pluginKey).sort()).toEqual(retained)
    expect(result.partial).toBe(true)
    await expect(api.listInstalledPlugins({ requireComplete: true })).rejects.toThrow('unavailable')
  })

  test('keeps only a failed source and clears it after an authoritative empty recovery', async () => {
    const api = createLocalCodexPluginApi()
    await api.listInstalledPlugins({ refresh: true })
    failures.add('executor.plugins.store.list')
    empty.add('plugin/installed')
    empty.add('executor.plugins.personal.list')
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
    failures.add('executor.plugins.personal.list')
    failures.add('executor.codex_home.config.read')
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
      expect(result.marketplaceItems.map(item => item.name)).toEqual(['personal-tool'])
      expect(result.installedPlugins.map(item => item.spec.source.pluginKey).sort()).toEqual([
        'managed-tool',
        'personal-tool',
      ])
    }
  )

  test('a failed catalog cannot revive installs removed by successful membership reads', async () => {
    const api = createLocalCodexPluginApi()
    await api.readState({ mergeAllMarketplaces: true, refresh: true })
    failures.add('plugin/list')
    empty.add('plugin/installed')
    empty.add('executor.plugins.store.list')
    empty.add('executor.plugins.personal.list')
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

  test.each([false, true])(
    'retains disabled personal membership after a disk read (warm=%s)',
    async warm => {
      if (warm) await readLocalInstalledInventoryFromDisk()
      const original = mocks.request.getMockImplementation()!
      mocks.request.mockImplementation(async (method, params) =>
        method === 'executor.codex_home.config.read'
          ? { enabledPluginKeys: [], disabledPluginKeys: ['personal-tool@wework-personal'] }
          : original(method, params)
      )
      const result = await readLocalInstalledInventoryFromDisk()
      const personal = result.items.find(plugin => plugin.spec.source.pluginKey === 'personal-tool')
      expect(personal?.spec.enabled).toBe(false)
      expect(result.sourceReads.personal?.status).toBe('fulfilled')
      expect(result.sourceReads.personal?.items).toContainEqual(personal)
      expect(result.items.some(plugin => plugin.spec.source.pluginKey === 'managed-tool')).toBe(
        true
      )
    }
  )

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
          ? [{ localPluginName: 'personal-tool', cloudPluginId: 9, cloudReleaseId: 8 }]
          : []
        : original(method, params)
    )
    const api = createLocalCodexPluginApi()
    await api.readState({ mergeAllMarketplaces: true, refresh: true })
    failures.add('executor.plugins.links.list')
    const partial = await api.readState({ mergeAllMarketplaces: true, refresh: true })
    expect(partial.partial).toBe(true)
    expect(
      partial.installedPlugins.find(item => item.spec.source.pluginKey === 'personal-tool')?.spec
        .sourcePayload
    ).toMatchObject({ cloudPluginId: 9, cloudReleaseId: 8 })
    expect(
      partial.sourceReads?.personal?.items?.find(
        item => item.spec.source.pluginKey === 'personal-tool'
      )?.spec.sourcePayload
    ).toMatchObject({ cloudPluginId: 9, cloudReleaseId: 8 })
    mocks.bundled = { id: 'wework-personal', path: '/personal' }
    await expect(api.listInstalledPlugins({ requireComplete: true })).rejects.toThrow('unavailable')
    failures.clear()
    linked = false
    const cleared = await api.readState({ mergeAllMarketplaces: true, refresh: true })
    expect(cleared.partial).not.toBe(true)
    const payload = cleared.installedPlugins.find(
      item => item.spec.source.pluginKey === 'personal-tool'
    )?.spec.sourcePayload
    expect(payload?.cloudPluginId).toBeUndefined()
    expect(
      cleared.sourceReads?.personal?.items?.find(
        item => item.spec.source.pluginKey === 'personal-tool'
      )?.spec.sourcePayload?.cloudPluginId
    ).toBeUndefined()
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
      'managed-tool',
      'personal-tool',
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

  test.each(['executor.plugins.personal.list', 'executor.codex_home.config.read'])(
    'does not revive personal plugins on Codex recovery after a successful empty %s',
    async source => {
      const api = createLocalCodexPluginApi()
      const params = { mergeAllMarketplaces: true as const }
      consumeSnapshot(await api.readState({ ...params, refresh: true }), [
        'managed-tool',
        'personal-tool',
      ])
      empty.add(source)
      await readLocalInstalledInventoryFromDisk()
      consumeSnapshot(peekLocalCodexPluginsReadState(params)!, ['managed-tool'])
      failures.add('plugin/installed')
      await api.listInstalledPlugins({ refresh: true })
      consumeSnapshot(peekLocalCodexPluginsReadState(params)!, ['managed-tool'])

      failures.delete('plugin/installed')
      const recovered = await api.listInstalledPlugins({ refresh: true })
      expect(recovered.partial).not.toBe(true)
      expect(recovered.sourceReads?.personal).toEqual({ status: 'fulfilled', items: [] })
      expect(
        recovered.sourceReads?.codex?.items?.every(
          plugin => plugin.spec.source.marketplace !== 'wework-personal'
        )
      ).toBe(true)
      consumeSnapshot(peekLocalCodexPluginsReadState(params)!, ['managed-tool'])
      consumeSnapshot(await api.readState({ ...params, refresh: true }), ['managed-tool'])

      // A new disk-confirmed install must still replace the earlier empty result.
      empty.delete(source)
      await readLocalInstalledInventoryFromDisk()
      await api.listInstalledPlugins({ refresh: true })
      consumeSnapshot(peekLocalCodexPluginsReadState(params)!, ['managed-tool', 'personal-tool'])
    }
  )

  test('explicit inventory invalidation admits a new personal install', async () => {
    const api = createLocalCodexPluginApi()
    const params = { mergeAllMarketplaces: true as const }
    await api.readState({ ...params, refresh: true })
    empty.add('executor.plugins.personal.list')
    await readLocalInstalledInventoryFromDisk()
    consumeSnapshot(peekLocalCodexPluginsReadState(params)!, ['managed-tool'])

    empty.delete('executor.plugins.personal.list')
    const original = mocks.request.getMockImplementation()!
    mocks.request.mockImplementation((method, args) =>
      method === 'codex.app_server_request' && args.method === 'plugin/installed'
        ? {
            marketplaces: [
              {
                ...marketplace,
                plugins: [{ name: 'personal-tool', installed: true, enabled: true }],
              },
            ],
          }
        : original(method, args)
    )
    clearLocalCodexPluginsReadStateCache()
    consumeSnapshot(await api.readState({ ...params, refresh: true }), [
      'managed-tool',
      'personal-tool',
    ])
  })

  test('confirmed personal removal survives renderer cache invalidation', async () => {
    const api = createLocalCodexPluginApi()
    await api.listInstalledPlugins({ refresh: true })
    empty.add('executor.plugins.personal.list')
    const disk = await readLocalInstalledInventoryFromDisk()
    const confirmed = resolveLocalPluginInventory(null, disk, mocks.deviceId)
    failures.add('plugin/installed')
    await api.listInstalledPlugins({ refresh: true })
    clearLocalCodexPluginsReadStateCache()
    failures.delete('plugin/installed')
    const read = await api.listInstalledPlugins({ refresh: true })
    const recovered = resolveLocalPluginInventory(
      {
        deviceId: mocks.deviceId,
        installedPlugins: confirmed.items,
        localInstalledSources: confirmed.localInstalledSources,
        localInstalledSourceStatus: confirmed.localInstalledSourceStatus,
      },
      read,
      mocks.deviceId
    )
    expect(recovered.items.map(item => item.spec.source.pluginKey)).not.toContain('personal-tool')
    expect(read.sourceReads?.personal).toEqual({ status: 'fulfilled', items: [] })
  })

  test('complete inventory observes a newer personal uninstall without an earlier disk refresh', async () => {
    const api = createLocalCodexPluginApi()
    await readLocalInstalledInventoryFromDisk()
    empty.add('executor.plugins.personal.list')
    empty.add('executor.codex_home.config.read')
    empty.add('plugin/installed')
    const fresh = await api.listInstalledPlugins({ refresh: true, requireComplete: true })
    expect(fresh.partial).not.toBe(true)
    expect(fresh.items.map(item => item.spec.source.pluginKey)).not.toContain('personal-tool')
    expect(fresh.sourceReads?.personal).toEqual({ status: 'fulfilled', items: [] })
  })

  test.each([
    'executor.plugins.personal.list',
    'executor.codex_home.config.read',
    'executor.plugins.links.list',
  ])(
    'complete reads reject a new %s failure instead of claiming a cached personal source is fresh',
    async source => {
      const api = createLocalCodexPluginApi()
      await api.listInstalledPlugins({ requireComplete: true })
      failures.add(source)
      const partial = await api.listInstalledPlugins({ refresh: true })
      expect(partial.partial).toBe(true)
      expect(partial.items.some(item => item.spec.source.pluginKey === 'personal-tool')).toBe(true)
      await expect(api.listInstalledPlugins({ requireComplete: true })).rejects.toThrow(
        'unavailable'
      )
      failures.delete(source)
      expect((await api.listInstalledPlugins({ requireComplete: true })).partial).not.toBe(true)
    }
  )

  test('newer successful disk absence overtakes a slow installed read', async () => {
    const api = createLocalCodexPluginApi()
    await api.listInstalledPlugins({ requireComplete: true })
    const original = mocks.request.getMockImplementation()!
    let release!: (value: unknown) => void
    mocks.request.mockImplementation((method, args) => {
      if (method === 'codex.app_server_request' && args.method === 'plugin/installed')
        return new Promise(resolve => {
          release = resolve
        })
      return original(method, args)
    })
    const pending = api.listInstalledPlugins({ refresh: true })
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    await vi.waitFor(() =>
      expect(
        mocks.request.mock.calls.filter(([method]) => method === 'executor.plugins.links.list')
      ).toHaveLength(2)
    )
    empty.add('executor.plugins.personal.list')
    const disk = await readLocalInstalledInventoryFromDisk()
    expect(disk.sourceReads?.personal?.items).toEqual([])
    release({ marketplaces: [marketplace] })
    const recovered = await pending
    expect(recovered.items.map(plugin => plugin.spec.source.pluginKey)).toEqual(['managed-tool'])
    expect(recovered.sourceReads?.personal).toEqual({ status: 'fulfilled', items: [] })
  })

  test('a first failed personal disk read never accepts unverified Codex personal membership', async () => {
    failures.add('executor.plugins.personal.list')
    const disk = await readLocalInstalledInventoryFromDisk()
    expect(disk.sourceReads?.personal?.status).toBe('rejected')
    const result = await createLocalCodexPluginApi().listInstalledPlugins({ refresh: true })
    expect(result.sourceReads?.personal?.status).toBe('rejected')
    expect(result.partial).toBe(true)
    expect(result.items.map(item => item.spec.source.pluginKey)).toEqual(['managed-tool'])
  })

  test('clears recovered Codex markets independently of disk-confirmed personal membership', async () => {
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
      (await api.listInstalledPlugins({ refresh: true })).items
        .map(item => item.spec.source.pluginKey)
        .sort()
    ).toEqual(['managed-tool', 'personal-tool'])
    empty.add('executor.plugins.personal.list')
    await readLocalInstalledInventoryFromDisk()
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
              { name: 'stale-catalog-plugin', installed: true, enabled: true },
              { name: 'new-catalog-plugin', installed: false, enabled: false },
            ],
          },
        ],
      })

      const result = await pending
      expect(result.marketplaceItems.map(item => item.name)).toContain('new-catalog-plugin')
      expect(result.installedPlugins.map(item => item.spec.source.pluginKey).sort()).toEqual(
        source === 'disk' ? ['managed-tool', 'personal-tool'] : ['personal-tool']
      )
      expect(
        result.marketplaceItems.find(item => item.name === 'stale-catalog-plugin')?.installed
      ).toBe(false)
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
      if (method === 'executor.plugins.personal.list' && finishCatalog)
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
      expect(before).toBe(0)
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
        if (method === 'executor.plugins.personal.list' && !releasePersonal)
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
        (await api.listInstalledPlugins({ requireComplete: true })).items
          .map(plugin => plugin.spec.source.pluginKey)
          .sort()
      ).toEqual(expected)
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
      consumeSnapshot(peeked, ['managed-tool', 'personal-tool'])
      expect(peeked.sourceReads?.personal?.status).toBe('fulfilled')
      expect(peeked.sourceReads?.personal?.items?.map(item => item.spec.source.pluginKey)).toEqual([
        'personal-tool',
      ])
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
