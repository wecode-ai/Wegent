import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  clearLocalCodexPluginsReadStateCache,
  createLocalCodexPluginApi,
  peekLocalCodexPluginsReadState,
  peekLocalInstalledPluginInventory,
  readLocalInstalledInventoryFromDisk,
} from './codexPlugins'

const fixture = vi.hoisted(() => ({
  deviceId: 'device-a',
  enabled: true,
  installed: true,
  version: '1.0.0',
  account: 'test-account',
  request: vi.fn(),
}))
vi.mock('@/api/local/runtimeAuthStatus', () => ({
  getLocalCodexAuthStatus: vi.fn(async () => ({ sha256: fixture.account })),
}))

vi.mock('@/lib/runtime-environment', () => ({
  isDesktopRuntime: () => true,
  isElectronRuntime: () => true,
}))
vi.mock('@/desktop/localExecutor', () => ({
  getKnownLocalExecutorDeviceId: () => fixture.deviceId,
  ensureLocalExecutorStarted: async () => ({ deviceId: fixture.deviceId }),
  ensureBundledPluginMarketplaceRegistered: async () => {},
  getInitializedBundledPluginMarketplace: () => null,
  requestLocalExecutor: (...args: unknown[]) => fixture.request(...args),
}))

const marketplace = { id: 'custom', name: 'custom', path: '/plugins/custom' }
function summary() {
  return {
    id: 'tool@custom',
    name: 'tool',
    installed: true,
    enabled: fixture.enabled,
    localVersion: fixture.version,
  }
}
function detail() {
  return {
    plugin: {
      summary: summary(),
      version: fixture.version,
      description: 'Expanded detail',
      skills: [
        {
          name: 'expanded',
          enabled: true,
          description: 'Detail skill',
          path: '/plugins/custom/tool/skills/expanded/SKILL.md',
        },
      ],
    },
  }
}

beforeEach(() => {
  clearLocalCodexPluginsReadStateCache()
  fixture.deviceId = 'device-a'
  fixture.enabled = true
  fixture.installed = true
  fixture.version = '1.0.0'
  fixture.account = 'test-account'
  fixture.request.mockReset().mockImplementation(async (method, params) => {
    if (method === 'executor.plugins.store.list')
      return {
        storePath: '/store',
        plugins: fixture.installed
          ? [
              {
                name: 'tool',
                packageId: 'tool@custom',
                marketplace: 'custom',
                version: fixture.version,
                enabled: fixture.enabled,
                pluginPath: '/store/tool',
              },
            ]
          : [],
      }
    if (method === 'executor.codex_home.config.read') return { enabledPluginKeys: [] }
    if (method === 'executor.plugins.manifest.read') return { connectors: [] }
    if (method === 'codex.app_server_request') {
      if (params.method === 'plugin/installed' || params.method === 'plugin/list')
        return {
          marketplaces: [{ ...marketplace, plugins: fixture.installed ? [summary()] : [] }],
        }
      if (params.method === 'plugin/read') return detail()
    }
    throw new Error(`Unexpected detail source ${method}`)
  })
})
afterEach(() => vi.restoreAllMocks())

function inventoryState() {
  return {
    inventory: peekLocalInstalledPluginInventory(),
    catalog: peekLocalCodexPluginsReadState({ mergeAllMarketplaces: true }),
    durable: localStorage.getItem('wework.plugins.codexCatalog.v1'),
    session: sessionStorage.getItem('wework.plugins.codexCatalog.v1'),
  }
}

