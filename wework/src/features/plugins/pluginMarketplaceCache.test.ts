import { afterEach, describe, expect, test, vi } from 'vitest'
import type { PluginMarketplaceItem } from '@/types/api'
import type { InstalledPluginItem } from '@/components/plugins/PluginManagementRows'
import {
  clearPluginMarketplaceCache,
  flushPluginMarketplaceCachePersist,
  getPluginMarketplaceCache,
  marketplaceItemsSignature,
  pluginMarketplaceCacheKey,
  resetPluginMarketplaceCacheMemory,
  sameInstalledPlugins,
  sameMarketplaceItems,
  setPluginMarketplaceCache,
  splitPluginMarketplaceCacheKey,
  subscribePluginMarketplaceCache,
} from './pluginMarketplaceCache'

function item(
  overrides: Partial<PluginMarketplaceItem> & Pick<PluginMarketplaceItem, 'id' | 'name'>
): PluginMarketplaceItem {
  return {
    remotePluginId: String(overrides.id),
    displayName: overrides.name,
    description: '',
    version: '1.0.0',
    author: null,
    visibility: 'public',
    featured: false,
    installed: false,
    installedPluginId: null,
    enabled: false,
    sourceType: 'marketplace',
    interface: null,
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
    ownerUserId: 0,
    sourceLabel: '',
    latestReleaseId: null,
    manifest: {},
    ...overrides,
  }
}

