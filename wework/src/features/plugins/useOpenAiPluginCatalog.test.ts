import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { InstalledPlugin, PluginMarketplaceItem } from '@/types/api'
import {
  clearPluginMarketplaceCache,
  getPluginMarketplaceCache,
  setPluginMarketplaceCache,
} from './pluginMarketplaceCache'
import { useOpenAiPluginCatalog } from './useOpenAiPluginCatalog'
import { remoteCatalogErrorKind } from './remotePluginError'

const remoteItem = {
  id: 'github@openai-curated-remote',
  remotePluginId: 'github',
  name: 'github',
  displayName: 'GitHub',
  sourceProvider: 'codex',
  manifest: { marketplaceId: 'openai-curated-remote' },
  installed: false,
  enabled: false,
  components: {
    skills: [],
    commands: [],
    agents: [],
    hooks: [],
    mcps: [],
    lsps: [],
    monitors: [],
    bins: [],
    connectors: [],
  },
} as PluginMarketplaceItem

const installation = {
  metadata: { name: 'github', namespace: 'openai-curated-remote', labels: { id: remoteItem.id } },
  spec: {
    source: {
      providerKey: 'openai-curated-remote',
      pluginKey: 'github',
      marketplace: 'openai-curated-remote',
    },
    enabled: true,
    installState: 'installed',
    components: remoteItem.components,
  },
} as InstalledPlugin

function seed(items: PluginMarketplaceItem[] = [remoteItem], fetchedAt?: number) {
  setPluginMarketplaceCache(
    {
      cacheKey: 'account',
      deviceId: 'device',
      marketplaceItems: items,
      installedPlugins: [],
      marketplaces: [],
      selectedMarketplaceKey: '',
      fetchedAt: Date.now(),
      openAiCatalogFetchedAt: fetchedAt,
    },
    { remoteCatalog: true }
  )
}

function deferred() {
  let resolve!: (value: { items: PluginMarketplaceItem[]; deviceId: string }) => void
  const promise = new Promise<{ items: PluginMarketplaceItem[]; deviceId: string }>(done => {
    resolve = done
  })
  return { promise, resolve }
}

afterEach(() => {
  cleanup()
  clearPluginMarketplaceCache()
  vi.useRealTimers()
})

