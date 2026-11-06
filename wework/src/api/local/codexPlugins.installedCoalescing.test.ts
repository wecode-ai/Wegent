import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  clearLocalCodexPluginsReadStateCache,
  createLocalCodexPluginApi,
  peekLocalInstalledPluginInventory,
} from './codexPlugins'
import {
  clearPluginMarketplaceCache,
  setPluginMarketplaceCache,
} from '@/features/plugins/pluginMarketplaceCache'

const mocks = vi.hoisted(() => ({
  deviceId: 'device-a',
  runtimeInstanceId: 'runtime-a',
  account: 'account-a',
  auth: vi.fn(),
  installed: vi.fn(),
  catalog: vi.fn(),
  uninstall: vi.fn(),
  store: vi.fn(),
  personal: vi.fn(),
  config: vi.fn(),
  registered: vi.fn(),
}))

vi.mock('@/lib/runtime-environment', () => ({
  isDesktopRuntime: () => true,
  isElectronRuntime: () => true,
}))
vi.mock('./runtimeAuthStatus', () => ({
  getLocalCodexAuthStatus: () => mocks.auth(),
}))
vi.mock('@/desktop/localExecutor', () => ({
  ensureLocalExecutorStarted: async () => ({
    deviceId: mocks.deviceId,
    runtimeInstanceId: mocks.runtimeInstanceId,
  }),
  getKnownLocalExecutorDeviceId: () => mocks.deviceId,
  ensureBundledPluginMarketplaceRegistered: () => mocks.registered(),
  getInitializedBundledPluginMarketplace: () => null,
  withBundledPluginUpdatesPaused: (_name: string, mutation: () => Promise<unknown>) => mutation(),
  requestLocalExecutor: async (method: string, params?: { method?: string }) => {
    if (method === 'executor.plugins.links.list') return []
    if (method === 'executor.plugins.personal.list') return mocks.personal()
    if (method === 'executor.codex_home.config.read') return mocks.config()
    if (method === 'executor.plugins.store.list') return mocks.store()
    if (method === 'runtime.codex.plugin.uninstall_local') return { localCommitted: true }
    if (method === 'codex.app_server_request' && params?.method === 'plugin/installed')
      return mocks.installed()
    if (method === 'codex.app_server_request' && params?.method === 'plugin/list')
      return mocks.catalog()
    if (method === 'codex.app_server_request' && params?.method === 'plugin/uninstall')
      return mocks.uninstall()
    throw new Error(`Unexpected request: ${method}/${params?.method}`)
  },
}))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => {
    resolve = done
  })
  return { promise, resolve }
}

const empty = { marketplaces: [] }
const oldInventory = {
  marketplaces: [
    {
      name: 'local-tools',
      path: '/plugins',
      plugins: [{ id: 'old', name: 'old', enabled: true, installed: true }],
    },
  ],
}
const read = () =>
  createLocalCodexPluginApi().listInstalledPlugins({ refresh: true, requireComplete: true })

beforeEach(() => {
  clearLocalCodexPluginsReadStateCache()
  clearPluginMarketplaceCache()
  mocks.deviceId = 'device-a'
  mocks.runtimeInstanceId = 'runtime-a'
  mocks.account = 'account-a'
  mocks.auth.mockReset().mockImplementation(async () => ({ sha256: mocks.account }))
  mocks.installed.mockReset().mockResolvedValue(empty)
  mocks.catalog.mockReset().mockResolvedValue(empty)
  mocks.uninstall.mockReset().mockResolvedValue({})
  mocks.store.mockReset().mockResolvedValue({ storePath: '/store', plugins: [] })
  mocks.personal.mockReset().mockResolvedValue({
    marketplaceId: 'wework-personal',
    marketplacePath: '/personal',
    plugins: [],
  })
  mocks.config.mockReset().mockResolvedValue({ enabledPluginKeys: [] })
  mocks.registered.mockReset().mockResolvedValue(undefined)
})
afterEach(() => clearPluginMarketplaceCache())

