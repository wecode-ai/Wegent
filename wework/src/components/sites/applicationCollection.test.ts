import { ApiError } from '@/api/http'
import { createUnavailableSitesApi, type Site, type SiteListResponse } from '@/api/sites'
import { afterEach, expect, test, vi } from 'vitest'
import { createApplicationCollection } from './applicationCollection'

const first = { app_type: 'web', siteid: 'first', name: 'First' } as Site
const second = { ...first, siteid: 'second', name: 'Second' }
function page(items = [first], total = 2): SiteListResponse {
  return { items, total, offset: 0, limit: 1 }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(accept => {
    resolve = accept
  })
  return { promise, resolve }
}
function source() {
  const listSites = vi.fn().mockResolvedValue(page())
  const api = { ...createUnavailableSitesApi(), listSites }
  return { listSites, api, store: createApplicationCollection(api, 'web', 1, true) }
}
async function settle() {
  await Promise.resolve()
  await Promise.resolve()
}
afterEach(() => vi.useRealTimers())

test('only reads for the observed enabled collection and permits explicit retry', async () => {
  const f = source()
  const failure = new Error('Offline')
  f.listSites.mockRejectedValueOnce(failure)
  expect(f.listSites).not.toHaveBeenCalled()
  const stop = f.store.subscribe(vi.fn())
  await settle()
  expect(f.store.getSnapshot()).toMatchObject({
    loading: false,
    failure: { cause: failure },
    items: [],
  })
  expect(f.listSites).toHaveBeenCalledTimes(1)
  await f.store.loadFirstPage()
  expect(f.store.getSnapshot()).toMatchObject({ items: [first], failure: null })
  stop()
  const disabled = createApplicationCollection(f.api, 'web', 1, false)
  const stopDisabled = disabled.subscribe(vi.fn())
  disabled.changeSearch('query')
  await disabled.loadFirstPage()
  await disabled.loadMore()
  expect(f.listSites).toHaveBeenCalledTimes(2)
  expect(disabled.getSnapshot().loading).toBe(false)
  stopDisabled()
})

test('debounces the trimmed final query while keeping the previous list visible', async () => {
  vi.useFakeTimers()
  const f = source()
  const stop = f.store.subscribe(vi.fn())
  await settle()
  f.store.changeSearch(' out')
  vi.advanceTimersByTime(100)
  f.store.changeSearch(' output ')
  vi.advanceTimersByTime(179)
  expect(f.listSites).toHaveBeenCalledTimes(1)
  expect(f.store.getSnapshot().items).toEqual([first])
  await vi.advanceTimersByTimeAsync(1)
  expect(f.listSites).toHaveBeenLastCalledWith({ appType: 'web', q: 'output', offset: 0, limit: 1 })
  expect(f.store.getSnapshot()).toMatchObject({ searchInput: ' output ', query: 'output' })
  f.store.changeSearch('output')
  await vi.advanceTimersByTimeAsync(180)
  expect(f.listSites).toHaveBeenCalledTimes(2)
  stop()
  expect(vi.getTimerCount()).toBe(0)
})

test('ignores old first-page responses after a committed query change', async () => {
  vi.useFakeTimers()
  const f = source(),
    old = deferred<SiteListResponse>()
  f.listSites.mockReturnValueOnce(old.promise).mockResolvedValueOnce(page([second], 1))
  const stop = f.store.subscribe(vi.fn())
  f.store.changeSearch('second')
  await vi.advanceTimersByTimeAsync(180)
  old.resolve(page())
  await settle()
  expect(f.store.getSnapshot()).toMatchObject({ items: [second], total: 1, query: 'second' })
  stop()
})

test('serializes pagination and ignores an old page after search changes', async () => {
  vi.useFakeTimers()
  const f = source(),
    old = deferred<SiteListResponse>()
  const stop = f.store.subscribe(vi.fn())
  await settle()
  f.listSites.mockReturnValueOnce(old.promise).mockResolvedValueOnce(page([second], 1))
  const request = f.store.loadMore()
  await f.store.loadMore()
  expect(f.listSites).toHaveBeenCalledTimes(2)
  f.store.changeSearch('second')
  await vi.advanceTimersByTimeAsync(180)
  old.resolve(page([first], 2))
  await request
  expect(f.store.getSnapshot()).toMatchObject({ items: [second], total: 1, loadingMore: false })
  stop()
})