describe('on-demand OpenAI catalog', () => {
  test('does not request before the tab opens and treats a fresh empty catalog as loaded', async () => {
    seed([], Date.now())
    const readCatalog = vi.fn().mockResolvedValue({ items: [remoteItem], deviceId: 'device' })
    const { result, rerender } = renderHook(
      ({ enabled }) => useOpenAiPluginCatalog({ cacheKey: 'account', enabled, readCatalog }),
      { initialProps: { enabled: false } }
    )
    await act(async () => {})
    expect(readCatalog).not.toHaveBeenCalled()
    rerender({ enabled: true })
    await act(async () => {})
    expect(readCatalog).not.toHaveBeenCalled()
    act(() => result.current.refresh())
    await waitFor(() => expect(readCatalog).toHaveBeenCalledTimes(1))
    expect(readCatalog).toHaveBeenLastCalledWith({ forceRefetch: true })
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(getPluginMarketplaceCache('account')?.marketplaceItems).toHaveLength(1)
  })

  test('403 retains cached rows, settles loading, sanitizes the error and permits retry', async () => {
    seed([remoteItem], Date.now() - 61_000)
    const readCatalog = vi
      .fn()
      .mockRejectedValueOnce(new Error('403 Cloudflare <html>secret challenge</html>'))
      .mockResolvedValueOnce({ items: [], deviceId: 'device' })
    const { result } = renderHook(() =>
      useOpenAiPluginCatalog({ cacheKey: 'account', enabled: true, readCatalog })
    )
    await waitFor(() => expect(result.current.error).toBe('blocked'))
    expect(readCatalog).toHaveBeenLastCalledWith({ forceRefetch: false })
    expect(result.current.loading).toBe(false)
    expect(getPluginMarketplaceCache('account')?.marketplaceItems).toEqual([remoteItem])
    act(() => result.current.refresh())
    await waitFor(() => expect(readCatalog).toHaveBeenCalledTimes(2))
    expect(readCatalog).toHaveBeenLastCalledWith({ forceRefetch: true })
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.error).toBeNull()
    expect(getPluginMarketplaceCache('account')?.marketplaceItems).toEqual([])
  })

  test('times out without publishing the late RPC response', async () => {
    vi.useFakeTimers()
    seed()
    const pending = deferred()
    const readCatalog = vi.fn(() => pending.promise)
    const { result } = renderHook(() =>
      useOpenAiPluginCatalog({ cacheKey: 'account', enabled: true, readCatalog })
    )
    await act(async () => {})
    expect(result.current.loading).toBe(true)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000)
    })
    expect(result.current.error).toBe('timeout')
    expect(result.current.loading).toBe(false)
    await act(async () => {
      pending.resolve({ items: [], deviceId: 'device' })
    })
    expect(getPluginMarketplaceCache('account')?.marketplaceItems).toEqual([remoteItem])
  })

  test('projects current installation membership and preserves the installed freshness stamp', async () => {
    seed([])
    const pending = deferred()
    const readCatalog = vi.fn(() => pending.promise)
    const { result } = renderHook(() =>
      useOpenAiPluginCatalog({ cacheKey: 'account', enabled: true, readCatalog })
    )
    await waitFor(() => expect(readCatalog).toHaveBeenCalledOnce())
    setPluginMarketplaceCache(
      {
        ...getPluginMarketplaceCache('account')!,
        installedPlugins: [installation],
        installedPluginsFetchedAt: 123,
      },
      { mutation: true }
    )
    await act(async () => {
      pending.resolve({ items: [remoteItem], deviceId: 'device' })
    })
    expect(result.current.loading).toBe(false)
    const snapshot = getPluginMarketplaceCache('account')!
    expect(snapshot.installedPlugins).toEqual([installation])
    expect(snapshot.installedPluginsFetchedAt).toBe(123)
    expect(snapshot.marketplaceItems[0].installed).toBe(true)
    expect(snapshot.mutationRevision).toBe(1)
  })

  test('late local catalog writes cannot erase remote metadata or revive an authoritative empty catalog', () => {
    seed([remoteItem], Date.now())
    const previous = getPluginMarketplaceCache('account')!
    setPluginMarketplaceCache({
      ...previous,
      marketplaceItems: [],
      installedPlugins: [installation],
    })
    expect(getPluginMarketplaceCache('account')?.marketplaceItems[0]).toMatchObject({
      name: 'github',
      installed: true,
    })
    seed([], Date.now())
    setPluginMarketplaceCache(previous)
    expect(getPluginMarketplaceCache('account')?.marketplaceItems).toEqual([])
  })

  test('uninstall during a request cannot be undone by remote installation flags', async () => {
    seed()
    const pending = deferred()
    const readCatalog = vi.fn(() => pending.promise)
    renderHook(() => useOpenAiPluginCatalog({ cacheKey: 'account', enabled: true, readCatalog }))
    await waitFor(() => expect(readCatalog).toHaveBeenCalledOnce())
    setPluginMarketplaceCache(
      { ...getPluginMarketplaceCache('account')!, installedPlugins: [] },
      { mutation: true }
    )
    await act(async () => {
      pending.resolve({
        items: [{ ...remoteItem, installed: true, enabled: true }],
        deviceId: 'device',
      })
    })
    expect(getPluginMarketplaceCache('account')?.marketplaceItems[0].installed).toBe(false)
  })

  test('ignores responses after unmount or a device switch', async () => {
    seed()
    const pending = deferred()
    const readCatalog = vi.fn(() => pending.promise)
    const { unmount } = renderHook(() =>
      useOpenAiPluginCatalog({ cacheKey: 'account', enabled: true, readCatalog })
    )
    await waitFor(() => expect(readCatalog).toHaveBeenCalledOnce())
    unmount()
    await act(async () => {
      pending.resolve({ items: [], deviceId: 'device' })
    })
    expect(getPluginMarketplaceCache('account')?.marketplaceItems).toEqual([remoteItem])
    const otherDevice = vi.fn().mockResolvedValue({ items: [], deviceId: 'other-device' })
    const { result } = renderHook(() =>
      useOpenAiPluginCatalog({ cacheKey: 'account', enabled: true, readCatalog: otherDevice })
    )
    await waitFor(() => expect(otherDevice).toHaveBeenCalledOnce())
    expect(result.current.loading).toBe(false)
    expect(getPluginMarketplaceCache('account')?.marketplaceItems).toEqual([remoteItem])
  })

  test('account changes cancel old responses and do not carry manual refresh intent across accounts', async () => {
    seed()
    const pending = deferred()
    const readCatalog = vi.fn(() => pending.promise)
    const { result, rerender } = renderHook(
      ({ cacheKey }) => useOpenAiPluginCatalog({ cacheKey, enabled: false, readCatalog }),
      { initialProps: { cacheKey: 'account' } }
    )
    act(() => result.current.refresh())
    await waitFor(() => expect(readCatalog).toHaveBeenCalledOnce())
    rerender({ cacheKey: 'other-account' })
    await act(async () => {
      pending.resolve({ items: [], deviceId: 'device' })
    })
    expect(readCatalog).toHaveBeenCalledOnce()
    expect(result.current.loading).toBe(false)
    expect(getPluginMarketplaceCache('account')?.marketplaceItems).toEqual([remoteItem])
    expect(getPluginMarketplaceCache('other-account')).toBeNull()
  })

  test('an older concurrent consumer cannot overwrite a completed remote refresh', async () => {
    seed()
    const pending = deferred()
    const olderRead = vi.fn(() => pending.promise)
    renderHook(() =>
      useOpenAiPluginCatalog({ cacheKey: 'account', enabled: true, readCatalog: olderRead })
    )
    await waitFor(() => expect(olderRead).toHaveBeenCalledOnce())
    seed([], Date.now())
    await act(async () => {
      pending.resolve({ items: [remoteItem], deviceId: 'device' })
    })
    expect(getPluginMarketplaceCache('account')?.marketplaceItems).toEqual([])
  })

  test.each([
    [new Error('401 Unauthorized'), 'auth'],
    [new Error('network failed'), 'failed'],
  ])('classifies %s without displaying server payloads', (error, expected) => {
    expect(remoteCatalogErrorKind(error)).toBe(expected)
  })
})
