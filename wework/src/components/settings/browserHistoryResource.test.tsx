import { StrictMode, useSyncExternalStore } from 'react'
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { EmbeddedBrowserHistoryEntry } from '@/lib/embedded-browser-history'
import { createBrowserHistoryResource } from './browserHistoryResource'
import { historyEntries } from './browserHistory.testFixtures'

const host = vi.hoisted(() => ({ read: vi.fn(), remove: vi.fn(), clear: vi.fn() }))
vi.mock('@/lib/embedded-browser-history', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/embedded-browser-history')>()),
  searchEmbeddedBrowserHistory: host.read,
  removeEmbeddedBrowserHistoryEntries: host.remove,
}))
vi.mock('@/lib/embedded-browser', () => ({ clearEmbeddedBrowserData: host.clear }))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => {
    resolve = done
  })
  return { promise, resolve }
}
function page() {
  const resource = createBrowserHistoryResource()
  return {
    resource,
    ...renderHook(() => useSyncExternalStore(resource.subscribe, resource.getSnapshot)),
  }
}
beforeEach(() => {
  host.read.mockReset().mockResolvedValue(historyEntries())
  host.remove.mockReset().mockResolvedValue(1)
  host.clear.mockReset().mockResolvedValue(1)
})
afterEach(() => vi.useRealTimers())

test('loads only with an active page and cancels a detached dispatch before native I/O', async () => {
  const resource = createBrowserHistoryResource()
  expect(host.read).not.toHaveBeenCalled()
  const { unmount } = renderHook(() =>
    useSyncExternalStore(resource.subscribe, resource.getSnapshot)
  )
  unmount()
  await act(async () => {})
  expect(host.read).not.toHaveBeenCalled()
})

test('does not duplicate initial native reads under StrictMode', async () => {
  const resource = createBrowserHistoryResource()
  const { result } = renderHook(
    () => useSyncExternalStore(resource.subscribe, resource.getSnapshot),
    { wrapper: StrictMode }
  )
  await waitFor(() => expect(result.current.loading).toBe(false))
  expect(host.read).toHaveBeenCalledExactlyOnceWith('')
})

test('serializes pagination and advances its cursor from the completed page', async () => {
  const first = historyEntries(),
    next = historyEntries(100, 'next', first[99].visitTimeMs - 1)
  const pending = deferred<EmbeddedBrowserHistoryEntry[]>()
  host.read.mockResolvedValueOnce(first).mockReturnValueOnce(pending.promise).mockResolvedValue([])
  const { resource, result } = page()
  await waitFor(() => expect(result.current.loading).toBe(false))
  act(() => {
    void resource.loadNextPage()
    void resource.loadNextPage()
  })
  expect(host.read).toHaveBeenCalledTimes(2)
  expect(host.read).toHaveBeenLastCalledWith('', {
    endTimeMs: first[99].visitTimeMs + 1,
    offset: 1,
  })
  await act(async () => pending.resolve(next))
  expect(result.current.entries).toHaveLength(200)
  await act(async () => resource.loadNextPage())
  expect(result.current.cursor).toBeNull()
  expect(result.current.loadingMore).toBe(false)
})

test('debounces the latest search while retaining current rows until the new request starts', async () => {
  const { resource, result } = page()
  await waitFor(() => expect(result.current.loading).toBe(false))
  vi.useFakeTimers()
  act(() => resource.changeSearch('first'))
  await act(async () => vi.advanceTimersByTimeAsync(100))
  act(() => resource.changeSearch('latest'))
  await act(async () => vi.advanceTimersByTimeAsync(199))
  expect(host.read).toHaveBeenCalledTimes(1)
  expect(result.current.entries).toHaveLength(100)
  const pending = deferred<EmbeddedBrowserHistoryEntry[]>()
  host.read.mockReturnValueOnce(pending.promise)
  await act(async () => vi.advanceTimersByTimeAsync(1))
  expect(host.read).toHaveBeenLastCalledWith('latest')
  expect(result.current.loading).toBe(true)
  expect(result.current.entries).toEqual([])
  await act(async () => pending.resolve([]))
})

test('ignores an old pagination response and lets the new query paginate', async () => {
  const old = deferred<EmbeddedBrowserHistoryEntry[]>()
  const current = historyEntries(100, 'current')
  host.read
    .mockResolvedValueOnce(historyEntries())
    .mockReturnValueOnce(old.promise)
    .mockResolvedValueOnce(current)
    .mockResolvedValue([])
  const { resource, result } = page()
  await waitFor(() => expect(result.current.loading).toBe(false))
  act(() => {
    void resource.loadNextPage()
  })
  vi.useFakeTimers()
  act(() => resource.changeSearch('current'))
  await act(async () => vi.advanceTimersByTimeAsync(200))
  expect(result.current.loadingMore).toBe(false)
  expect(result.current.entries).toEqual(current)
  await act(async () => old.resolve(historyEntries(100, 'stale')))
  expect(result.current.entries).toEqual(current)
  await act(async () => resource.loadNextPage())
  expect(host.read).toHaveBeenLastCalledWith('current', result.current.cursor ?? expect.any(Object))
  expect(host.read).toHaveBeenCalledTimes(4)
})

