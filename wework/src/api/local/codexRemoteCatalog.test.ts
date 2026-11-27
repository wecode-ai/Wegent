import { Blob as NodeBlob } from 'node:buffer'
import { createHash, webcrypto } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
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
import { getLocalCodexAuthStatus } from './runtimeAuthStatus'
import { OpenAiCatalogStore } from '../../../electron/src/host/openai-catalog-store'
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
  getKnownLocalExecutorRuntimeInstanceId: () => mocks.runtimeInstanceId,
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

  let storedCatalog: string | null

  function seed(fetchedAt: number) {
    const scope = createHash('sha256')
      .update(JSON.stringify([mocks.deviceId, mocks.authScope, cacheKey]))
      .digest('hex')
    storedCatalog = JSON.stringify({ version: 1, scope, fetchedAt, items: [catalogItem] })
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
    mocks.deviceId = 'device-a'
    mocks.runtimeInstanceId = 'runtime-restarted'
    mocks.authScope = 'codex-account-a'
    mocks.authFingerprint = 'old-credentials'
    mocks.startCodex.mockClear()
    mocks.request.mockReset().mockResolvedValue(liveResponse)
    storedCatalog = null
    mocks.invokeHost.mockReset().mockImplementation(async (method, params) => {
      switch (method) {
        case 'pluginCatalog.readOpenAi':
          return storedCatalog
        case 'pluginCatalog.writeOpenAi':
          storedCatalog = params.snapshot
          return
        case 'pluginCatalog.clearOpenAi':
          storedCatalog = null
          return
      }
      throw new Error(`Unexpected host capability ${method}`)
    })
    vi.stubGlobal('Blob', NodeBlob)
    vi.stubGlobal('crypto', webcrypto)
    vi.spyOn(Date, 'now').mockReturnValue(now)
  })

  afterEach(async () => {
    mocks.invokeHost.mockReset().mockResolvedValue(undefined)
    clearPluginMarketplaceCache()
    clearStoredCloudConnection()
    await vi.waitFor(() =>
      expect(mocks.invokeHost).toHaveBeenCalledWith('pluginCatalog.clearOpenAi')
    )
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  test('uses the persisted snapshot after restart and renewal', async () => {
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

  test('recovers a fresh file after a transient host read failure', async () => {
    seed(now - 1000)
    mocks.invokeHost.mockRejectedValueOnce(new Error('Disk unavailable'))
    mocks.request.mockRejectedValueOnce(new Error('Network unavailable'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const options = { accountScope: cacheKey, forceRefetch: false, onCached: vi.fn() }
    const api = createLocalCodexPluginApi()

    await expect(api.readRemoteCatalog(options)).rejects.toThrow('Network unavailable')
    await expect(api.readRemoteCatalog(options)).resolves.toMatchObject({
      snapshot: { fetchedAt: now - 1000, items: [catalogItem] },
    })
    expect(mocks.request).toHaveBeenCalledOnce()
  })

  test('only reads the disk when All is opened and skips the identity check for a missing file', async () => {
    const probe = vi.mocked(getLocalCodexAuthStatus)
    probe.mockClear()
    const readCatalog = vi.fn(createLocalCodexPluginApi().readRemoteCatalog)
    const opened = renderHook(
      ({ restoreForAll }) =>
        useOpenAiPluginCatalog({
          cacheKey,
          accountScope: cacheKey,
          deviceId: mocks.deviceId,
          enabled: false,
          restoreForAll,
          readCatalog,
        }),
      { initialProps: { restoreForAll: false } }
    )
    try {
      await act(async () => {})
      expect(mocks.invokeHost).not.toHaveBeenCalled()
      await act(async () => opened.rerender({ restoreForAll: true }))
      expect(mocks.invokeHost).toHaveBeenCalledExactlyOnceWith('pluginCatalog.readOpenAi')
      expect(probe).not.toHaveBeenCalled()
      expect(readCatalog).not.toHaveBeenCalled()
    } finally {
      opened.unmount()
    }
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
    expect(JSON.parse(storedCatalog!)).toMatchObject({
      fetchedAt: now,
      items: [{ id: listing.id, installed: false }],
    })
  })

  test('keeps the previous snapshot on network and incomplete-directory errors, then retries manually', async () => {
    seed(now - 1000)
    const previous = storedCatalog
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
    expect(storedCatalog).toBe(previous)
    await expect(api.readRemoteCatalog(options)).rejects.toThrow('Incomplete remote plugin catalog')
    expect(storedCatalog).toBe(previous)
    await expect(api.readRemoteCatalog(options)).rejects.toThrow('Incomplete remote plugin catalog')
    expect(storedCatalog).toBe(previous)
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

  test.each([false, true])(
    'loads and persists an empty catalog on a cache miss with manual refresh %s',
    async forceRefetch => {
      mocks.request.mockResolvedValueOnce({
        ...liveResponse,
        marketplaces: [{ ...liveResponse.marketplaces[0], plugins: [] }],
      })
      const options = { accountScope: cacheKey, forceRefetch, onCached: vi.fn() }
      const api = createLocalCodexPluginApi()
      await expect(api.readRemoteCatalog(options)).resolves.toMatchObject({
        snapshot: { fetchedAt: now, items: [] },
      })
      expect(JSON.parse(storedCatalog!)).toMatchObject({ fetchedAt: now, items: [] })
      await api.readRemoteCatalog({ ...options, forceRefetch: false })
      expect(mocks.request).toHaveBeenCalledExactlyOnceWith('codex.app_server_request', {
        method: 'plugin/list',
        params: { cwds: null, forceRefetch },
      })
    }
  )

  test('retains the last official directory when a known official marketplace path fails', async () => {
    const officialRoot = '/official'
    seed(now - 31 * 60_000)
    const stored = JSON.parse(storedCatalog!)
    stored.items[0].manifest.marketplacePath = officialRoot
    storedCatalog = JSON.stringify(stored)
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
    expect(JSON.parse(storedCatalog!)).toEqual(stored)
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
    const stored = JSON.parse(storedCatalog!)
    stored.items[0] = { ...stored.items[0], ...fields }
    storedCatalog = JSON.stringify(stored)
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
    const previous = storedCatalog
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
    expect(storedCatalog).toBe(previous)
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

  test('reports a failed disk write and restores the retried catalog after restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wework-official-catalog-'))
    const store = new OpenAiCatalogStore(root)
    const shared = new RendererStorageStore(root)
    try {
      seed(now - 1000)
      const previous = storedCatalog!
      await store.write(previous)
      await shared.initialize({ appearance: 'dark', 'wework.plugins.inventory.v2': 'inventory' })
      const write = vi.spyOn(store, 'write').mockRejectedValueOnce(new Error('Disk unavailable'))
      mocks.invokeHost.mockImplementation(async (method, params) => {
        if (method === 'pluginCatalog.readOpenAi') return store.read()
        expect(method).toBe('pluginCatalog.writeOpenAi')
        await store.write(params.snapshot)
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
        expect(await store.read()).toBe(previous)

        act(() => opened.result.current.refresh())
        await waitFor(() => expect(write).toHaveBeenCalledTimes(2))
        await act(async () => {
          await write.mock.results[1].value
        })
        await waitFor(() => {
          expect(opened.result.current.error).toBeNull()
          expect(opened.result.current.loading).toBe(false)
        })
        expect(mocks.request).toHaveBeenCalledTimes(2)
        expect(write).toHaveBeenCalledTimes(2)
      } finally {
        opened.unmount()
      }

      expect(await shared.read()).toEqual({
        appearance: 'dark',
        'wework.plugins.inventory.v2': 'inventory',
      })
      expect(JSON.parse((await new OpenAiCatalogStore(root).read())!)).toMatchObject({
        fetchedAt: now,
        items: [{ id: listing.id }],
      })
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
    await waitFor(() => expect(getPluginMarketplaceCache(cacheKey)?.marketplaceItems).toEqual([]))
    expect(storedCatalog).not.toBeNull()

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

  test.each(['same identity', 'probe failure', 'different device'])(
    'revalidates the visible catalog when handing off to All (%s)',
    async outcome => {
      const fetchedAt = now - 31 * 60_000
      seed(fetchedAt)
      const refresh = Promise.withResolvers<typeof liveResponse>()
      mocks.request.mockReturnValueOnce(refresh.promise)
      const readCatalog = createLocalCodexPluginApi().readRemoteCatalog
      const deviceId = mocks.deviceId
      const status = await getLocalCodexAuthStatus()
      const probe = Promise.withResolvers<typeof status>()
      const probeStarted = Promise.withResolvers<void>()
      const opened = renderHook(
        ({ enabled }) =>
          useOpenAiPluginCatalog({
            cacheKey,
            accountScope: cacheKey,
            deviceId,
            enabled,
            restoreForAll: !enabled,
            readCatalog,
          }),
        { initialProps: { enabled: true } }
      )
      const expectVisibleCatalog = (timestamp: number) => {
        expect(getPluginMarketplaceCache(cacheKey)).toMatchObject({
          openAiCatalogFetchedAt: timestamp,
          marketplaceItems: [{ id: listing.id }],
        })
        expect(mocks.request).toHaveBeenCalledOnce()
      }
      try {
        await waitFor(() => expectVisibleCatalog(fetchedAt))
        vi.mocked(getLocalCodexAuthStatus).mockImplementationOnce(() => {
          probeStarted.resolve()
          return probe.promise
        })
        if (outcome === 'different device') mocks.deviceId = 'device-b'
        await act(async () => opened.rerender({ enabled: false }))
        await probeStarted.promise
        expectVisibleCatalog(fetchedAt)

        await act(async () => {
          if (outcome === 'probe failure') probe.reject(new Error('auth status unavailable'))
          else probe.resolve(status)
          refresh.resolve(liveResponse)
        })
        if (outcome === 'different device') {
          await waitFor(() =>
            expect(getPluginMarketplaceCache(cacheKey)?.marketplaceItems).toEqual([])
          )
          expect(mocks.request).toHaveBeenCalledOnce()
          expect(JSON.parse(storedCatalog!).fetchedAt).toBe(fetchedAt)
          return
        }
        await waitFor(() => expect(JSON.parse(storedCatalog!).fetchedAt).toBe(now))
        await waitFor(() => expectVisibleCatalog(outcome === 'probe failure' ? fetchedAt : now))
      } finally {
        probe.resolve(status)
        refresh.resolve(liveResponse)
        opened.unmount()
      }
    }
  )

  test('keeps manual refresh pending when the tab changes during the identity probe', async () => {
    seed(now - 1000)
    const readCatalog = createLocalCodexPluginApi().readRemoteCatalog
    const opened = renderHook(
      ({ enabled }) =>
        useOpenAiPluginCatalog({
          cacheKey,
          accountScope: cacheKey,
          deviceId: mocks.deviceId,
          enabled,
          restoreForAll: !enabled,
          readCatalog,
        }),
      { initialProps: { enabled: true } }
    )
    const status = await getLocalCodexAuthStatus()
    const held = Promise.withResolvers<typeof status>()
    const probeStarted = Promise.withResolvers<void>()
    try {
      await waitFor(() => expect(opened.result.current.loading).toBe(false))
      expect(mocks.request).not.toHaveBeenCalled()
      vi.mocked(getLocalCodexAuthStatus).mockImplementationOnce(() => {
        probeStarted.resolve()
        return held.promise
      })
      await act(async () => opened.result.current.refresh())
      await probeStarted.promise
      await act(async () => opened.rerender({ enabled: false }))
      await act(async () => opened.rerender({ enabled: true }))
      await act(async () => held.resolve(status))

      await waitFor(() => {
        expect(opened.result.current.loading).toBe(false)
        expect(mocks.request).toHaveBeenCalledTimes(1)
        expect(JSON.parse(storedCatalog!).fetchedAt).toBe(now)
      })
    } finally {
      held.resolve(status)
      opened.unmount()
    }
  })

  test('does not admit a remote refresh after leaving the tab during the disk read', async () => {
    seed(now - 31 * 60_000)
    const readStarted = Promise.withResolvers<void>()
    const file = Promise.withResolvers<string | null>()
    mocks.invokeHost.mockImplementationOnce(method => {
      expect(method).toBe('pluginCatalog.readOpenAi')
      readStarted.resolve()
      return file.promise
    })
    const readCatalog = createLocalCodexPluginApi().readRemoteCatalog
    const opened = renderHook(
      ({ enabled }) =>
        useOpenAiPluginCatalog({
          cacheKey,
          accountScope: cacheKey,
          deviceId: mocks.deviceId,
          enabled,
          restoreForAll: !enabled,
          readCatalog,
        }),
      { initialProps: { enabled: true } }
    )
    try {
      await readStarted.promise
      await act(async () => opened.rerender({ enabled: false }))
      await act(async () => file.resolve(storedCatalog))
      await waitFor(() =>
        expect(getPluginMarketplaceCache(cacheKey)?.marketplaceItems).toHaveLength(1)
      )
      expect(mocks.request).not.toHaveBeenCalled()
    } finally {
      file.resolve(storedCatalog)
      opened.unmount()
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
    await vi.waitFor(() => expect(storedCatalog).toBeNull())
    complete()
    await rejected
    expect(storedCatalog).toBeNull()
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
      expect(JSON.parse(storedCatalog!)).toMatchObject({
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
      if (state === 'damaged') storedCatalog = '{invalid'
      else mocks.authScope = 'codex-account-b'
      const initial = storedCatalog
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
      expect(storedCatalog).toBe(initial)
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