describe('pluginMarketplaceCache', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    clearPluginMarketplaceCache()
  })

  test('stores and returns snapshots by cache key', () => {
    const key = pluginMarketplaceCacheKey('http://api', 'token-abc')
    setPluginMarketplaceCache({
      cacheKey: key,
      marketplaceItems: [item({ id: 1, name: 'a', installed: true })],
      installedPlugins: [],
      marketplaces: [],
      selectedMarketplaceKey: '',
      deviceId: 'device-1',
      fetchedAt: Date.now(),
    })
    expect(getPluginMarketplaceCache(key)?.deviceId).toBe('device-1')
    expect(getPluginMarketplaceCache('other')).toBeNull()
  })

  test('keeps full logos in memory but strips oversized data URLs from durable storage', () => {
    const key = pluginMarketplaceCacheKey('http://api', 'token-logos')
    const logo = `data:image/png;base64,${'A'.repeat(5000)}`
    setPluginMarketplaceCache({
      cacheKey: key,
      marketplaceItems: [
        item({
          id: 3,
          name: 'tingwen',
          displayName: '听文成稿',
          interface: {
            displayName: '听文成稿',
            logo,
          },
        }),
      ],
      installedPlugins: [],
      marketplaces: [],
      selectedMarketplaceKey: '',
      deviceId: 'device-1',
      fetchedAt: Date.now(),
    })

    expect(getPluginMarketplaceCache(key)?.marketplaceItems[0]?.interface?.logo).toBe(logo)
    resetPluginMarketplaceCacheMemory()
    expect(getPluginMarketplaceCache(key)?.marketplaceItems[0]?.interface?.logo).toBeNull()
    expect(getPluginMarketplaceCache(key)?.logosStripped).toBe(true)
  })

  test('compacts an existing heavy v2 snapshot before returning it', () => {
    const storageKey = 'wework.plugins.marketplaceCache.v2'
    const key = pluginMarketplaceCacheKey('http://api', 'token-heavy-v2')
    const logo = `data:image/png;base64,${'A'.repeat(200_000)}`
    const heavySnapshot = {
      cacheKey: key,
      marketplaceItems: [
        item({
          id: 3,
          name: 'tingwen',
          interface: {
            displayName: '听文成稿',
            shortDescription: 'Create documents',
            longDescription: 'L'.repeat(100_000),
            logo,
          },
        }),
      ],
      installedPlugins: [],
      marketplaces: [],
      selectedMarketplaceKey: '',
      deviceId: 'device-1',
      fetchedAt: Date.now(),
    }
    const heavyRaw = JSON.stringify({ entries: { [key]: heavySnapshot } })
    window.localStorage.setItem(storageKey, heavyRaw)
    resetPluginMarketplaceCacheMemory()

    const restored = getPluginMarketplaceCache(key)
    const compactedRaw = window.localStorage.getItem(storageKey) ?? ''

    expect(restored?.marketplaceItems[0]?.interface).toMatchObject({
      displayName: '听文成稿',
      shortDescription: 'Create documents',
      logo: null,
    })
    expect(restored?.marketplaceItems[0]?.interface?.longDescription).toBeUndefined()
    expect(compactedRaw.length).toBeLessThan(heavyRaw.length / 10)
  })

  test('anon cache key never reuses an authenticated snapshot', () => {
    const authedKey = pluginMarketplaceCacheKey('http://api', 'token-warm-start')
    setPluginMarketplaceCache({
      cacheKey: authedKey,
      marketplaceItems: [
        item({ id: 9, name: 'wework-official', visibility: 'public', sourceLabel: 'Wework' }),
      ],
      installedPlugins: [],
      marketplaces: [],
      selectedMarketplaceKey: '',
      deviceId: 'device-1',
      fetchedAt: Date.now(),
    })

    const anonKey = pluginMarketplaceCacheKey('http://api', null)
    expect(splitPluginMarketplaceCacheKey(anonKey).tokenHint).toBe('anon')
    expect(getPluginMarketplaceCache(anonKey)).toBeNull()
    expect(getPluginMarketplaceCache(authedKey)?.marketplaceItems).toEqual([
      expect.objectContaining({ id: 9, name: 'wework-official' }),
    ])
  })

  test('authenticated lookup releases durable snapshots from inactive accounts', () => {
    const storageKey = 'wework.plugins.marketplaceCache.v2'
    const activeKey = pluginMarketplaceCacheKey('http://api', 'token-active')
    const inactiveKey = pluginMarketplaceCacheKey('http://api', 'token-inactive')
    const snapshotFor = (cacheKey: string, name: string) => ({
      cacheKey,
      marketplaceItems: [item({ id: name, name })],
      installedPlugins: [],
      marketplaces: [],
      selectedMarketplaceKey: '',
      deviceId: 'device-1',
      fetchedAt: Date.now(),
    })
    window.localStorage.setItem(
      storageKey,
      JSON.stringify({
        entries: {
          [inactiveKey]: snapshotFor(inactiveKey, 'inactive'),
          [activeKey]: snapshotFor(activeKey, 'active'),
        },
      })
    )
    resetPluginMarketplaceCacheMemory()

    expect(getPluginMarketplaceCache(activeKey)?.marketplaceItems[0]?.name).toBe('active')
    const persisted = JSON.parse(window.localStorage.getItem(storageKey) ?? '{}') as {
      entries?: Record<string, unknown>
    }
    expect(Object.keys(persisted.entries ?? {})).toEqual([activeKey])
  })

  test('retries a compact snapshot after releasing the value WebKit counts toward quota', () => {
    const storageKey = 'wework.plugins.marketplaceCache.v2'
    const key = pluginMarketplaceCacheKey('http://api', 'token-quota-retry')
    window.localStorage.setItem(storageKey, JSON.stringify({ entries: { old: {} } }))
    const nativeSetItem = Storage.prototype.setItem
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (name, value) {
      if (name === storageKey && window.localStorage.getItem(storageKey)) {
        throw new DOMException('Quota exceeded', 'QuotaExceededError')
      }
      nativeSetItem.call(this, name, value)
    })

    setPluginMarketplaceCache({
      cacheKey: key,
      marketplaceItems: [item({ id: 'gmail', name: 'gmail' })],
      installedPlugins: [],
      marketplaces: [],
      selectedMarketplaceKey: '',
      deviceId: 'device-1',
      fetchedAt: Date.now(),
    })
    flushPluginMarketplaceCachePersist()

    expect(window.localStorage.getItem(storageKey)).toMatch(/^lz:/)
    resetPluginMarketplaceCacheMemory()
    expect(getPluginMarketplaceCache(key)?.marketplaceItems[0]?.name).toBe('gmail')
  })

  test('rehydrates installed plugins from durable storage after memory reset', () => {
    const key = pluginMarketplaceCacheKey('http://api', 'token-durable')
    const installed: InstalledPluginItem[] = [
      {
        id: '59',
        name: 'Dev Tools',
        description: '',
        enabled: true,
        version: '0.1.0',
        origin: 'created',
        sourceLabel: '我创建的',
        distribution: 'personal',
        updateAvailable: false,
        componentCounts: {},
        raw: {
          apiVersion: 'v1',
          kind: 'InstalledPlugin',
          metadata: {},
          spec: {
            source: { type: 'local', providerKey: 'p', pluginKey: 'dev-tools' },
            origin: 'created',
            displayName: 'Dev Tools',
            description: '',
            installState: 'installed',
            enabled: true,
            componentStates: {},
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
            interface: { logo: 'https://example.com/dev-tools.png' },
          },
          status: { state: 'enabled' },
        },
      },
    ]
    setPluginMarketplaceCache({
      cacheKey: key,
      marketplaceItems: [item({ id: 1, name: 'dev-tools', installed: true })],
      installedPlugins: installed,
      marketplaces: [],
      selectedMarketplaceKey: '',
      deviceId: 'device-1',
      fetchedAt: Date.now(),
    })

    resetPluginMarketplaceCacheMemory()
    expect(getPluginMarketplaceCache(key)?.installedPlugins).toEqual([
      expect.objectContaining({ id: '59', name: 'Dev Tools' }),
    ])
  })

  test('detects marketplace item changes via signature', () => {
    const left = [item({ id: 1, name: 'a', version: '1.0.0', installed: false })]
    const right = [item({ id: 1, name: 'a', version: '1.0.0', installed: true })]
    expect(sameMarketplaceItems(left, left)).toBe(true)
    expect(sameMarketplaceItems(left, right)).toBe(false)
    expect(marketplaceItemsSignature(left)).not.toBe(marketplaceItemsSignature(right))
  })

  test('detects installedPluginId and display name changes via signature', () => {
    const left = [item({ id: 1, name: 'a', installed: true, installedPluginId: 10 })]
    const rightId = [item({ id: 1, name: 'a', installed: true, installedPluginId: 11 })]
    const rightName = [item({ id: 1, name: 'b', installed: true, installedPluginId: 10 })]
    expect(sameMarketplaceItems(left, rightId)).toBe(false)
    expect(sameMarketplaceItems(left, rightName)).toBe(false)
  })

  test('detects marketplace component changes via signature', () => {
    const left = [item({ id: 1, name: 'a' })]
    const right = [
      item({
        id: 1,
        name: 'a',
        components: {
          ...left[0]!.components,
          skills: [{ name: 'review', description: 'Review code', path: 'skills/review' }],
        },
      }),
    ]

    expect(sameMarketplaceItems(left, right)).toBe(false)
  })

  test('detects device installation state changes via signature', () => {
    const base = item({ id: 1, name: 'a', installed: false })
    const failed = item({
      id: 1,
      name: 'a',
      installed: false,
      currentDeviceInstallation: {
        deviceId: 'd1',
        desiredReleaseId: 1,
        actualReleaseId: null,
        state: 'failed',
        errorCode: 'PLUGIN_SYNC_FAILED',
        errorMessage: 'rejected',
        attemptCount: 1,
        lastSyncAt: null,
        updatedAt: null,
      },
    })
    expect(sameMarketplaceItems([base], [failed])).toBe(false)
  })

  test('detects Codex availability lock changes via signature', () => {
    const available = [
      item({
        id: 'gmail@openai-curated-remote',
        name: 'gmail',
        manifest: { availability: 'AVAILABLE' },
      }),
    ]
    const locked = [
      item({
        id: 'gmail@openai-curated-remote',
        name: 'gmail',
        manifest: {
          availability: 'DISABLED_BY_ADMIN',
          disabledReason: 'plan_not_eligible',
          installPolicy: 'NOT_AVAILABLE',
        },
      }),
    ]
    expect(sameMarketplaceItems(available, locked)).toBe(false)
  })

  test('detects installed plugin name and distribution changes via signature', () => {
    const left: InstalledPluginItem[] = [
      {
        id: '1',
        name: 'Dev Tools',
        description: '',
        enabled: true,
        version: '0.1.0',
        origin: 'created',
        sourceLabel: '我创建的',
        distribution: 'personal',
        updateAvailable: false,
        componentCounts: {},
        raw: {
          apiVersion: 'v1',
          kind: 'InstalledPlugin',
          metadata: {},
          spec: {
            source: { type: 'local', providerKey: 'p', pluginKey: 'dev-tools' },
            origin: 'created',
            displayName: 'Dev Tools',
            description: '',
            installState: 'installed',
            enabled: true,
            componentStates: {},
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
            interface: null,
          },
          status: { state: 'enabled' },
        },
      },
    ]
    const right = [{ ...left[0], name: 'Dev Tools 2', distribution: 'public' as const }]
    expect(sameInstalledPlugins(left, left)).toBe(true)
    expect(sameInstalledPlugins(left, right)).toBe(false)

    const componentsChanged = structuredClone(left)
    componentsChanged[0]!.raw.spec.components.skills = [
      { name: 'review', description: 'Review code', path: 'skills/review' },
    ]
    expect(sameInstalledPlugins(left, componentsChanged)).toBe(false)
  })

  test('keeps memory and listeners immediate while delaying durable persist', () => {
    vi.useFakeTimers()
    const key = pluginMarketplaceCacheKey('http://api', 'token-debounce')
    const storageKey = 'wework.plugins.marketplaceCache.v2'
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
      { name: 'review', description: 'Review code', path: 'review' },
    ])
  })

  test('flushPluginMarketplaceCachePersist writes the pending snapshot immediately', () => {
    vi.useFakeTimers()
    const key = pluginMarketplaceCacheKey('http://api', 'token-flush')
    const storageKey = 'wework.plugins.marketplaceCache.v2'
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
})