describe('installed inventory identity and revision', () => {
  const displays = {
    marketplace: async () =>
      (await createLocalCodexPluginApi().readState({ mergeAllMarketplaces: true }))
        .installedPlugins,
    installed: async () => (await createLocalCodexPluginApi().listInstalledPlugins()).items,
  }
  const warmDisplay = async () => {
    mocks.installed.mockResolvedValueOnce(oldInventory)
    await createLocalCodexPluginApi().readState({ mergeAllMarketplaces: true, refresh: true })
  }

  test.each(Object.entries(displays))(
    '%s displays a fresh verified snapshot without a failing auth probe',
    async (_name, display) => {
      await warmDisplay()
      mocks.auth.mockClear().mockRejectedValue(new Error('auth probe failed'))
      expect((await display()).map(item => item.metadata.name)).toEqual(['old'])
      expect(mocks.auth).not.toHaveBeenCalled()
      expect(mocks.installed).toHaveBeenCalledOnce()
      expect(mocks.catalog).toHaveBeenCalledOnce()
    }
  )

  test('cached displays do not wait for a hung probe used by a strict reader', async () => {
    await warmDisplay()
    const probe = deferred<{ sha256: string }>()
    mocks.auth.mockClear().mockReturnValue(probe.promise)
    const strict = read()
    await vi.waitFor(() => expect(mocks.auth).toHaveBeenCalledOnce())
    try {
      for (const display of Object.values(displays))
        expect((await display()).map(item => item.metadata.name)).toEqual(['old'])
      expect(mocks.auth).toHaveBeenCalledOnce()
    } finally {
      probe.resolve({ sha256: mocks.account })
      await strict
    }
  })

  test('an account change observed during refresh revokes the previous verified snapshot', async () => {
    await warmDisplay()
    const pending = deferred<unknown>()
    mocks.installed.mockReturnValueOnce(pending.promise)
    const rejected = expect(read()).rejects.toMatchObject({ name: 'ExpiredPluginInventoryRequest' })
    await vi.waitFor(() => expect(mocks.installed).toHaveBeenCalledTimes(2))
    mocks.account = 'account-b'
    pending.resolve(oldInventory)
    await rejected
    mocks.auth.mockRejectedValue(new Error('new account probe failed'))
    for (const display of Object.values(displays))
      await expect(display()).rejects.toThrow('new account probe failed')
  })

  test.each(['marketplace refresh', 'installed refresh', 'complete inventory'])(
    '%s still requires auth when a fresh display cache exists',
    async mode => {
      await warmDisplay()
      mocks.auth.mockRejectedValue(new Error('auth probe failed'))
      const api = createLocalCodexPluginApi()
      const result =
        mode === 'marketplace refresh'
          ? api.readState({ mergeAllMarketplaces: true, refresh: true })
          : api.listInstalledPlugins(
              mode === 'installed refresh' ? { refresh: true } : { requireComplete: true }
            )
      await expect(result).rejects.toThrow('auth probe failed')
    }
  )

  test.each(Object.entries(displays))(
    '%s refuses the warm snapshot after device, runtime, session, uninstall or expiry changes',
    async (_name, display) => {
      for (const change of ['device', 'runtime', 'session', 'uninstall', 'expiry']) {
        clearLocalCodexPluginsReadStateCache()
        mocks.auth.mockImplementation(async () => ({ sha256: mocks.account }))
        await warmDisplay()
        const now = Date.now()
        if (change === 'device') mocks.deviceId += '-new'
        if (change === 'runtime') mocks.runtimeInstanceId += '-new'
        if (change === 'session') clearPluginMarketplaceCache()
        if (change === 'uninstall')
          await createLocalCodexPluginApi().uninstallInstalledPlugin('old@wework-personal')
        const clock = vi
          .spyOn(Date, 'now')
          .mockReturnValue(now + (change === 'expiry' ? 60_001 : 0))
        mocks.auth.mockRejectedValue(new Error(`auth probe failed after ${change}`))
        try {
          await expect(display()).rejects.toThrow(`auth probe failed after ${change}`)
        } finally {
          clock.mockRestore()
        }
      }
    }
  )

  test('eleven strict readers and marketplace loading share one membership request', async () => {
    const pending = deferred<unknown>()
    mocks.installed.mockReturnValueOnce(pending.promise)
    const readers = Array.from({ length: 11 }, read)
    const marketplace = createLocalCodexPluginApi().readState({
      mergeAllMarketplaces: true,
      refresh: true,
    })
    await vi.waitFor(() => expect(mocks.installed).toHaveBeenCalledOnce())
    pending.resolve(oldInventory)
    const results = await Promise.all(readers)
    await marketplace
    expect(
      results.every(result => result.items.map(item => item.metadata.name).join() === 'old')
    ).toBe(true)
    expect(mocks.installed).toHaveBeenCalledOnce()
    // Strict readers share one disk scan; catalog enrichment has its own link policy.
    expect(mocks.personal).toHaveBeenCalledTimes(2)
    expect(mocks.config).toHaveBeenCalledTimes(2)
  })

  test('follow-up catalog loading reuses only the current revision of live membership', async () => {
    const api = createLocalCodexPluginApi()
    const catalog = () =>
      api.readState({ mergeAllMarketplaces: true, refresh: true, reuseInstalledInventory: true })
    mocks.installed.mockResolvedValueOnce(oldInventory)
    expect((await read()).items.map(item => item.metadata.name)).toEqual(['old'])
    expect((await catalog()).installedPlugins.map(item => item.metadata.name)).toEqual(['old'])
    expect(mocks.installed).toHaveBeenCalledOnce()
    await api.uninstallInstalledPlugin('old@wework-personal')
    expect((await catalog()).installedPlugins).toEqual([])
    expect(mocks.installed).toHaveBeenCalledTimes(2)
    await read()
    expect(mocks.installed).toHaveBeenCalledTimes(3)
  })

  test.each(['deviceId', 'runtimeInstanceId', 'account'] as const)(
    'follow-up catalog loading never reuses another %s',
    async field => {
      mocks.installed.mockResolvedValueOnce(oldInventory)
      await read()
      mocks[field] = 'replacement'
      const result = await createLocalCodexPluginApi().readState({
        mergeAllMarketplaces: true,
        refresh: true,
        reuseInstalledInventory: true,
      })
      expect(result.installedPlugins).toEqual([])
      expect(mocks.installed).toHaveBeenCalledTimes(2)
    }
  )

  test('follow-up catalog reuse expires instead of retaining external changes indefinitely', async () => {
    mocks.installed.mockResolvedValueOnce(oldInventory)
    await read()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_001)
    try {
      const result = await createLocalCodexPluginApi().readState({
        mergeAllMarketplaces: true,
        refresh: true,
        reuseInstalledInventory: true,
      })
      expect(result.installedPlugins).toEqual([])
      expect(mocks.installed).toHaveBeenCalledTimes(2)
    } finally {
      clock.mockRestore()
    }
  })

  test('uninstall starts a new revision and a late old response cannot restore membership', async () => {
    const pending = deferred<unknown>()
    mocks.installed.mockReturnValueOnce(pending.promise)
    const rejected = expect(read()).rejects.toMatchObject({ name: 'ExpiredPluginInventoryRequest' })
    await vi.waitFor(() => expect(mocks.installed).toHaveBeenCalledOnce())
    await createLocalCodexPluginApi().uninstallInstalledPlugin('old@wework-personal')
    const results = await Promise.all([read(), read()])
    expect(mocks.installed).toHaveBeenCalledTimes(2)
    expect(results.every(result => result.items.length === 0)).toBe(true)
    pending.resolve(oldInventory)
    await rejected
    expect(peekLocalInstalledPluginInventory()?.items).toEqual([])
  })

  test('a confirmed remote uninstall expires old reads even if alias cleanup fails', async () => {
    const remote = {
      marketplaces: [
        {
          name: 'openai-curated-remote',
          path: 'openai-curated-remote',
          plugins: [
            {
              id: 'old@openai-curated-remote',
              remotePluginId: 'plugin_connector_old',
              name: 'old',
              installed: true,
              enabled: true,
            },
          ],
        },
      ],
    }
    mocks.installed.mockResolvedValueOnce(remote)
    await read()
    const pending = deferred<unknown>()
    mocks.installed.mockReturnValueOnce(pending.promise)
    const rejected = expect(read()).rejects.toMatchObject({ name: 'ExpiredPluginInventoryRequest' })
    await vi.waitFor(() => expect(mocks.installed).toHaveBeenCalledTimes(2))
    mocks.uninstall
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('alias cleanup failed'))
    const api = createLocalCodexPluginApi()
    await expect(api.uninstallInstalledPlugin('old@openai-curated-remote')).rejects.toMatchObject({
      name: 'LocalPluginUninstallCleanupError',
      localPluginUninstalled: true,
    })
    expect(mocks.uninstall).toHaveBeenCalledTimes(2)
    expect(
      (
        await api.readState({
          mergeAllMarketplaces: true,
          refresh: true,
          reuseInstalledInventory: true,
        })
      ).installedPlugins
    ).toEqual([])
    pending.resolve(remote)
    await rejected
    expect(peekLocalInstalledPluginInventory()?.items).toEqual([])
    expect(mocks.installed).toHaveBeenCalledTimes(3)
  })

  test('confirmed cloud removal invalidates pending reads without a native cache clear', async () => {
    const pending = deferred<unknown>()
    mocks.installed.mockReturnValueOnce(pending.promise)
    const rejected = expect(read()).rejects.toMatchObject({ name: 'ExpiredPluginInventoryRequest' })
    await vi.waitFor(() => expect(mocks.installed).toHaveBeenCalledOnce())
    setPluginMarketplaceCache(
      {
        cacheKey: 'cloud-account',
        deviceId: mocks.deviceId,
        marketplaceItems: [],
        installedPlugins: [],
        marketplaces: [],
        selectedMarketplaceKey: '',
        fetchedAt: Date.now(),
      },
      { mutation: true }
    )
    await expect(read()).resolves.toMatchObject({ items: [] })
    pending.resolve(oldInventory)
    await rejected
    expect(mocks.installed).toHaveBeenCalledTimes(2)
    expect(peekLocalInstalledPluginInventory()?.items).toEqual([])
  })

  test('presentation-only cache updates keep the same membership request', async () => {
    const pending = deferred<unknown>()
    mocks.installed.mockReturnValueOnce(pending.promise)
    const first = read()
    await vi.waitFor(() => expect(mocks.installed).toHaveBeenCalledOnce())
    setPluginMarketplaceCache({
      cacheKey: 'cloud-account',
      deviceId: mocks.deviceId,
      marketplaceItems: [],
      installedPlugins: [],
      marketplaces: [],
      selectedMarketplaceKey: '',
      fetchedAt: Date.now(),
    })
    const second = read()
    await vi.waitFor(() => expect(mocks.registered).toHaveBeenCalledTimes(2))
    pending.resolve(empty)
    await expect(Promise.all([first, second])).resolves.toMatchObject([
      { items: [] },
      { items: [] },
    ])
    expect(mocks.installed).toHaveBeenCalledOnce()
  })

  test('a lenient reader cannot publish a partial fallback after uninstall', async () => {
    const pending = deferred<unknown>()
    mocks.installed.mockReturnValueOnce(pending.promise)
    const old = createLocalCodexPluginApi().listInstalledPlugins({ refresh: true })
    const rejected = expect(old).rejects.toMatchObject({ name: 'ExpiredPluginInventoryRequest' })
    await vi.waitFor(() => expect(mocks.installed).toHaveBeenCalledOnce())
    await createLocalCodexPluginApi().uninstallInstalledPlugin('old@wework-personal')
    await expect(read()).resolves.toMatchObject({ items: [] })
    pending.resolve(oldInventory)
    await rejected
    expect(peekLocalInstalledPluginInventory()?.items).toEqual([])
  })

  test('a slow marketplace response cannot return pre-uninstall membership', async () => {
    const pending = deferred<unknown>()
    mocks.installed.mockResolvedValueOnce(oldInventory)
    mocks.catalog.mockReturnValueOnce(pending.promise)
    const old = createLocalCodexPluginApi().readState({ mergeAllMarketplaces: true, refresh: true })
    const rejected = expect(old).rejects.toMatchObject({ name: 'ExpiredPluginInventoryRequest' })
    await vi.waitFor(() => expect(mocks.catalog).toHaveBeenCalledOnce())
    await createLocalCodexPluginApi().uninstallInstalledPlugin('old@wework-personal')
    await expect(read()).resolves.toMatchObject({ items: [] })
    pending.resolve(empty)
    await rejected
    expect(peekLocalInstalledPluginInventory()?.items).toEqual([])
  })

  test.each(['deviceId', 'runtimeInstanceId', 'account'] as const)(
    'never joins or restores a request from another %s',
    async field => {
      const pending = deferred<unknown>()
      mocks.installed.mockReturnValueOnce(pending.promise)
      const rejected = expect(read()).rejects.toMatchObject({
        name: 'ExpiredPluginInventoryRequest',
      })
      await vi.waitFor(() => expect(mocks.installed).toHaveBeenCalledOnce())
      const original = mocks[field]
      mocks[field] = 'replacement'
      await expect(read()).resolves.toMatchObject({ items: [] })
      // Returning to the original identity must not re-admit its old request.
      mocks[field] = original
      await expect(read()).resolves.toMatchObject({ items: [] })
      pending.resolve(oldInventory)
      await rejected
      expect(mocks.installed).toHaveBeenCalledTimes(3)
    }
  )

  test('rejects an account change during a read even without a newer consumer', async () => {
    const pending = deferred<unknown>()
    mocks.installed.mockReturnValueOnce(pending.promise)
    const rejected = expect(read()).rejects.toMatchObject({ name: 'ExpiredPluginInventoryRequest' })
    await vi.waitFor(() => expect(mocks.installed).toHaveBeenCalledOnce())
    mocks.account = 'account-b'
    pending.resolve(oldInventory)
    await rejected
    expect(mocks.installed).toHaveBeenCalledOnce()
    expect(peekLocalInstalledPluginInventory()).toBeNull()
  })

  test('checks the version after a slow local source, not just after Codex returns', async () => {
    const store = deferred<unknown>()
    mocks.store.mockReturnValueOnce(store.promise)
    mocks.installed.mockResolvedValueOnce(oldInventory)
    const rejected = expect(read()).rejects.toMatchObject({ name: 'ExpiredPluginInventoryRequest' })
    await vi.waitFor(() => expect(mocks.installed).toHaveBeenCalledOnce())
    clearLocalCodexPluginsReadStateCache()
    await expect(read()).resolves.toMatchObject({ items: [] })
    store.resolve({ storePath: '/store', plugins: [] })
    await rejected
    expect(peekLocalInstalledPluginInventory()?.items).toEqual([])
  })

  test('a delayed old admission cannot invalidate the new revision in flight', async () => {
    const registration = deferred<void>()
    mocks.registered.mockReturnValueOnce(registration.promise)
    const rejected = expect(read()).rejects.toMatchObject({ name: 'ExpiredPluginInventoryRequest' })
    await vi.waitFor(() => expect(mocks.registered).toHaveBeenCalledOnce())
    clearLocalCodexPluginsReadStateCache()
    const current = deferred<unknown>()
    mocks.installed.mockReturnValueOnce(current.promise)
    const fresh = read()
    await vi.waitFor(() => expect(mocks.installed).toHaveBeenCalledOnce())
    registration.resolve()
    await rejected
    current.resolve(empty)
    await expect(fresh).resolves.toMatchObject({ items: [] })
    expect(mocks.installed).toHaveBeenCalledOnce()
  })

  test('failed requests are evicted and explicit settled refreshes still read live state', async () => {
    mocks.installed.mockRejectedValueOnce(new Error('offline'))
    const results = await Promise.allSettled([read(), read()])
    expect(results.every(result => result.status === 'rejected')).toBe(true)
    expect(mocks.installed).toHaveBeenCalledOnce()
    await expect(read()).resolves.toMatchObject({ items: [] })
    mocks.installed.mockResolvedValueOnce(oldInventory)
    expect((await read()).items.map(item => item.metadata.name)).toEqual(['old'])
    expect(mocks.installed).toHaveBeenCalledTimes(3)
  })
})
