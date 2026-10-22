import { describe, expect, it, vi } from 'vitest'
import { createRequestCache } from './request-cache'
import { createModelApi } from './model-api'
import type { UnifiedModel } from './models'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => {
    resolve = done
  })
  return { promise, resolve }
}

describe('session request cache', () => {
  it('deduplicates concurrent reads and caches empty results', async () => {
    const cache = createRequestCache()
    const load = vi.fn(async () => [])
    await Promise.all([cache.get('list', load), cache.get('list', load)])
    await cache.get('list', load)
    expect(load).toHaveBeenCalledOnce()
  })

  it('expires successful reads and retries failed reads', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(100)
    try {
      const cache = createRequestCache()
      const load = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue([])
      await expect(cache.get('list', load, 10)).rejects.toThrow('offline')
      await cache.get('list', load, 10)
      clock.mockReturnValue(111)
      await cache.get('list', load, 10)
      expect(load).toHaveBeenCalledTimes(3)
    } finally {
      clock.mockRestore()
    }
  })

  it.each(['invalidate', 'account switch'])(
    'prevents an old response from restoring data after %s',
    async mode => {
      let scope = 1
      const cache = createRequestCache(() => scope)
      const old = deferred<string[]>()
      const request = cache.get('list', () => old.promise)
      if (mode === 'invalidate') cache.invalidate('list')
      else scope = 2
      await cache.get('list', async () => ['new'])
      old.resolve(['old'])
      await request
      expect(await cache.get('list', async () => ['unexpected'])).toEqual(['new'])
    }
  )
})

describe('shared cloud model requests', () => {
  it('evicts a timed-out shared transport so refresh starts a new request and ignores late results', async () => {
    vi.useFakeTimers()
    try {
      const old = deferred<{ data: UnifiedModel[] }>()
      const client = {
        get: vi.fn().mockReturnValueOnce(old.promise).mockResolvedValue({ data: [] }),
      }
      const first = createModelApi(client)
      const second = createModelApi(client)
      const cancelled = new AbortController()
      const subscriber = first.listModels({ signal: cancelled.signal })
      const cancelledResult = expect(subscriber).rejects.toMatchObject({
        name: 'AbortError',
      })
      const waiting = second.listModels()
      const timeout = expect(waiting).rejects.toMatchObject({
        name: 'TimeoutError',
      })
      await vi.advanceTimersByTimeAsync(0)
      const transportSignal = client.get.mock.calls[0][1].signal as AbortSignal
      cancelled.abort()
      await cancelledResult
      expect(transportSignal.aborted).toBe(false)
      await vi.advanceTimersByTimeAsync(10_000)
      await timeout
      expect(transportSignal.aborted).toBe(true)
      await expect(second.listModels({ forceRefresh: true })).resolves.toEqual({
        data: [],
      })
      expect(client.get).toHaveBeenCalledTimes(2)
      old.resolve({ data: [{ name: 'stale-model', type: 'public' }] })
      await vi.advanceTimersByTimeAsync(0)
      await expect(second.listModels()).resolves.toEqual({ data: [] })
      expect(client.get).toHaveBeenCalledTimes(2)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('evicts failed transports and releases their deadline before retrying', async () => {
    vi.useFakeTimers()
    try {
      const client = {
        get: vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ data: [] }),
      }
      const api = createModelApi(client)
      await expect(api.listModels()).rejects.toThrow('offline')
      expect(vi.getTimerCount()).toBe(0)
      await expect(api.listModels({ forceRefresh: true })).resolves.toEqual({
        data: [],
      })
      expect(client.get).toHaveBeenCalledTimes(2)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('shares adapters without letting one subscriber cancel another', async () => {
    const pending = deferred<{ data: [] }>()
    const client = { get: vi.fn(() => pending.promise) }
    const first = createModelApi(client)
    const second = createModelApi(client)
    const controller = new AbortController()
    const cancelled = first.listModels({ signal: controller.signal })
    const cancellation = expect(cancelled).rejects.toMatchObject({
      name: 'AbortError',
    })
    const waiting = second.listModels()
    controller.abort()
    pending.resolve({ data: [] })
    await cancellation
    await expect(waiting).resolves.toEqual({ data: [] })
    await second.listModels()
    expect(client.get).toHaveBeenCalledOnce()
    await first.listModels({ signal: new AbortController().signal })
    expect(client.get).toHaveBeenCalledOnce()
    await first.listModels({
      signal: new AbortController().signal,
      forceRefresh: true,
    })
    expect(client.get).toHaveBeenCalledTimes(2)
  })
})