test('a refresh supersedes an in-flight page and preserves authoritative totals', async () => {
  const f = source(),
    old = deferred<SiteListResponse>()
  const stop = f.store.subscribe(vi.fn())
  await settle()
  f.listSites.mockReturnValueOnce(old.promise).mockResolvedValueOnce(page([second], 1))
  const request = f.store.loadMore()
  await f.store.loadFirstPage()
  old.resolve(page([first], 100))
  await request
  expect(f.store.getSnapshot()).toMatchObject({ items: [second], total: 1, loadingMore: false })
  stop()
})

test('appends successful pages and exposes pagination failures without losing loaded items', async () => {
  const f = source()
  const stop = f.store.subscribe(vi.fn())
  await settle()
  f.listSites.mockRejectedValueOnce(new Error('Page offline'))
  await f.store.loadMore()
  expect(f.store.getSnapshot()).toMatchObject({
    items: [first],
    loadingMore: false,
    failure: { cause: expect.any(Error) },
  })
  f.listSites.mockResolvedValueOnce(page([second], 2))
  await f.store.loadMore()
  expect(f.listSites).toHaveBeenLastCalledWith({ appType: 'web', q: '', offset: 1, limit: 1 })
  expect(f.store.getSnapshot()).toMatchObject({
    items: [first, second],
    total: 2,
    failure: null,
    loadingMore: false,
  })
  stop()
})

test('backend unavailability stays distinct from a generic read failure', async () => {
  const f = source()
  f.listSites.mockRejectedValueOnce(new ApiError('Unavailable', 503, 'sites_not_available'))
  const stop = f.store.subscribe(vi.fn())
  await settle()
  expect(f.store.getSnapshot()).toMatchObject({ unavailable: true, failure: null, loading: false })
  await f.store.loadFirstPage()
  expect(f.store.getSnapshot().unavailable).toBe(false)
  stop()
})

test('accepted mutations survive late pagination and detached owners cannot write', async () => {
  const f = source(),
    old = deferred<SiteListResponse>()
  const stop = f.store.subscribe(vi.fn())
  await settle()
  f.listSites.mockReturnValueOnce(old.promise)
  const request = f.store.loadMore()
  f.store.setItems(items => items.map(item => ({ ...item, name: 'Renamed' })))
  old.resolve(page([second], 2))
  await request
  expect(f.store.getSnapshot()).toMatchObject({
    items: [{ ...first, name: 'Renamed' }],
    loadingMore: false,
  })
  stop()
  f.store.setItems(() => [])
  expect(f.store.getSnapshot().items).toHaveLength(1)
})

test('teardown cancels pending debounce and invalidates reads across re-subscription', async () => {
  vi.useFakeTimers()
  const f = source(),
    old = deferred<SiteListResponse>()
  f.listSites.mockReturnValueOnce(old.promise).mockResolvedValueOnce(page([second], 1))
  const stop = f.store.subscribe(vi.fn())
  f.store.changeSearch('later')
  stop()
  expect(vi.getTimerCount()).toBe(0)
  const stopAgain = f.store.subscribe(vi.fn())
  await settle()
  old.resolve(page())
  await settle()
  expect(f.store.getSnapshot().items).toEqual([second])
  stopAgain()
  expect(vi.getTimerCount()).toBe(0)
})

test('a late deletion from the previous search cannot decrement another result set', async () => {
  vi.useFakeTimers()
  const f = source()
  const stop = f.store.subscribe(vi.fn())
  await settle()
  f.listSites.mockResolvedValueOnce(page([second], 1))
  f.store.changeSearch('second')
  await vi.advanceTimersByTimeAsync(180)
  f.store.removeSite(first.siteid)
  expect(f.store.getSnapshot()).toMatchObject({ items: [second], total: 1 })
  f.store.removeSite(second.siteid)
  expect(f.store.getSnapshot()).toMatchObject({ items: [], total: 0 })
  stop()
})

test('reselecting the current type clears search immediately and cancels its pending timer', async () => {
  vi.useFakeTimers()
  const f = source()
  const stop = f.store.subscribe(vi.fn())
  await settle()
  f.store.changeSearch('second')
  await vi.advanceTimersByTimeAsync(180)
  f.store.changeSearch('third')
  f.store.resetSearch()
  await settle()
  expect(f.store.getSnapshot()).toMatchObject({ searchInput: '', query: '' })
  expect(f.listSites).toHaveBeenLastCalledWith({ appType: 'web', q: '', offset: 0, limit: 1 })
  expect(vi.getTimerCount()).toBe(0)
  stop()
})
