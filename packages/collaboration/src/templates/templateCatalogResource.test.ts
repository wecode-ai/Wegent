import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createTemplateCatalogResource } from './templateCatalogResource'
import type { CollaborationTemplateRemote, TemplateListing, TemplateSummary } from './types'

function backend() {
  return {
    discover: vi.fn(async () => ({
      items: [] as TemplateListing[],
      hasMore: false,
      nextCursor: null as string | null,
    })),
    list: vi.fn(async () => [] as TemplateSummary[]),
    get: vi.fn(),
    save: vi.fn(),
    delete: vi.fn(),
    install: vi.fn(),
    publish: vi.fn(),
  } satisfies CollaborationTemplateRemote
}
const listing = (id: number) => ({ id, name: `template-${id}` }) as TemplateListing
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => {
    resolve = done
  })
  return { promise, resolve }
}
beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

it('does not fetch until a search remains subscribed through its debounce period', async () => {
  const remote = backend()
  const abandoned = createTemplateCatalogResource(remote, 'first')
  const stop = abandoned.subscribe(vi.fn())
  await vi.advanceTimersByTimeAsync(199)
  stop()
  const current = createTemplateCatalogResource(remote, 'second')
  const stopCurrent = current.subscribe(vi.fn())
  await vi.advanceTimersByTimeAsync(200)
  expect(remote.discover).toHaveBeenCalledExactlyOnceWith({ keyword: 'second' })
  expect(remote.list).toHaveBeenCalledOnce()
  expect(current.getSnapshot().loading).toBe(false)
  stopCurrent()
})

it('keeps account metadata available when discovery fails and refreshes immediately', async () => {
  const remote = backend()
  const summary = { id: 7, name: 'saved', ownerId: 7, namespace: 'default' } as TemplateSummary
  remote.discover.mockRejectedValueOnce(new Error('offline'))
  remote.list.mockResolvedValue([summary])
  const resource = createTemplateCatalogResource(remote, '')
  const stop = resource.subscribe(vi.fn())
  await vi.advanceTimersByTimeAsync(200)
  expect(resource.getSnapshot()).toMatchObject({ mine: [summary], loading: false, error: true })
  await resource.refresh()
  expect(remote.discover).toHaveBeenCalledTimes(2)
  expect(resource.getSnapshot()).toMatchObject({ mine: [summary], loading: false, error: false })
  stop()
})

it('appends pages and does not let a pending page restore a removed template', async () => {
  const remote = backend()
  remote.discover
    .mockResolvedValueOnce({ items: [listing(1)], hasMore: true, nextCursor: 'page-2' })
    .mockResolvedValueOnce({ items: [listing(2)], hasMore: true, nextCursor: 'page-3' })
  const resource = createTemplateCatalogResource(remote, 'query')
  const stop = resource.subscribe(vi.fn())
  await vi.advanceTimersByTimeAsync(200)
  await resource.loadMore()
  expect(remote.discover).toHaveBeenLastCalledWith({ keyword: 'query', cursor: 'page-2' })
  expect(resource.getSnapshot().listings.map(item => item.id)).toEqual([1, 2])
  const pending = deferred<Awaited<ReturnType<CollaborationTemplateRemote['discover']>>>()
  remote.discover.mockReturnValueOnce(pending.promise)
  const page = resource.loadMore()
  resource.remove(1, '7:default:template-1')
  pending.resolve({ items: [listing(1)], hasMore: false, nextCursor: null })
  await page
  expect(resource.getSnapshot().listings.map(item => item.id)).toEqual([2])
  expect(resource.getSnapshot().loading).toBe(false)
  stop()
})

it('invalidates a pending first page when an authoritative deletion updates the catalog', async () => {
  const remote = backend()
  const pending = deferred<Awaited<ReturnType<CollaborationTemplateRemote['discover']>>>()
  remote.discover.mockReturnValueOnce(pending.promise)
  const resource = createTemplateCatalogResource(remote, '')
  const stop = resource.subscribe(vi.fn())
  await vi.advanceTimersByTimeAsync(200)
  resource.remove(1, '7:default:template-1')
  pending.resolve({ items: [listing(1)], hasMore: false, nextCursor: null })
  await vi.advanceTimersByTimeAsync(0)
  expect(resource.getSnapshot().listings).toEqual([])
  stop()
})

it('reloads a cached catalog when a new subscriber attaches', async () => {
  const remote = backend()
  const resource = createTemplateCatalogResource(remote, '')
  const stop = resource.subscribe(vi.fn())
  await vi.advanceTimersByTimeAsync(200)
  stop()
  const next = resource.subscribe(vi.fn())
  await vi.advanceTimersByTimeAsync(200)
  expect(remote.discover).toHaveBeenCalledTimes(2)
  expect(resource.getSnapshot().loading).toBe(false)
  next()
})
