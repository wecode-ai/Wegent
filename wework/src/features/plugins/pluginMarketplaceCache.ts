import type { PluginInterface, PluginMarketplaceItem } from '@/types/api'
import type { InstalledPluginItem } from '@/components/plugins/PluginManagementRows'

export interface PluginMarketplaceCacheSnapshot {
  cacheKey: string
  marketplaceItems: PluginMarketplaceItem[]
  installedPlugins: InstalledPluginItem[]
  marketplaces: Array<{
    key: string
    id: string
    name: string
    kind: 'local' | 'cloud'
    path?: string
  }>
  selectedMarketplaceKey: string
  deviceId: string
  canPublish: boolean
  canSharePersonalPlugins: boolean
  fetchedAt: number
  /**
   * True when durable storage had to drop inlined data-URL logos to fit quota.
   * Callers must revalidate from the network and not prefer the warm snapshot's
   * empty logo fields over a fresh catalog response.
   */
  logosStripped?: boolean
}

/** v2: prefer full logo persistence; invalidate v1 entries that nulled data-URL logos. */
const STORAGE_KEY = 'wework.plugins.marketplaceCache.v2'
/** Keep a warm catalog / installed strip across app restarts. */
const DURABLE_TTL_MS = 7 * 24 * 60 * 60 * 1000
/** Only strip oversized inlined logos when localStorage rejects the full snapshot. */
const MAX_PERSISTED_LOGO_CHARS = 4096

interface PersistedMarketplaceCacheStore {
  entries: Record<string, PluginMarketplaceCacheSnapshot>
}

let snapshot: PluginMarketplaceCacheSnapshot | null = null
type MarketplaceCacheListener = (next: PluginMarketplaceCacheSnapshot | null) => void
const listeners = new Set<MarketplaceCacheListener>()

export function pluginMarketplaceCacheKey(
  cloudApiBaseUrl?: string | null,
  cloudToken?: string | null
): string {
  const tokenHint = cloudToken ? cloudToken.slice(-12) : 'anon'
  return `${cloudApiBaseUrl || ''}|${tokenHint}`
}

export function splitPluginMarketplaceCacheKey(cacheKey: string): {
  apiBase: string
  tokenHint: string
} {
  const separator = cacheKey.lastIndexOf('|')
  if (separator < 0) return { apiBase: cacheKey, tokenHint: 'anon' }
  return {
    apiBase: cacheKey.slice(0, separator),
    tokenHint: cacheKey.slice(separator + 1) || 'anon',
  }
}

function slimLogoField(value?: string | null): string | null | undefined {
  if (typeof value !== 'string') return value
  if (value.startsWith('data:') && value.length > MAX_PERSISTED_LOGO_CHARS) return null
  return value
}

function slimInterface(interfaceData?: PluginInterface | null): PluginInterface | null {
  if (!interfaceData) return null
  return {
    ...interfaceData,
    logo: slimLogoField(interfaceData.logo),
    logoDark: slimLogoField(interfaceData.logoDark),
    composerIcon: slimLogoField(interfaceData.composerIcon),
  }
}

function toPersistedSnapshot(
  next: PluginMarketplaceCacheSnapshot,
  logosStripped: boolean
): PluginMarketplaceCacheSnapshot {
  if (!logosStripped) {
    return { ...next, logosStripped: false }
  }
  return {
    ...next,
    logosStripped: true,
    marketplaceItems: next.marketplaceItems.map(item => ({
      ...item,
      interface: slimInterface(item.interface),
    })),
    installedPlugins: next.installedPlugins.map(plugin => ({
      ...plugin,
      raw: {
        ...plugin.raw,
        spec: {
          ...plugin.raw.spec,
          interface: slimInterface(plugin.raw.spec.interface),
        },
      },
    })),
  }
}

let forgotLegacyCache = false

function forgetLegacyMarketplaceCache(): void {
  if (forgotLegacyCache || typeof window === 'undefined') return
  forgotLegacyCache = true
  try {
    // v1 always stripped large data-URL logos and painted initials after restart.
    window.localStorage.removeItem('wework.plugins.marketplaceCache.v1')
  } catch {
    // Ignore storage failures while migrating cache versions.
  }
}

function readPersistedStore(): PersistedMarketplaceCacheStore {
  if (typeof window === 'undefined') return { entries: {} }
  forgetLegacyMarketplaceCache()
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return { entries: {} }
    const parsed = JSON.parse(raw) as PersistedMarketplaceCacheStore
    if (!parsed || typeof parsed !== 'object' || !parsed.entries) return { entries: {} }
    return { entries: parsed.entries }
  } catch {
    return { entries: {} }
  }
}

function isQuotaExceededError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const name = 'name' in error ? String(error.name) : ''
  const code = 'code' in error ? Number(error.code) : NaN
  return name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED' || code === 22
}

function writePersistedStore(store: PersistedMarketplaceCacheStore): void {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(store))
}

function isUsableSnapshot(
  entry: PluginMarketplaceCacheSnapshot | null | undefined,
  cacheKey?: string
): entry is PluginMarketplaceCacheSnapshot {
  if (!entry) return false
  if (cacheKey && entry.cacheKey !== cacheKey) return false
  if (typeof entry.fetchedAt !== 'number') return false
  if (Date.now() - entry.fetchedAt > DURABLE_TTL_MS) return false
  return Array.isArray(entry.installedPlugins) && Array.isArray(entry.marketplaceItems)
}

