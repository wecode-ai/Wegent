import { afterEach, describe, expect, test, vi } from 'vitest'
import { compressToUTF16 } from 'lz-string'
import {
  clearPluginMarketplaceCache,
  flushPluginMarketplaceCachePersist,
  getPluginMarketplaceCache,
  pluginMarketplaceCacheKey,
  removePluginMarketplaceInstallation,
  resetPluginMarketplaceCacheMemory,
  setPluginMarketplaceCache,
  subscribePluginMarketplaceCache,
} from './pluginMarketplaceCache'
import { item, installedItem } from './pluginMarketplaceCache.test-fixtures'

describe('plugin inventory persistence', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    clearPluginMarketplaceCache()
  })
  test('keeps memory and listeners immediate while delaying durable persist', () => {
    vi.useFakeTimers()
    const key = pluginMarketplaceCacheKey('http://api', 'token-debounce')
    const storageKey = 'wework.plugins.inventory.v2'
    const heard: Array<string | undefined> = []
    const unsubscribe = subscribePluginMarketplaceCache(next => {
      heard.push(next?.deviceId)
    })

    setPluginMarketplaceCache({
      cacheKey: key,
      marketplaceItems: [item({ id: 1, name: 'a' })],
      installedPlugins: [],
      marketplaces: [],
      selectedMarketplaceKey: '',
      deviceId: 'device-live',
      fetchedAt: Date.now(),
    })

    expect(getPluginMarketplaceCache(key)?.deviceId).toBe('device-live')
    expect(heard).toEqual(['device-live'])
    expect(window.localStorage.getItem(storageKey)).toBeNull()

    vi.advanceTimersByTime(300)
    expect(window.localStorage.getItem(storageKey)).toBeTruthy()
    unsubscribe()
    vi.useRealTimers()
  })

  test('skips a durable rewrite when the snapshot signature is unchanged', () => {
    const key = pluginMarketplaceCacheKey('http://api', 'token-skip')
    const snapshot = {
      cacheKey: key,
      marketplaceItems: [item({ id: 1, name: 'a' })],
      installedPlugins: [],
      marketplaces: [],
      selectedMarketplaceKey: '',
      deviceId: 'device-1',
      fetchedAt: Date.now(),
    }
    setPluginMarketplaceCache(snapshot, { persistImmediately: true })
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    setItem.mockClear()
    setPluginMarketplaceCache(
      { ...snapshot, fetchedAt: Date.now() + 10 },
      {
        persistImmediately: true,
      }
    )
    expect(setItem).not.toHaveBeenCalled()
  })

  test('persists a component-only catalog change', () => {
    const key = pluginMarketplaceCacheKey('http://api', 'token-components')
    const snapshot = {
      cacheKey: key,
      marketplaceItems: [item({ id: 1, name: 'a' })],
      installedPlugins: [],
      marketplaces: [],
      selectedMarketplaceKey: '',
      deviceId: 'device-1',
      fetchedAt: Date.now(),
    }
    setPluginMarketplaceCache(snapshot, { persistImmediately: true })
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    setItem.mockClear()

    setPluginMarketplaceCache(
      {
        ...snapshot,
        marketplaceItems: [
          item({
            id: 1,
            name: 'a',
            components: {
              ...snapshot.marketplaceItems[0]!.components,
              skills: [{ name: 'review', description: 'Review code', path: 'skills/review' }],
            },
          }),
        ],
      },
      { persistImmediately: true }
    )

    expect(setItem).toHaveBeenCalled()
    resetPluginMarketplaceCacheMemory()
    expect(getPluginMarketplaceCache(key)?.marketplaceItems[0]?.components.skills).toEqual([
      { name: 'review', description: 'Review code', path: 'skills/review' },
    ])
  })

  test('persists source ownership changes even when canonical records are unchanged', () => {
    const key = pluginMarketplaceCacheKey('http://api', 'token-sources')
    const plugin = installedItem('tool@market', 'market', 'tool').raw
    const identity = 'market:tool'
    const snapshot = {
      cacheKey: key,
      deviceId: 'device',
      fetchedAt: Date.now(),
      marketplaceItems: [],
      installedPlugins: [plugin],
      marketplaces: [],
      selectedMarketplaceKey: '',
    }
    setPluginMarketplaceCache(
      {
        ...snapshot,
        localInstalledSources: { codex: [identity], store: [] },
        localInstalledSourceStatus: { codex: 'fulfilled', store: 'fulfilled' },
      },
      { persistImmediately: true }
    )
    setPluginMarketplaceCache(
      {
        ...snapshot,
        localInstalledSources: { codex: [], store: [identity] },
        localInstalledSourceStatus: { codex: 'rejected', store: 'fulfilled' },
      },
      { persistImmediately: true }
    )

    resetPluginMarketplaceCacheMemory()
    const restored = getPluginMarketplaceCache(key)!
    expect(restored.installedPlugins).toHaveLength(1)
    expect(restored.localInstalledSources).toEqual({ codex: [], store: [identity] })
    expect(restored.localInstalledSourceStatus).toEqual({ codex: 'rejected', store: 'fulfilled' })
  })

  test('remaps native ownership when a cloud response projects a new canonical identity', () => {
    const key = pluginMarketplaceCacheKey('http://api', 'token-project-source')
    const raw = installedItem('tool@market', 'market', 'tool').raw
    raw.spec.sourcePayload = { cloudPluginId: 42, managedByWegent: true }
    const base = {
      cacheKey: key,
      deviceId: 'device',
      fetchedAt: Date.now(),
      marketplaceItems: [],
      marketplaces: [],
      selectedMarketplaceKey: '',
    }
    setPluginMarketplaceCache(
      { ...base, installedPlugins: [raw], localInstalledSources: { store: ['market:tool'] } },
      { persistImmediately: true }
    )
    const cloud = { ...raw, spec: { ...raw.spec, pluginId: 42 } }
    setPluginMarketplaceCache({ ...base, installedPlugins: [cloud] }, { persistImmediately: true })
    resetPluginMarketplaceCacheMemory()
    expect(getPluginMarketplaceCache(key)?.localInstalledSources?.store).toEqual(['cloud:42'])
    removePluginMarketplaceInstallation(key, {
      installedIds: ['tool@market'],
      pluginKeys: ['tool'],
      marketplaceItemIds: [],
    })
    expect(getPluginMarketplaceCache(key)?.localInstalledSources?.store).toEqual([])
  })

  test('flushPluginMarketplaceCachePersist writes the pending snapshot immediately', () => {
    vi.useFakeTimers()
    const key = pluginMarketplaceCacheKey('http://api', 'token-flush')
    const storageKey = 'wework.plugins.inventory.v2'
    setPluginMarketplaceCache({
      cacheKey: key,
      marketplaceItems: [item({ id: 2, name: 'b' })],
      installedPlugins: [],
      marketplaces: [],
      selectedMarketplaceKey: '',
      deviceId: 'device-flush',
      fetchedAt: Date.now(),
    })
    expect(window.localStorage.getItem(storageKey)).toBeNull()
    flushPluginMarketplaceCachePersist()
    expect(window.localStorage.getItem(storageKey)).toBeTruthy()
    vi.useRealTimers()
  })

  test('installation writes reuse the encoded directory and restore every pending mutation', () => {
    const key = 'http://api|parallel-cache'
    const first = installedItem('101', 'market', 'one').raw
    const second = installedItem('102', 'market', 'two').raw
    const base = {
      cacheKey: key,
      deviceId: 'device-1',
      fetchedAt: Date.now(),
      marketplaces: [],
      selectedMarketplaceKey: '',
      installedPlugins: [],
      marketplaceItems: [item({ id: 1, name: 'one' }), item({ id: 2, name: 'two' })],
    }
    setPluginMarketplaceCache(base, { persistImmediately: true })
    const read = () =>
      JSON.parse(window.localStorage.getItem('wework.plugins.inventory.v2')!).entries[key]
    const directory = read().marketplaceItems
    setPluginMarketplaceCache(
      { ...base, installedPlugins: [first] },
      { mutation: true, persistImmediately: true }
    )
    expect(read().marketplaceItems).toBe(directory)
    setPluginMarketplaceCache(
      { ...base, installedPlugins: [first, second] },
      { mutation: true, persistImmediately: true }
    )
    expect(read().marketplaceItems).toBe(directory)
    resetPluginMarketplaceCacheMemory()
    expect(getPluginMarketplaceCache(key)?.installedPlugins).toEqual([first, second])
    removePluginMarketplaceInstallation(key, {
      installedIds: ['101'],
      marketplaceItemIds: [1],
      pluginKeys: ['one'],
    })
    resetPluginMarketplaceCacheMemory()
    expect(getPluginMarketplaceCache(key)?.installedPlugins).toEqual([second])
    expect(getPluginMarketplaceCache(key)?.marketplaceItems[0]).toMatchObject({
      installed: false,
      installedLocally: false,
      installedPluginId: null,
    })
  })

  test('reads the previous whole-snapshot compressed cache without losing accepted installations', () => {
    const key = 'http://api|old-compressed'
    const plugin = installedItem('101', 'market', 'one').raw
    const previous = {
      cacheKey: key,
      deviceId: 'device-1',
      fetchedAt: Date.now(),
      marketplaces: [],
      selectedMarketplaceKey: '',
      installedPlugins: [plugin],
      marketplaceItems: [item({ id: 1, name: 'one', installed: true, installedPluginId: '101' })],
    }
    window.localStorage.setItem(
      'wework.plugins.inventory.v2',
      `lz:${compressToUTF16(JSON.stringify({ entries: { [key]: previous } }))}`
    )
    resetPluginMarketplaceCacheMemory()
    expect(getPluginMarketplaceCache(key)?.installedPlugins).toEqual([plugin])
    expect(getPluginMarketplaceCache(key)?.marketplaceItems[0]).toMatchObject({
      installed: true,
      installedPluginId: '101',
    })
  })

  test('a failed durable write retries the same state instead of marking it persisted', () => {
    const base = {
      cacheKey: 'http://api|write-failure',
      deviceId: 'device-1',
      fetchedAt: Date.now(),
      marketplaces: [],
      selectedMarketplaceKey: '',
      installedPlugins: [],
      marketplaceItems: [],
    }
    const original = Storage.prototype.setItem
    const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Storage unavailable', 'SecurityError')
    })
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    setPluginMarketplaceCache(base, { mutation: true, persistImmediately: true })
    write.mockImplementation(original)
    setPluginMarketplaceCache(base, { persistImmediately: true })
    expect(window.localStorage.getItem('wework.plugins.inventory.v2')).toBeTruthy()
  })
})