test('ignores a superseded initial read after committing a new search', async () => {
  const old = deferred<EmbeddedBrowserHistoryEntry[]>()
  const fresh = historyEntries(1, 'fresh')
  host.read.mockReturnValueOnce(old.promise).mockResolvedValueOnce(fresh)
  const { resource, result } = page()
  await waitFor(() => expect(host.read).toHaveBeenCalledTimes(1))
  vi.useFakeTimers()
  act(() => resource.changeSearch('fresh'))
  await act(async () => vi.advanceTimersByTimeAsync(200))
  await act(async () => old.resolve(historyEntries(1, 'stale')))
  expect(result.current.query).toBe('fresh')
  expect(result.current.entries).toEqual(fresh)
})

test('keeps valid rows through a failed refresh and recovers via retry', async () => {
  const { resource, result } = page()
  await waitFor(() => expect(result.current.loading).toBe(false))
  const rows = result.current.entries
  host.read.mockRejectedValueOnce(new Error('Read failed'))
  act(() => resource.reload())
  expect(result.current.entries).toBe(rows)
  await waitFor(() => expect(result.current.loadError).toBe(true))
  expect(result.current.entries).toBe(rows)
  host.read.mockResolvedValueOnce([])
  act(() => resource.reload())
  await waitFor(() => expect(result.current.loading).toBe(false))
  expect(result.current.entries).toEqual([])
  expect(result.current.loadError).toBe(false)
})

test('cancels the search debounce when the page closes', async () => {
  const { resource, result, unmount } = page()
  await waitFor(() => expect(result.current.loading).toBe(false))
  vi.useFakeTimers()
  act(() => resource.changeSearch('closed'))
  unmount()
  await act(async () => vi.advanceTimersByTimeAsync(200))
  expect(host.read).toHaveBeenCalledTimes(1)
})

test('refreshes the latest input after a removal instead of the query captured at submission', async () => {
  const pending = deferred<number>()
  host.remove.mockReturnValueOnce(pending.promise)
  const { resource, result } = page()
  await waitFor(() => expect(result.current.loading).toBe(false))
  let removed!: Promise<boolean>
  act(() => {
    removed = resource.remove(['history-0'])
  })
  act(() => resource.changeSearch('latest'))
  host.read.mockResolvedValueOnce(historyEntries(1, 'latest'))
  await act(async () => {
    pending.resolve(1)
    expect(await removed).toBe(true)
  })
  expect(host.read).toHaveBeenCalledTimes(2)
  expect(host.read).toHaveBeenLastCalledWith('latest')
  expect(result.current.entries[0].id).toBe('latest-0')
})

test('clearing invalidates an in-flight old read and does not restore its deleted entries', async () => {
  const old = deferred<EmbeddedBrowserHistoryEntry[]>()
  host.read.mockReturnValueOnce(old.promise).mockResolvedValueOnce([])
  const { resource, result } = page()
  await waitFor(() => expect(host.read).toHaveBeenCalledTimes(1))
  await act(async () => {
    expect(await resource.clear()).toBe(true)
  })
  await act(async () => old.resolve(historyEntries()))
  expect(result.current.entries).toEqual([])
  expect(result.current.cursor).toBeNull()
})

test('finishes an accepted removal after unmount without fetching for another page', async () => {
  const pending = deferred<number>()
  host.remove.mockReturnValueOnce(pending.promise)
  const { resource, result, unmount } = page()
  await waitFor(() => expect(result.current.loading).toBe(false))
  let removed!: Promise<boolean>
  act(() => {
    removed = resource.remove(['history-0'])
  })
  unmount()
  await act(async () => {
    pending.resolve(1)
    expect(await removed).toBe(false)
  })
  expect(host.remove).toHaveBeenCalledExactlyOnceWith(['history-0'])
  expect(host.read).toHaveBeenCalledTimes(1)
})

test('retains data after mutation rejection and serializes accepted mutations', async () => {
  const pending = deferred<number>()
  host.remove.mockReturnValueOnce(pending.promise)
  const { resource, result } = page()
  await waitFor(() => expect(result.current.loading).toBe(false))
  let removed!: Promise<boolean>
  act(() => {
    removed = resource.remove(['history-0'])
    void resource.clear()
  })
  expect(host.clear).not.toHaveBeenCalled()
  await act(async () => {
    pending.resolve(1)
    await removed
  })
  host.clear.mockRejectedValueOnce(new Error('Clear rejected'))
  const rows = result.current.entries
  await act(async () => {
    expect(await resource.clear()).toBe(false)
  })
  expect(result.current.entries).toEqual(rows)
  expect(result.current.actionFailed).toBe(true)
  act(() => resource.clearNotice())
  expect(result.current.actionFailed).toBe(false)
})

test('releases pending pagination when its last subscriber detaches and can resume on reattachment', async () => {
  const resource = createBrowserHistoryResource()
  const first = renderHook(() => useSyncExternalStore(resource.subscribe, resource.getSnapshot))
  await waitFor(() => expect(first.result.current.loading).toBe(false))
  const pending = deferred<EmbeddedBrowserHistoryEntry[]>()
  host.read.mockReturnValueOnce(pending.promise).mockResolvedValueOnce([])
  act(() => {
    void resource.loadNextPage()
  })
  first.unmount()
  const second = renderHook(() => useSyncExternalStore(resource.subscribe, resource.getSnapshot))
  expect(second.result.current.loadingMore).toBe(false)
  await act(async () => pending.resolve(historyEntries(100, 'stale')))
  await act(async () => resource.loadNextPage())
  expect(host.read).toHaveBeenCalledTimes(3)
  expect(second.result.current.cursor).toBeNull()
})