function readPersistedSnapshot(cacheKey: string): PluginMarketplaceCacheSnapshot | null {
  const entry = readPersistedStore().entries[cacheKey]
  return isUsableSnapshot(entry, cacheKey) ? entry : null
}

function trimPersistedEntries(store: PersistedMarketplaceCacheStore): void {
  const keys = Object.keys(store.entries)
  if (keys.length <= 4) return
  const sorted = keys
    .map(key => ({ key, fetchedAt: store.entries[key]?.fetchedAt ?? 0 }))
    .sort((left, right) => right.fetchedAt - left.fetchedAt)
  for (const stale of sorted.slice(4)) {
    delete store.entries[stale.key]
  }
}

function persistSnapshot(next: PluginMarketplaceCacheSnapshot): void {
  if (typeof window === 'undefined') return
  const store = readPersistedStore()
  const write = (entry: PluginMarketplaceCacheSnapshot) => {
    store.entries[next.cacheKey] = entry
    trimPersistedEntries(store)
    writePersistedStore(store)
  }

  try {
    // Prefer keeping package logos on disk so restart does not flash initials.
    write(toPersistedSnapshot(next, false))
  } catch (error) {
    if (!isQuotaExceededError(error)) {
      console.warn('[Wework] Failed to persist plugin marketplace cache.', error)
      return
    }
    try {
      write(toPersistedSnapshot(next, true))
      console.warn(
        '[Wework] Plugin marketplace cache exceeded storage quota; persisted without large data-URL logos.'
      )
    } catch (slimError) {
      console.warn('[Wework] Failed to persist plugin marketplace cache.', slimError)
    }
  }
}

/**
 * Resolve a warm marketplace snapshot. Exact cache-key match wins. While auth is
 * still `anon`, reuse only the in-memory snapshot for the same API base (same
 * session token handoff) — never promote another account's durable disk entry.
 */
export function getPluginMarketplaceCache(cacheKey: string): PluginMarketplaceCacheSnapshot | null {
  if (snapshot?.cacheKey === cacheKey) return snapshot

  const exact = readPersistedSnapshot(cacheKey)
  if (exact) {
    snapshot = exact
    return snapshot
  }

  const { apiBase, tokenHint } = splitPluginMarketplaceCacheKey(cacheKey)
  if (
    tokenHint === 'anon' &&
    apiBase &&
    snapshot &&
    splitPluginMarketplaceCacheKey(snapshot.cacheKey).apiBase === apiBase
  ) {
    return { ...snapshot, cacheKey }
  }

  return null
}

export function setPluginMarketplaceCache(next: PluginMarketplaceCacheSnapshot): void {
  // Memory always keeps full-fidelity logos for the current session.
  snapshot = { ...next, logosStripped: false }
  persistSnapshot(next)
  for (const listener of listeners) listener(snapshot)
}

export function clearPluginMarketplaceCache(): void {
  snapshot = null
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.removeItem(STORAGE_KEY)
      // Drop the poisoned v1 cache that always stripped large data-URL logos.
      window.localStorage.removeItem('wework.plugins.marketplaceCache.v1')
    } catch {
      // Ignore storage failures during logout / reset.
    }
  }
  for (const listener of listeners) listener(null)
}

/** Notify when the marketplace cache changes so composer can reuse package logos. */
export function subscribePluginMarketplaceCache(listener: MarketplaceCacheListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Test helper: drop memory without clearing durable storage. */
export function resetPluginMarketplaceCacheMemory(): void {
  snapshot = null
}

export function marketplaceItemsSignature(items: PluginMarketplaceItem[]): string {
  return items
    .map(item =>
      [
        item.id,
        item.name ?? '',
        item.displayName ?? '',
        item.version ?? '',
        item.installed ? '1' : '0',
        item.installedLocally ? '1' : '0',
        item.installedPluginId ?? '',
        item.updateAvailable ? '1' : '0',
        item.enabled ? '1' : '0',
        item.grantUserCount ?? 0,
        item.grantNamespaceCount ?? 0,
        item.accessRole ?? '',
        item.latestReleaseId ?? '',
        item.interface?.logo ?? '',
        item.interface?.displayName ?? '',
        item.currentDeviceInstallation?.state ?? '',
        item.currentDeviceInstallation?.errorMessage ?? '',
        item.currentDeviceInstallation?.actualReleaseId ?? '',
      ].join(':')
    )
    .join('|')
}

export function installedPluginsSignature(items: InstalledPluginItem[]): string {
  return items
    .map(item =>
      [
        item.id,
        item.name,
        item.version ?? '',
        item.enabled ? '1' : '0',
        item.updateAvailable ? '1' : '0',
        item.origin,
        item.sourceLabel,
        item.distribution,
      ].join(':')
    )
    .join('|')
}

export function sameMarketplaceItems(
  left: PluginMarketplaceItem[],
  right: PluginMarketplaceItem[]
): boolean {
  return marketplaceItemsSignature(left) === marketplaceItemsSignature(right)
}

export function sameInstalledPlugins(
  left: InstalledPluginItem[],
  right: InstalledPluginItem[]
): boolean {
  return installedPluginsSignature(left) === installedPluginsSignature(right)
}
