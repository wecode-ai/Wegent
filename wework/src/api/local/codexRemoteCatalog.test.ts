import { Blob as NodeBlob } from 'node:buffer'
import { createHash, webcrypto } from 'node:crypto'
import { mkdir, mkdtemp, rm, rmdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  clearPluginMarketplaceCache,
  getPluginMarketplaceCache,
  projectOpenAiRemoteCatalog,
  resetPluginMarketplaceCacheMemory,
  setPluginMarketplaceCache,
} from '@/features/plugins/pluginMarketplaceCache'
import { item, installedItem } from '@/features/plugins/pluginMarketplaceCache.test-fixtures'
import { useOpenAiPluginCatalog } from '@/features/plugins/useOpenAiPluginCatalog'
import {
  clearStoredCloudConnection,
  saveStoredCloudConnection,
} from '@/features/cloud-connection/cloudConnectionStorage'
import { switchLocalCodexAccount } from './codexAuth'
import { createLocalCodexPluginApi } from './codexPlugins'
import {
  createSharedRemotePluginCatalog,
  REMOTE_PLUGIN_CATALOG_STORAGE_KEY,
} from './codexRemoteCatalog'
import { getLocalCodexAuthStatus } from './runtimeAuthStatus'
import { RendererStorageStore } from '../../../electron/src/host/renderer-storage-store'

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  invokeHost: vi.fn(),
  deviceId: 'device-a',
  runtimeInstanceId: 'runtime-a',
  authScope: 'codex-account-a',
  authFingerprint: 'old-credentials',
  startCodex: vi.fn(),
}))

vi.mock('@/api/local/runtimeAuthStatus', () => ({
  getLocalCodexAuthStatus: vi.fn(async () => ({
    exists: true,
    catalogScope: mocks.authScope,
    sha256: mocks.authFingerprint,
  })),
}))

vi.mock('@/api/dsh/desktopHost', () => ({
  invokeDesktopHost: mocks.invokeHost,
}))

vi.mock('@/lib/runtime-environment', () => ({
  isDesktopRuntime: () => true,
  isElectronRuntime: () => true,
}))

vi.mock('@/desktop/localExecutor', () => ({
  requestLocalExecutor: (...args: unknown[]) => mocks.request(...args),
  ensureLocalExecutorAvailable: async () => ({
    deviceId: mocks.deviceId,
    runtimeInstanceId: mocks.runtimeInstanceId,
  }),
  ensureLocalExecutorStarted: async () => {
    mocks.startCodex()
    return { deviceId: mocks.deviceId }
  },
  getKnownLocalExecutorDeviceId: () => mocks.deviceId,
}))