describe('plugin detail cache ownership', () => {
  test('installed and marketplace consumers share the same versioned detail read', async () => {
    const api = createLocalCodexPluginApi()
    const state = await api.readState({ mergeAllMarketplaces: true, refresh: true })
    const plugin = state.installedPlugins[0]
    await Promise.all([
      api.readInstalledPluginDetail(plugin),
      api.readMarketplacePluginDetail(marketplace, 'tool', {
        version: JSON.stringify([plugin.spec.version, plugin.spec.releaseId]),
      }),
    ])
    expect(
      fixture.request.mock.calls.filter(
        ([method, params]) =>
          method === 'codex.app_server_request' && params.method === 'plugin/read'
      )
    ).toHaveLength(1)
  })

  test('API adapters merge detail reads and reuse successful presentation data', async () => {
    const readers = Array.from({ length: 11 }, () =>
      createLocalCodexPluginApi().readMarketplacePluginDetail(marketplace, 'tool', { version: '1' })
    )
    await Promise.all(readers)
    await createLocalCodexPluginApi().readMarketplacePluginDetail(marketplace, 'tool', {
      version: '1',
    })
    const reads = () =>
      fixture.request.mock.calls.filter(
        ([method, params]) =>
          method === 'codex.app_server_request' && params.method === 'plugin/read'
      )
    expect(reads()).toHaveLength(1)
    await createLocalCodexPluginApi().readMarketplacePluginDetail(marketplace, 'tool', {
      version: '2',
    })
    expect(reads()).toHaveLength(2)
    for (const account of ['account-b', 'test-account']) {
      fixture.account = account
      await createLocalCodexPluginApi().readMarketplacePluginDetail(marketplace, 'tool', {
        version: '2',
      })
    }
    expect(reads()).toHaveLength(4)
    fixture.deviceId = 'device-b'
    await createLocalCodexPluginApi().readMarketplacePluginDetail(marketplace, 'tool', {
      version: '2',
    })
    expect(reads()).toHaveLength(5)
  })

  test('an account switch during plugin/read rejects the old response', async () => {
    let release!: (value: unknown) => void
    const original = fixture.request.getMockImplementation()!
    fixture.request.mockImplementation((method, params) => {
      if (method === 'codex.app_server_request' && params.method === 'plugin/read')
        return new Promise(resolve => {
          release = resolve
        })
      return original(method, params)
    })
    const pending = expect(
      createLocalCodexPluginApi().readMarketplacePluginDetail(marketplace, 'tool')
    ).rejects.toThrow('changed')
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    fixture.account = 'account-b'
    release(detail())
    await pending
  })
  test.each(['installed', 'marketplace'] as const)(
    '%s detail sends the marketplace manifest rather than its directory to Codex',
    async entry => {
      const request = fixture.request.getMockImplementation()!
      const manifest = '/plugins/custom/.agents/plugins/marketplace.json'
      fixture.request.mockImplementation(async (method, params) => {
        if (
          method === 'codex.app_server_request' &&
          params.method === 'plugin/read' &&
          params.params.marketplacePath !== manifest
        ) {
          throw new Error('failed to read marketplace file: Is a directory')
        }
        return request(method, params)
      })
      const api = createLocalCodexPluginApi()
      const state = await api.readState({ mergeAllMarketplaces: true, refresh: true })

      if (entry === 'installed') await api.readInstalledPluginDetail(state.installedPlugins[0])
      else await api.readMarketplacePluginDetail(marketplace, 'tool')

      expect(fixture.request).toHaveBeenCalledWith('codex.app_server_request', {
        method: 'plugin/read',
        params: { marketplacePath: manifest, remoteMarketplaceName: null, pluginName: 'tool' },
      })
      expect(
        peekLocalInstalledPluginInventory()!.items[0].spec.components.skills.map(
          skill => skill.name
        )
      ).toEqual(['expanded'])
    }
  )

  test.each(['installed', 'marketplace'] as const)(
    '%s detail enriches presentation while preserving inventory fields',
    async entry => {
      const api = createLocalCodexPluginApi()
      const state = await api.readState({ mergeAllMarketplaces: true, refresh: true })
      const plugin = state.installedPlugins[0]
      if (entry === 'installed') await api.readInstalledPluginDetail(plugin)
      else await api.readMarketplacePluginDetail(marketplace, 'tool')
      const current = peekLocalInstalledPluginInventory()!
      expect(current.items[0].spec.components.skills.map(skill => skill.name)).toEqual(['expanded'])
      expect(current.items[0].spec.enabled).toBe(plugin.spec.enabled)
      expect(current.items[0].spec.version).toBe(plugin.spec.version)
      expect(current.items[0].metadata).toEqual(plugin.metadata)
      expect(current.items[0].spec.sourcePayload).toEqual(plugin.spec.sourcePayload)
      expect(current.items[0].spec.componentStates).toEqual({ 'skill:expanded': true })
    }
  )

  test.each(
    (['installed', 'marketplace'] as const).flatMap(entry =>
      (
        [
          'disable',
          'upgrade',
          'uninstall',
          'reinstall',
          'device',
          'device-round-trip',
          'invalidate',
        ] as const
      ).flatMap(change =>
        (['catalog', 'membership', 'disk'] as const).map(refresh => ({ entry, change, refresh }))
      )
    )
  )(
    '$entry late detail cannot overwrite $change after $refresh refresh',
    async ({ entry, change, refresh }) => {
      clearLocalCodexPluginsReadStateCache()
      fixture.deviceId = 'device-a'
      fixture.enabled = true
      fixture.installed = true
      fixture.version = '1.0.0'
      const api = createLocalCodexPluginApi()
      const initial = await api.readState({ mergeAllMarketplaces: true, refresh: true })
      const refreshInventory = () =>
        refresh === 'catalog'
          ? api.readState({ mergeAllMarketplaces: true, refresh: true })
          : refresh === 'membership'
            ? api.listInstalledPlugins({ refresh: true })
            : readLocalInstalledInventoryFromDisk()
      const response = detail()
      const original = fixture.request.getMockImplementation()!
      let release!: (value: ReturnType<typeof detail>) => void
      fixture.request.mockImplementation((method, params) => {
        if (method === 'codex.app_server_request' && params.method === 'plugin/read')
          return new Promise(resolve => {
            release = resolve
          })
        return original(method, params)
      })
      const pending =
        entry === 'installed'
          ? api.readInstalledPluginDetail(initial.installedPlugins[0])
          : api.readMarketplacePluginDetail(marketplace, 'tool')
      await vi.waitFor(() => expect(release).toBeTypeOf('function'))
      try {
        if (change === 'disable') fixture.enabled = false
        if (change === 'upgrade') fixture.version = '2.0.0'
        if (change === 'uninstall' || change === 'reinstall') fixture.installed = false
        if (change === 'device' || change === 'device-round-trip') fixture.deviceId = 'device-b'
        if (change === 'invalidate') clearLocalCodexPluginsReadStateCache()
        await refreshInventory()
        if (change === 'reinstall' || change === 'device-round-trip') {
          fixture.installed = true
          fixture.deviceId = 'device-a'
          await refreshInventory()
        }
        const expected = inventoryState()
        const refreshed =
          refresh === 'disk'
            ? expected.inventory?.sourceReads?.store?.items?.[0]
            : expected.inventory?.items[0]
        if (change === 'disable') expect(refreshed?.spec.enabled).toBe(false)
        if (change === 'upgrade') expect(refreshed?.spec.version).toBe('2.0.0')
        if (change === 'uninstall') {
          if (refresh === 'disk') expect(expected.inventory?.sourceReads?.store?.items).toEqual([])
          else expect(expected.inventory?.items).toEqual([])
        }
        release(response)
        if (['device', 'device-round-trip', 'invalidate'].includes(change)) {
          await expect(pending).rejects.toThrow('changed')
        } else {
          await pending
        }
        expect(inventoryState(), change).toEqual(expected)
      } finally {
        release(response)
        await Promise.allSettled([pending])
        fixture.request.mockImplementation(original)
      }
    }
  )
})
