import { describe, expect, test, vi } from 'vitest'
import { createSharedCodexAppCatalog } from './codexAppCatalog'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => {
    resolve = done
  })
  return { promise, resolve }
}

const app = { id: 'linked', name: 'Linked', isAccessible: true }
const page = { data: [app], nextCursor: null }

describe('shared Codex application pagination', () => {
  test('eleven concurrent readers share one 51-page traversal', async () => {
    const request = vi.fn(async (_method, params) => {
      const index = params.cursor === null ? 0 : Number(params.cursor)
      return {
        data: [{ ...app, id: String(index) }],
        nextCursor: index < 50 ? String(index + 1) : null,
      }
    })
    const catalog = createSharedCodexAppCatalog(request)
    const results = await Promise.all(
      Array.from({ length: 11 }, () => catalog.read('account/device'))
    )
    expect(request).toHaveBeenCalledTimes(51)
    expect(results.every(apps => apps.length === 51)).toBe(true)
    expect(request.mock.calls.filter(([, params]) => params.cursor === null)).toHaveLength(1)
  })

  test('shares transport while applying accessibility per caller', async () => {
    const request = vi.fn().mockResolvedValue({
      data: [app, { id: 'unlinked', name: 'Unlinked', isAccessible: false }],
      nextCursor: null,
    })
    const catalog = createSharedCodexAppCatalog(request)
    const [available, all] = await Promise.all([
      catalog.read('one'),
      catalog.read('one', { includeInaccessible: true }),
    ])
    expect(available.map(item => item.id)).toEqual(['linked'])
    expect(all.map(item => item.id)).toEqual(['linked', 'unlinked'])
    expect(request).toHaveBeenCalledOnce()
  })

  test('one consumer cancelling does not interrupt another consumer', async () => {
    const first = deferred<unknown>()
    const request = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(page)
    const catalog = createSharedCodexAppCatalog(request)
    const controller = new AbortController()
    const cancelled = catalog.read('one', { signal: controller.signal })
    const rejected = expect(cancelled).rejects.toMatchObject({ name: 'AbortError' })
    const survivor = catalog.read('one')
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce())
    controller.abort()
    first.resolve({ data: [], nextCursor: 'next' })
    await rejected
    await expect(survivor).resolves.toEqual([expect.objectContaining(app)])
    expect(request).toHaveBeenCalledTimes(2)
  })

  test('last consumer cancellation rejects immediately and prevents old pagination', async () => {
    const first = deferred<unknown>()
    const request = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(page)
    const catalog = createSharedCodexAppCatalog(request)
    const controller = new AbortController()
    const rejected = expect(
      catalog.read('one', { signal: controller.signal })
    ).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce())
    controller.abort()
    await rejected
    // A new reader must not join the abandoned page, even before it settles.
    await expect(catalog.read('one')).resolves.toEqual([expect.objectContaining(app)])
    first.resolve({ data: [], nextCursor: 'obsolete' })
    await Promise.resolve()
    expect(request).toHaveBeenCalledTimes(2)
    expect(request.mock.calls.some(([, params]) => params.cursor === 'obsolete')).toBe(false)
  })

  test.each(['device-b', 'account-b'])(
    'scope change to %s cancels the old traversal',
    async scope => {
      const old = deferred<unknown>()
      const request = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValue(page)
      const catalog = createSharedCodexAppCatalog(request)
      const rejected = expect(catalog.read('device-a/account-a')).rejects.toMatchObject({
        name: 'AbortError',
      })
      await vi.waitFor(() => expect(request).toHaveBeenCalledOnce())
      await expect(catalog.read(scope)).resolves.toEqual([expect.objectContaining(app)])
      await rejected
      old.resolve({ data: [], nextCursor: 'old-account' })
      await Promise.resolve()
      expect(request).toHaveBeenCalledTimes(2)
    }
  )

  test('forced refresh replaces an old read and concurrent forced readers coalesce', async () => {
    const old = deferred<unknown>()
    const request = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValue(page)
    const catalog = createSharedCodexAppCatalog(request)
    const rejected = expect(catalog.read('one')).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce())
    await Promise.all([
      catalog.read('one', { forceRefetch: true }),
      catalog.read('one', { forceRefetch: true }),
    ])
    await rejected
    old.resolve({ data: [], nextCursor: 'obsolete' })
    await Promise.resolve()
    expect(request).toHaveBeenCalledTimes(2)
    expect(request).toHaveBeenLastCalledWith('app/list', {
      cursor: null,
      limit: 100,
      forceRefetch: true,
    })
  })

  test('invalidation stops old pages and failures are not retained or retried', async () => {
    const old = deferred<unknown>()
    const request = vi
      .fn()
      .mockReturnValueOnce(old.promise)
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(page)
    const catalog = createSharedCodexAppCatalog(request)
    const rejected = expect(catalog.read('one')).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce())
    catalog.invalidate()
    await rejected
    old.resolve({ data: [], nextCursor: 'obsolete' })
    await expect(catalog.read('one')).rejects.toThrow('offline')
    await expect(catalog.read('one')).resolves.toEqual([expect.objectContaining(app)])
    expect(request).toHaveBeenCalledTimes(3)
  })

  test('an already aborted caller starts no request', () => {
    const request = vi.fn()
    const catalog = createSharedCodexAppCatalog(request)
    expect(() => catalog.read('one', { signal: AbortSignal.abort() })).toThrow()
    expect(request).not.toHaveBeenCalled()
  })
})