describe('OpenAI official catalog persistence', () => {
  const cacheKey = 'test-wework-account'
  const marketplaceId = 'openai-curated-remote'
  const now = Date.UTC(2026, 10, 18)
  const listing = item({
    id: `documents@${marketplaceId}`,
    name: 'documents',
    sourceProvider: 'codex',
    manifest: { marketplaceId },
  })
  const catalogItem = { ...listing, components: { ...listing.components, apps: [] } }
  const liveResponse = {
    marketplaceLoadErrors: [],
    marketplaces: [
      {
        name: marketplaceId,
        plugins: [{ id: listing.id, name: listing.name, installed: true, enabled: true }],
      },
    ],
  }

  function seed(fetchedAt: number) {
    const scope = createHash('sha256')
      .update(JSON.stringify([mocks.deviceId, mocks.authScope, cacheKey]))
      .digest('hex')
    localStorage.setItem(
      REMOTE_PLUGIN_CATALOG_STORAGE_KEY,
      JSON.stringify({ version: 1, scope, fetchedAt, items: [catalogItem] })
    )
  }

  function holdCatalogRequest() {
    let resolve!: (response: typeof liveResponse) => void
    mocks.request.mockImplementationOnce(
      () =>
        new Promise<typeof liveResponse>(done => {
          resolve = done
        })
    )
    return () => resolve(liveResponse)
  }

  beforeEach(() => {
    clearPluginMarketplaceCache()
    mocks.deviceId = 'device-a'
    mocks.runtimeInstanceId = 'runtime-restarted'
    mocks.authScope = 'codex-account-a'
    mocks.authFingerprint = 'old-credentials'
    mocks.startCodex.mockClear()
    mocks.request.mockReset().mockResolvedValue(liveResponse)
    mocks.invokeHost.mockReset().mockResolvedValue({ persisted: true })
    vi.stubGlobal('Blob', NodeBlob)
    vi.stubGlobal('crypto', webcrypto)
    vi.spyOn(Date, 'now').mockReturnValue(now)
  })

  afterEach(() => {
    clearPluginMarketplaceCache()
    clearStoredCloudConnection()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  test('uses the persisted snapshot after restart and credential renewal within 30 minutes', async () => {
    const fetchedAt = now - 29 * 60_000 - 59_000
    seed(fetchedAt)
    mocks.authFingerprint = 'renewed-credentials'
    const onCached = vi.fn()
    const result = await createLocalCodexPluginApi().readRemoteCatalog({
      accountScope: cacheKey,
      forceRefetch: false,
      onCached,
    })
    expect(result.snapshot).toMatchObject({ fetchedAt, items: [catalogItem] })
    expect(onCached).toHaveBeenCalledWith(result.snapshot, 'device-a')
    expect(mocks.startCodex).not.toHaveBeenCalled()
    expect(mocks.request).not.toHaveBeenCalled()
  })

  test('restores stale rows for the All tab without starting a remote refresh', async () => {
    const fetchedAt = now - 31 * 60_000
    seed(fetchedAt)
    const onCached = vi.fn()
    const result = await createLocalCodexPluginApi().readRemoteCatalog({
      accountScope: cacheKey,
      cacheOnly: true,
      forceRefetch: false,
      onCached,
    })
    expect(result.snapshot?.fetchedAt).toBe(fetchedAt)
    expect(onCached).toHaveBeenCalledWith(result.snapshot, 'device-a')
    expect(mocks.startCodex).not.toHaveBeenCalled()
    expect(mocks.request).not.toHaveBeenCalled()
  })

  test('publishes stale rows at the 30-minute boundary and joins a concurrent manual refresh', async () => {
    seed(now - 30 * 60_000)
    const complete = holdCatalogRequest()
    const onCached = vi.fn()
    const api = createLocalCodexPluginApi()
    const options = { accountScope: cacheKey, forceRefetch: false, onCached }
    const automatic = api.readRemoteCatalog(options)
    await vi.waitFor(() => expect(mocks.request).toHaveBeenCalledTimes(1))
    expect(onCached).toHaveBeenCalledWith(
      expect.objectContaining({ fetchedAt: now - 30 * 60_000, items: [catalogItem] }),
      'device-a'
    )
    const manualCached = vi.fn()
    const manual = api.readRemoteCatalog({
      ...options,
      forceRefetch: true,
      onCached: manualCached,
    })
    await vi.waitFor(() => expect(manualCached).toHaveBeenCalledOnce())
    const allCached = vi.fn()
    const all = api.readRemoteCatalog({ ...options, cacheOnly: true, onCached: allCached })
    await vi.waitFor(() => expect(allCached).toHaveBeenCalledOnce())
    expect(mocks.request).toHaveBeenCalledTimes(1)
    mocks.authFingerprint = 'renewed-during-refresh'
    complete()
    const [automaticResult, manualResult, allResult] = await Promise.all([automatic, manual, all])
    expect(manualResult.snapshot).toBe(automaticResult.snapshot)
    expect(allResult.snapshot).toBe(automaticResult.snapshot)
    expect(automaticResult.snapshot).toMatchObject({
      fetchedAt: now,
      items: [{ id: listing.id, installed: false, enabled: false }],
    })
    expect(mocks.request).toHaveBeenCalledWith('codex.app_server_request', {
      method: 'plugin/list',
      params: { cwds: null, forceRefetch: true },
    })
    expect(JSON.parse(localStorage.getItem(REMOTE_PLUGIN_CATALOG_STORAGE_KEY)!)).toMatchObject({
      fetchedAt: now,
      items: [{ id: listing.id, installed: false }],
    })
  })

  test('keeps the previous snapshot on network and incomplete-directory errors, then retries manually', async () => {
    seed(now - 1000)
    const previous = localStorage.getItem(REMOTE_PLUGIN_CATALOG_STORAGE_KEY)
    mocks.request.mockRejectedValueOnce(new Error('Network unavailable'))
    mocks.request.mockResolvedValueOnce({ marketplaces: [] })
    mocks.request.mockResolvedValueOnce({
      ...liveResponse,
      marketplaces: [{ ...liveResponse.marketplaces[0], plugins: [] }],
    })
    const onCached = vi.fn()
    const api = createLocalCodexPluginApi()
    const options = { accountScope: cacheKey, forceRefetch: true, onCached }
    await expect(api.readRemoteCatalog(options)).rejects.toThrow('Network unavailable')
    expect(localStorage.getItem(REMOTE_PLUGIN_CATALOG_STORAGE_KEY)).toBe(previous)
    await expect(api.readRemoteCatalog(options)).rejects.toThrow('Incomplete remote plugin catalog')
    expect(localStorage.getItem(REMOTE_PLUGIN_CATALOG_STORAGE_KEY)).toBe(previous)
    await expect(api.readRemoteCatalog(options)).rejects.toThrow('Incomplete remote plugin catalog')
    expect(localStorage.getItem(REMOTE_PLUGIN_CATALOG_STORAGE_KEY)).toBe(previous)
    expect(onCached).toHaveBeenCalledTimes(3)
    await expect(api.readRemoteCatalog(options)).resolves.toMatchObject({
      snapshot: { fetchedAt: now },
    })
  })

  test('publishes official rows when an unrelated marketplace fails', async () => {
    seed(now - 31 * 60_000)
    mocks.request.mockResolvedValueOnce({
      ...liveResponse,
      marketplaceLoadErrors: [
        { marketplacePath: '/unrelated/.agents/plugins/marketplace.json', message: 'unavailable' },
      ],
    })
    await expect(
      createLocalCodexPluginApi().readRemoteCatalog({
        accountScope: cacheKey,
        forceRefetch: false,
        onCached: vi.fn(),
      })
    ).resolves.toMatchObject({ snapshot: { fetchedAt: now, items: [{ id: listing.id }] } })
  })

  test('caches an explicit empty catalog on first load', async () => {
    mocks.request.mockResolvedValueOnce({
      ...liveResponse,
      marketplaces: [{ ...liveResponse.marketplaces[0], plugins: [] }],
    })
    const options = { accountScope: cacheKey, forceRefetch: false, onCached: vi.fn() }
    const api = createLocalCodexPluginApi()
    await expect(api.readRemoteCatalog(options)).resolves.toMatchObject({
      snapshot: { fetchedAt: now, items: [] },
    })
    await api.readRemoteCatalog(options)
    expect(mocks.request).toHaveBeenCalledTimes(1)
  })

  test('retains the last official directory when a known official marketplace path fails', async () => {
    const officialRoot = '/official'
    seed(now - 31 * 60_000)
    const stored = JSON.parse(localStorage.getItem(REMOTE_PLUGIN_CATALOG_STORAGE_KEY)!)
    stored.items[0].manifest.marketplacePath = officialRoot
    localStorage.setItem(REMOTE_PLUGIN_CATALOG_STORAGE_KEY, JSON.stringify(stored))
    mocks.request.mockResolvedValueOnce({
      ...liveResponse,
      marketplaceLoadErrors: [
        {
          marketplacePath: `${officialRoot}/.agents/plugins/marketplace.json`,
          message: 'unavailable',
        },
      ],
    })
    await expect(
      createLocalCodexPluginApi().readRemoteCatalog({
        accountScope: cacheKey,
        forceRefetch: false,
        onCached: vi.fn(),
      })
    ).rejects.toThrow('Incomplete remote plugin catalog')
    expect(JSON.parse(localStorage.getItem(REMOTE_PLUGIN_CATALOG_STORAGE_KEY)!)).toEqual(stored)
  })

  test.each([
    { id: '' },
    { name: '' },
    { name: '   ' },
    { interface: { logo: 123 } },
    { components: { ...catalogItem.components, hooks: undefined } },
    { currentDeviceInstallation: { state: 'uninstalling' } },
  ])('rebuilds a parseable cache with an invalid summary %#', async fields => {
    seed(now - 1000)
    const stored = JSON.parse(localStorage.getItem(REMOTE_PLUGIN_CATALOG_STORAGE_KEY)!)
    stored.items[0] = { ...stored.items[0], ...fields }
    localStorage.setItem(REMOTE_PLUGIN_CATALOG_STORAGE_KEY, JSON.stringify(stored))
    const onCached = vi.fn()
    const result = await createLocalCodexPluginApi().readRemoteCatalog({
      accountScope: cacheKey,
      forceRefetch: false,
      onCached,
    })
    expect(onCached).toHaveBeenCalledWith(undefined, mocks.deviceId)
    expect(mocks.request).toHaveBeenCalledTimes(1)
    expect(result.snapshot).toMatchObject({ fetchedAt: now, items: [{ id: listing.id }] })
  })

  test('rejects a superseded view before it can interrupt a newer account request', async () => {
    const auth = Promise.withResolvers<Awaited<ReturnType<typeof getLocalCodexAuthStatus>>>()
    vi.mocked(getLocalCodexAuthStatus).mockReturnValueOnce(auth.promise)
    const api = createLocalCodexPluginApi()
    const initialAuthCalls = vi.mocked(getLocalCodexAuthStatus).mock.calls.length
    let active = true
    const old = api.readRemoteCatalog({
      accountScope: 'previous-cloud-account',
      forceRefetch: false,
      onCached: vi.fn(),
      canStart: () => active,
    })
    const rejected = expect(old).rejects.toThrow('Plugin catalog scope changed')
    await vi.waitFor(() =>
      expect(getLocalCodexAuthStatus).toHaveBeenCalledTimes(initialAuthCalls + 1)
    )
    active = false
    const complete = holdCatalogRequest()
    const latest = api.readRemoteCatalog({
      accountScope: 'current-cloud-account',
      forceRefetch: false,
      onCached: vi.fn(),
    })
    await vi.waitFor(() => expect(mocks.request).toHaveBeenCalledTimes(1))
    auth.resolve(await getLocalCodexAuthStatus())
    await rejected
    complete()
    await expect(latest).resolves.toMatchObject({ snapshot: { items: [{ id: listing.id }] } })
    expect(mocks.request).toHaveBeenCalledTimes(1)
  })

  test('does not write a late refresh after the WeWork cloud account disconnects', async () => {
    saveStoredCloudConnection({
      backendUrl: 'https://wework.example.test',
      apiBaseUrl: 'https://wework.example.test/api',
      socketBaseUrl: 'https://wework.example.test',
      socketPath: '/socket.io',
      user: { id: 1, user_name: 'test', email: 'test@example.test' },
      connectedAt: new Date(now).toISOString(),
    })
    seed(now - 31 * 60_000)
    const previous = localStorage.getItem(REMOTE_PLUGIN_CATALOG_STORAGE_KEY)
    const complete = holdCatalogRequest()
    const refreshing = createLocalCodexPluginApi().readRemoteCatalog({
      accountScope: cacheKey,
      forceRefetch: false,
      onCached: vi.fn(),
    })
    const rejected = expect(refreshing).rejects.toThrow('Plugin catalog scope changed')
    await vi.waitFor(() => expect(mocks.request).toHaveBeenCalledTimes(1))
    clearStoredCloudConnection()
    complete()
    await rejected
    expect(localStorage.getItem(REMOTE_PLUGIN_CATALOG_STORAGE_KEY)).toBe(previous)
  })

  test('times out a hung local auth probe and never admits its late result', async () => {
    const status = await getLocalCodexAuthStatus()
    const auth = Promise.withResolvers<typeof status>()
    vi.mocked(getLocalCodexAuthStatus).mockReturnValueOnce(auth.promise)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const onCached = vi.fn()
      const pending = createLocalCodexPluginApi().readRemoteCatalog({
        accountScope: cacheKey,
        forceRefetch: false,
        onCached,
      })
      const rejected = expect(pending).rejects.toThrow('identity check timed out')
      await vi.advanceTimersByTimeAsync(30_000)
      await rejected
      auth.resolve(status)
      await vi.advanceTimersByTimeAsync(0)
      expect(onCached).not.toHaveBeenCalled()
      expect(mocks.request).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  test.each([1, 2])('handles %i quota failures before committing to the host', async failures => {
    seed(now - 31 * 60_000)
    const before = JSON.parse(localStorage.getItem(REMOTE_PLUGIN_CATALOG_STORAGE_KEY)!)
    const storageSetItem = Storage.prototype.setItem
    let remaining = failures
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
      if (key === REMOTE_PLUGIN_CATALOG_STORAGE_KEY && remaining-- > 0)
        throw new DOMException('Quota exceeded', 'QuotaExceededError')
      storageSetItem.call(this, key, value)
    })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const options = { accountScope: cacheKey, forceRefetch: false, onCached: vi.fn() }
    const api = createLocalCodexPluginApi()
    const refresh = api.readRemoteCatalog(options)
    if (failures === 2) {
      await expect(refresh).rejects.toThrow('Could not save the OpenAI plugin catalog')
      expect(mocks.invokeHost).not.toHaveBeenCalled()
      expect(JSON.parse(localStorage.getItem(REMOTE_PLUGIN_CATALOG_STORAGE_KEY)!)).toEqual(before)
    } else {
      await expect(refresh).resolves.toMatchObject({ snapshot: { fetchedAt: now } })
      expect(mocks.invokeHost).toHaveBeenCalledOnce()
      expect(localStorage.getItem(REMOTE_PLUGIN_CATALOG_STORAGE_KEY)).toMatch(/^lz:/)
    }
    expect(mocks.request).toHaveBeenCalledTimes(1)
  })

  test('reports a failed disk write and restores the retried catalog after restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wework-official-catalog-'))
    const store = new RendererStorageStore(root)
    try {
      seed(now - 1000)
      const previous = localStorage.getItem(REMOTE_PLUGIN_CATALOG_STORAGE_KEY)!
      await store.initialize({ [REMOTE_PLUGIN_CATALOG_STORAGE_KEY]: previous, appearance: 'dark' })
      const blocked = join(root, `renderer-local-storage.json.${process.pid}.tmp`)
      await mkdir(blocked)
      mocks.invokeHost.mockImplementation(async (method, update) => {
        expect(method).toBe('rendererStorage.update')
        await store.update(update)
        return { persisted: true }
      })
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      const readCatalog = createLocalCodexPluginApi().readRemoteCatalog
      const opened = renderHook(() =>
        useOpenAiPluginCatalog({
          cacheKey,
          accountScope: cacheKey,
          deviceId: mocks.deviceId,
          enabled: true,
          restoreForAll: false,
          readCatalog,
        })
      )
      try {
        await waitFor(() => expect(opened.result.current.loading).toBe(false))
        act(() => opened.result.current.refresh())
        await waitFor(() => expect(opened.result.current.error).toBe('storage'))
        expect(getPluginMarketplaceCache(cacheKey)?.marketplaceItems).toHaveLength(1)
        expect(localStorage.getItem(REMOTE_PLUGIN_CATALOG_STORAGE_KEY)).toBe(previous)
        expect((await store.read())[REMOTE_PLUGIN_CATALOG_STORAGE_KEY]).toBe(previous)

        await rmdir(blocked)
        act(() => opened.result.current.refresh())
        await waitFor(() => {
          expect(opened.result.current.error).toBeNull()
          expect(opened.result.current.loading).toBe(false)
        })
        expect(mocks.request).toHaveBeenCalledTimes(2)
      } finally {
        opened.unmount()
        await store.close()
      }

      const entries = await new RendererStorageStore(root).initialize({})
      expect(entries.appearance).toBe('dark')
      const persisted = entries[REMOTE_PLUGIN_CATALOG_STORAGE_KEY]
      localStorage.setItem(REMOTE_PLUGIN_CATALOG_STORAGE_KEY, persisted)
      const cold = createSharedRemotePluginCatalog()
      const { scope } = JSON.parse(previous)
      const load = vi.fn()
      await expect(
        cold.read({
          scope,
          requestIdentity: scope,
          force: false,
          cacheOnly: false,
          onCached: vi.fn(),
          load,
        })
      ).resolves.toMatchObject({ fetchedAt: now, items: [{ id: listing.id }] })
      expect(load).not.toHaveBeenCalled()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('keeps the file while detaching cards and requiring verification when reopening the market', async () => {
    seed(now - 1000)
    const readCatalog = createLocalCodexPluginApi().readRemoteCatalog
    const renderCatalog = () =>
      renderHook(() =>
        useOpenAiPluginCatalog({
          cacheKey,
          deviceId: mocks.deviceId,
          accountScope: cacheKey,
          enabled: true,
          restoreForAll: false,
          readCatalog,
        })
      )
    const opened = renderCatalog()
    await waitFor(() =>
      expect(getPluginMarketplaceCache(cacheKey)?.marketplaceItems).toHaveLength(1)
    )
    opened.unmount()
    expect(getPluginMarketplaceCache(cacheKey)?.marketplaceItems).toEqual([])
    expect(localStorage.getItem(REMOTE_PLUGIN_CATALOG_STORAGE_KEY)).not.toBeNull()

    vi.mocked(getLocalCodexAuthStatus).mockRejectedValueOnce(new Error('auth status unavailable'))
    const reopened = renderCatalog()
    expect(getPluginMarketplaceCache(cacheKey)?.marketplaceItems).toEqual([])
    try {
      await waitFor(() => expect(reopened.result.current.error).toBe('failed'))
      expect(getPluginMarketplaceCache(cacheKey)?.marketplaceItems).toEqual([])
    } finally {
      reopened.unmount()
    }
  })

  test('invalidates the cache and rejects in-flight results when switching accounts without a market open', async () => {
    seed(now - 31 * 60_000)
    const complete = holdCatalogRequest()
    const refreshing = createLocalCodexPluginApi().readRemoteCatalog({
      accountScope: cacheKey,
      forceRefetch: false,
      onCached: vi.fn(),
    })
    const rejected = expect(refreshing).rejects.toThrow('Plugin catalog scope changed')
    await vi.waitFor(() => expect(mocks.request).toHaveBeenCalledTimes(1))
    mocks.request.mockResolvedValueOnce({ activeAccountId: 'codex-account-b' })
    await switchLocalCodexAccount('codex-account-b')
    expect(localStorage.getItem(REMOTE_PLUGIN_CATALOG_STORAGE_KEY)).toBeNull()
    complete()
    await rejected
    expect(localStorage.getItem(REMOTE_PLUGIN_CATALOG_STORAGE_KEY)).toBeNull()
  })

  test('finishes a valid background refresh without reattaching cards after leaving the market', async () => {
    seed(now - 31 * 60_000)
    const readCatalog = createLocalCodexPluginApi().readRemoteCatalog
    const complete = holdCatalogRequest()
    const opened = renderHook(() =>
      useOpenAiPluginCatalog({
        cacheKey,
        deviceId: mocks.deviceId,
        accountScope: cacheKey,
        enabled: true,
        restoreForAll: false,
        readCatalog,
      })
    )
    await waitFor(() => expect(mocks.request).toHaveBeenCalledTimes(1))
    opened.unmount()
    complete()
    await vi.waitFor(() =>
      expect(JSON.parse(localStorage.getItem(REMOTE_PLUGIN_CATALOG_STORAGE_KEY)!)).toMatchObject({
        fetchedAt: now,
        items: [{ id: listing.id }],
      })
    )
    expect(getPluginMarketplaceCache(cacheKey)?.marketplaceItems).toEqual([])
  })

  test('hides a projected directory and reloads after a confirmed native identity change', async () => {
    seed(now - 31 * 60_000)
    const readCatalog = createLocalCodexPluginApi().readRemoteCatalog
    const completeOld = holdCatalogRequest()
    const completeNew = holdCatalogRequest()
    const opened = renderHook(() =>
      useOpenAiPluginCatalog({
        cacheKey,
        deviceId: mocks.deviceId,
        accountScope: cacheKey,
        enabled: true,
        restoreForAll: false,
        readCatalog,
      })
    )
    try {
      await waitFor(() => expect(mocks.request).toHaveBeenCalledTimes(1))
      expect(getPluginMarketplaceCache(cacheKey)?.marketplaceItems).toHaveLength(1)
      mocks.authScope = 'codex-account-b'
      completeOld()
      await waitFor(() => expect(mocks.request).toHaveBeenCalledTimes(2))
      expect(getPluginMarketplaceCache(cacheKey)?.marketplaceItems).toEqual([])
      completeNew()
      await waitFor(() =>
        expect(getPluginMarketplaceCache(cacheKey)?.marketplaceItems).toHaveLength(1)
      )
    } finally {
      opened.unmount()
    }
  })

  test.each(['damaged', 'another account'])(
    'rebuilds an entry for %s and discards a response after a Codex account change',
    async state => {
      seed(now - 1000)
      if (state === 'damaged') localStorage.setItem(REMOTE_PLUGIN_CATALOG_STORAGE_KEY, '{invalid')
      else mocks.authScope = 'codex-account-b'
      const initial = localStorage.getItem(REMOTE_PLUGIN_CATALOG_STORAGE_KEY)
      const complete = holdCatalogRequest()
      const onCached = vi.fn()
      const api = createLocalCodexPluginApi()
      const options = { accountScope: cacheKey, forceRefetch: false, onCached }
      const pending = api.readRemoteCatalog(options)
      const rejected = expect(pending).rejects.toThrow('Plugin catalog scope changed')
      await vi.waitFor(() => expect(mocks.request).toHaveBeenCalledOnce())
      expect(onCached).toHaveBeenCalledWith(undefined, 'device-a')
      mocks.authScope = 'codex-account-c'
      complete()
      await rejected
      expect(localStorage.getItem(REMOTE_PLUGIN_CATALOG_STORAGE_KEY)).toBe(initial)
      await expect(api.readRemoteCatalog(options)).resolves.toMatchObject({
        snapshot: { fetchedAt: now, items: [{ id: listing.id }] },
      })
    }
  )

  test('projects live installed membership and keeps the remote rows out of durable inventory', () => {
    const deviceId = mocks.deviceId
    const installed = installedItem(String(listing.id), marketplaceId, listing.name).raw
    const inventory = {
      cacheKey,
      deviceId,
      fetchedAt: now,
      marketplaceItems: [],
      installedPlugins: [installed],
      marketplaces: [],
      selectedMarketplaceKey: '',
    }
    setPluginMarketplaceCache(inventory)
    projectOpenAiRemoteCatalog(cacheKey, deviceId, { fetchedAt: now, items: [catalogItem] })
    expect(getPluginMarketplaceCache(cacheKey)?.marketplaceItems[0]?.installed).toBe(true)
    setPluginMarketplaceCache({ ...inventory, installedPlugins: [] }, { mutation: true })
    projectOpenAiRemoteCatalog(cacheKey, deviceId, { fetchedAt: now + 1, items: [catalogItem] })
    expect(getPluginMarketplaceCache(cacheKey)?.marketplaceItems[0]?.installed).toBe(false)
    resetPluginMarketplaceCacheMemory()
    expect(getPluginMarketplaceCache(cacheKey)?.marketplaceItems).toEqual([])
  })

  test('keeps cloud cards when projecting the first known device', () => {
    const cloud = item({ id: 1, name: 'cloud-tool', sourceProvider: 'wegent' })
    setPluginMarketplaceCache({
      cacheKey,
      deviceId: '',
      fetchedAt: now,
      marketplaceItems: [cloud],
      installedPlugins: [],
      marketplaces: [],
      selectedMarketplaceKey: '',
    })
    projectOpenAiRemoteCatalog(cacheKey, mocks.deviceId, { fetchedAt: now, items: [catalogItem] })
    expect(getPluginMarketplaceCache(cacheKey)?.marketplaceItems.map(row => row.id)).toEqual([
      cloud.id,
      listing.id,
    ])
  })
})
