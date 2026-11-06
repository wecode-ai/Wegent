import type { PluginMarketplaceItem } from '@/types/api'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  clearPluginMarketplaceCache,
  getPluginMarketplaceCache,
  setPluginMarketplaceCache,
} from './pluginMarketplaceCache'
import { remoteCatalogErrorKind } from './remotePluginError'
import { useOpenAiPluginCatalog } from './useOpenAiPluginCatalog'

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
  test('loads only an active tab and delegates freshness to the account-scoped API cache', async () => {
    seed([], Date.now())
    const readCatalog = vi.fn().mockResolvedValue({ items: [], deviceId: 'device' })
    const { result, rerender } = renderHook(
      ({ enabled }) => useOpenAiPluginCatalog({ cacheKey: 'account', enabled, readCatalog }),
      { initialProps: { enabled: false } }
    )
    await act(async () => {})
    expect(readCatalog).not.toHaveBeenCalled()
    act(() => result.current.refresh())
    await act(async () => {})
    expect(readCatalog).not.toHaveBeenCalled()
    rerender({ enabled: true })
    await waitFor(() => expect(readCatalog).toHaveBeenCalledOnce())
    expect(readCatalog).toHaveBeenLastCalledWith({ forceRefetch: false, accountScope: 'account' })
    act(() => result.current.refresh())
    await waitFor(() => expect(readCatalog).toHaveBeenCalledTimes(2))
    expect(readCatalog).toHaveBeenLastCalledWith({ forceRefetch: true, accountScope: 'account' })
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(getPluginMarketplaceCache('account')?.marketplaceItems).toEqual([])
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
    expect(readCatalog).toHaveBeenLastCalledWith({ forceRefetch: false, accountScope: 'account' })
    expect(result.current.loading).toBe(false)
    expect(getPluginMarketplaceCache('account')?.marketplaceItems).toEqual([remoteItem])
    act(() => result.current.refresh())
    await waitFor(() => expect(readCatalog).toHaveBeenCalledTimes(2))
    expect(readCatalog).toHaveBeenLastCalledWith({ forceRefetch: true, accountScope: 'account' })
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
      ({ cacheKey, enabled }) => useOpenAiPluginCatalog({ cacheKey, enabled, readCatalog }),
      { initialProps: { cacheKey: 'account', enabled: true } }
    )
    await waitFor(() => expect(readCatalog).toHaveBeenCalledOnce())
    rerender({ cacheKey: 'other-account', enabled: false })
    act(() => result.current.refresh())
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
