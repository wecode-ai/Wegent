// @vitest-environment node
import { afterEach, expect, test, vi } from 'vitest'
import { createPluginDetailCache } from './codexPluginDetails'

afterEach(() => vi.useRealTimers())

function deferred() {
  let resolve!: (value: string) => void
  const promise = new Promise<string>(done => {
    resolve = done
  })
  return { promise, resolve }
}

test('shares pending reads and caches successful details for one minute', async () => {
  vi.useFakeTimers()
  const cache = createPluginDetailCache<string>()
  const held = deferred()
  const load = vi.fn().mockReturnValueOnce(held.promise).mockResolvedValue('updated')
  const readers = Array.from({ length: 11 }, () =>
    cache.read('device/account', 'market/plugin/v1', load)
  )
  await Promise.resolve()
  expect(load).toHaveBeenCalledOnce()
  held.resolve('detail')
  expect(await Promise.all(readers)).toEqual(Array(11).fill('detail'))
  expect(await cache.read('device/account', 'market/plugin/v1', load)).toBe('detail')
  expect(load).toHaveBeenCalledOnce()
  await vi.advanceTimersByTimeAsync(60_000)
  expect(await cache.read('device/account', 'market/plugin/v1', load)).toBe('updated')
  expect(load).toHaveBeenCalledTimes(2)
})

test('marketplace, plugin, and version keys do not share details', async () => {
  const cache = createPluginDetailCache<string>()
  const load = vi.fn().mockResolvedValue('detail')
  for (const key of ['market/a/v1', 'market/a/v2', 'market/b/v1', 'other/a/v1']) {
    await cache.read('scope', key, load)
  }
  expect(load).toHaveBeenCalledTimes(4)
})

test('account round trips discard pending results and never reuse an old account cache', async () => {
  const cache = createPluginDetailCache<string>()
  const held = deferred()
  const pending = expect(cache.read('A', 'plugin', () => held.promise)).rejects.toThrow('changed')
  await cache.read('B', 'plugin', async () => 'B')
  await cache.read('A', 'plugin', async () => 'new A')
  held.resolve('old A')
  await pending
  expect(await cache.read('A', 'plugin', async () => 'unexpected')).toBe('new A')
})

test('manual refresh supersedes an ordinary request and concurrent refreshes are merged', async () => {
  const cache = createPluginDetailCache<string>()
  const old = deferred()
  const fresh = deferred()
  const load = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise)
  const stale = expect(cache.read('scope', 'plugin', load)).rejects.toThrow('changed')
  await Promise.resolve()
  const current = [
    cache.read('scope', 'plugin', load, true),
    cache.read('scope', 'plugin', load, true),
  ]
  await Promise.resolve()
  expect(load).toHaveBeenCalledTimes(2)
  old.resolve('old')
  await stale
  fresh.resolve('fresh')
  expect(await Promise.all(current)).toEqual(['fresh', 'fresh'])
})

test('failures are retryable and explicit invalidation fences an in-flight result', async () => {
  const cache = createPluginDetailCache<string>()
  const load = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue('ready')
  await expect(cache.read('scope', 'plugin', load)).rejects.toThrow('offline')
  expect(await cache.read('scope', 'plugin', load)).toBe('ready')
  const held = deferred()
  const old = expect(cache.read('scope', 'other', () => held.promise)).rejects.toThrow('changed')
  cache.invalidate()
  held.resolve('old')
  await old
})
