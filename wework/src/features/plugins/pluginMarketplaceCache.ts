import type { PluginInterface, PluginMarketplaceItem } from '@/types/api'
import type { InstalledPluginItem } from '@/components/plugins/PluginManagementRows'
import { slimPluginComponentsForCache } from '@/features/plugins/slimPluginComponents'
import { compressToUTF16, decompressFromUTF16 } from 'lz-string'

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
  fetchedAt: number
  /**
   * True when durable storage had to drop inlined data-URL logos to fit quota.
   * Callers must revalidate from the network and not prefer the warm snapshot's
   * empty logo fields over a fresh catalog response.
   */
  logosStripped?: boolean
}

/** v2 durable snapshots are compacted in place to preserve existing warm catalogs. */
const STORAGE_KEY = 'wework.plugins.marketplaceCache.v2'
/** Keep a warm catalog / installed strip across app restarts. */
const DURABLE_TTL_MS = 7 * 24 * 60 * 60 * 1000
/** Never let one inlined package logo consume a material share of WebView storage. */
const MAX_PERSISTED_LOGO_CHARS = 4096
const COMPRESSED_STORAGE_PREFIX = 'lz:'

interface PersistedMarketplaceCacheStore {
  entries: Record<string, PluginMarketplaceCacheSnapshot>
}

let snapshot: PluginMarketplaceCacheSnapshot | null = null
type MarketplaceCacheListener = (next: PluginMarketplaceCacheSnapshot | null) => void
const listeners = new Set<MarketplaceCacheListener>()
const PERSIST_DEBOUNCE_MS = 300
let pendingPersist: PluginMarketplaceCacheSnapshot | null = null
let persistTimeoutId: number | null = null
let lastPersistedSignature = ''
let persistFlushBound = false

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
    displayName: interfaceData.displayName ?? null,
    shortDescription: interfaceData.shortDescription ?? null,
    developerName: interfaceData.developerName ?? null,
    category: interfaceData.category ?? null,
    capabilities: interfaceData.capabilities,
    websiteUrl: interfaceData.websiteUrl ?? null,
    privacyPolicyUrl: interfaceData.privacyPolicyUrl ?? null,
    termsOfServiceUrl: interfaceData.termsOfServiceUrl ?? null,
    logo: slimLogoField(interfaceData.logo),
    logoDark: slimLogoField(interfaceData.logoDark),
    composerIcon: slimLogoField(interfaceData.composerIcon),
    brandColor: interfaceData.brandColor ?? null,
  }
}

function slimManifest(manifest?: Record<string, unknown> | null): Record<string, unknown> {
  if (!manifest) return {}
  const keys = [
    'name',
    'id',
    'marketplaceId',
    'source',
    'installPolicy',
    'authPolicy',
    'availability',
    'disabledReason',
    'eligiblePlanTypes',
  ] as const
  return Object.fromEntries(
    keys.flatMap(key => (manifest[key] === undefined ? [] : [[key, manifest[key]]]))
  )
}

function hasOversizedLogo(interfaceData?: PluginInterface | null): boolean {
  if (!interfaceData) return false
  return [interfaceData.logo, interfaceData.logoDark, interfaceData.composerIcon].some(
    value =>
      typeof value === 'string' &&
      value.startsWith('data:') &&
      value.length > MAX_PERSISTED_LOGO_CHARS
  )
}

function toPersistedSnapshot(next: PluginMarketplaceCacheSnapshot): PluginMarketplaceCacheSnapshot {
  const logosStripped =
    next.logosStripped === true ||
    next.marketplaceItems.some(item => hasOversizedLogo(item.interface)) ||
    next.installedPlugins.some(plugin => hasOversizedLogo(plugin.raw.spec.interface))
  return {
    ...next,
    logosStripped,
    marketplaceItems: next.marketplaceItems.map(item => ({
      ...item,
      interface: slimInterface(item.interface),
      components: slimPluginComponentsForCache(item.components),
      manifest: slimManifest(item.manifest),
    })),
    installedPlugins: next.installedPlugins.map(plugin => ({
      ...plugin,
      raw: {
        ...plugin.raw,
        spec: {
          ...plugin.raw.spec,
          interface: slimInterface(plugin.raw.spec.interface),
          components: slimPluginComponentsForCache(plugin.raw.spec.components),
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
    const json = raw.startsWith(COMPRESSED_STORAGE_PREFIX)
      ? decompressFromUTF16(raw.slice(COMPRESSED_STORAGE_PREFIX.length))
      : raw
    if (!json) return { entries: {} }
    const parsed = JSON.parse(json) as PersistedMarketplaceCacheStore
    if (!parsed || typeof parsed !== 'object' || !parsed.entries) return { entries: {} }
    const compacted = {
      entries: Object.fromEntries(
        Object.entries(parsed.entries).map(([key, entry]) => [key, toPersistedSnapshot(entry)])
      ),
    }
    const compactedRaw = JSON.stringify(compacted)
    if (compactedRaw.length < raw.length) {
      // Older v2 builds persisted complete plugin details and large data-URL logos.
      // Rewrite them on first read so the Codex catalog cache has quota to persist.
      try {
        window.localStorage.setItem(STORAGE_KEY, compactedRaw)
      } catch {
        // The compact in-memory value is still usable for this session.
      }
    }
    return compacted
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

function writeCompressedPersistedStore(store: PersistedMarketplaceCacheStore): void {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(
    STORAGE_KEY,
    `${COMPRESSED_STORAGE_PREFIX}${compressToUTF16(JSON.stringify(store))}`
  )
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
  if (!isUsableSnapshot(entry, cacheKey)) return null
  if (splitPluginMarketplaceCacheKey(cacheKey).tokenHint !== 'anon') {
    try {
      // Only the active authenticated account can paint the next app launch.
      // Keeping several full catalogs consumed the quota needed by the canonical
      // local/OpenAI cache and made every background return wait on plugin/list.
      writePersistedStore({ entries: { [cacheKey]: entry } })
    } catch {
      // The exact snapshot is still usable in memory.
    }
  }
  return entry
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

function snapshotPersistSignature(next: PluginMarketplaceCacheSnapshot): string {
  return [
    next.cacheKey,
    next.deviceId,
    next.selectedMarketplaceKey,
    next.marketplaces.map(entry => `${entry.key}:${entry.id}:${entry.path ?? ''}`).join(','),
    marketplaceItemsSignature(next.marketplaceItems),
    installedPluginsSignature(next.installedPlugins),
  ].join('|')
}

function persistSnapshot(next: PluginMarketplaceCacheSnapshot): void {
  if (typeof window === 'undefined') return
  const previousRaw = window.localStorage.getItem(STORAGE_KEY)
  const persisted = toPersistedSnapshot(next)
  const store =
    splitPluginMarketplaceCacheKey(next.cacheKey).tokenHint === 'anon'
      ? readPersistedStore()
      : { entries: {} }
  store.entries[next.cacheKey] = persisted
  trimPersistedEntries(store)

  try {
    writePersistedStore(store)
  } catch (error) {
    if (!isQuotaExceededError(error)) {
      console.warn('[Wework] Failed to persist plugin marketplace cache.', error)
      return
    }
    try {
      // Account switches can leave several otherwise valid snapshots. Under quota
      // pressure, the active account is the only one needed for the next paint.
      writePersistedStore({ entries: { [next.cacheKey]: persisted } })
      console.warn(
        '[Wework] Plugin marketplace cache exceeded storage quota; kept the active account only.'
      )
    } catch {
      try {
        // WebKit may count the value being replaced against quota. Release this
        // exact rebuildable key, then synchronously compress the compact snapshot.
        // Reading remains synchronous, so background restore still paints in the
        // first React render instead of waiting on IndexedDB or plugin/list.
        window.localStorage.removeItem(STORAGE_KEY)
        writeCompressedPersistedStore({ entries: { [next.cacheKey]: persisted } })
      } catch (retryError) {
        if (previousRaw) {
          try {
            window.localStorage.setItem(STORAGE_KEY, previousRaw)
          } catch {
            // The full-fidelity snapshot remains in memory for this WebView.
          }
        }
        console.warn('[Wework] Failed to persist plugin marketplace cache.', retryError)
      }
    }
  }
}

function clearPersistTimer(): void {
  if (persistTimeoutId === null) return
  window.clearTimeout(persistTimeoutId)
  persistTimeoutId = null
}

function persistIfChanged(next: PluginMarketplaceCacheSnapshot): void {
  const signature = snapshotPersistSignature(next)
  if (signature === lastPersistedSignature) return
  persistSnapshot(next)
  lastPersistedSignature = signature
}

function schedulePersistSnapshot(next: PluginMarketplaceCacheSnapshot): void {
  pendingPersist = next
  if (typeof window === 'undefined') {
    persistIfChanged(next)
    pendingPersist = null
    return
  }
  bindPersistFlush()
  clearPersistTimer()
  persistTimeoutId = window.setTimeout(() => {
    persistTimeoutId = null
    if (!pendingPersist) return
    persistIfChanged(pendingPersist)
    pendingPersist = null
  }, PERSIST_DEBOUNCE_MS)
}

function bindPersistFlush(): void {
  if (persistFlushBound || typeof window === 'undefined') return
  persistFlushBound = true
  window.addEventListener('pagehide', flushPluginMarketplaceCachePersist)
  window.addEventListener('beforeunload', flushPluginMarketplaceCachePersist)
}

export function flushPluginMarketplaceCachePersist(): void {
  clearPersistTimer()
  if (!pendingPersist) return
  persistIfChanged(pendingPersist)
  pendingPersist = null
}

/**
 * Resolve a warm marketplace snapshot by exact cache key only. Do not reuse an
 * authenticated in-memory/disk entry under `anon` — token clear / account switch
 * must miss so callers clear prior-account catalog and installs.
 */
export function getPluginMarketplaceCache(cacheKey: string): PluginMarketplaceCacheSnapshot | null {
  if (snapshot?.cacheKey === cacheKey) return snapshot

  const exact = readPersistedSnapshot(cacheKey)
  if (exact) {
    snapshot = exact
    return snapshot
  }

  return null
}

export function setPluginMarketplaceCache(
  next: PluginMarketplaceCacheSnapshot,
  options?: { persistImmediately?: boolean }
): void {
  // Memory always keeps full-fidelity logos for the current session.
  snapshot = { ...next, logosStripped: false }
  if (options?.persistImmediately) {
    clearPersistTimer()
    pendingPersist = null
    persistIfChanged(next)
  } else {
    schedulePersistSnapshot(next)
  }
  for (const listener of listeners) listener(snapshot)
}

export function clearPluginMarketplaceCache(): void {
  clearPersistTimer()
  pendingPersist = null
  lastPersistedSignature = ''
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
  flushPluginMarketplaceCachePersist()
  snapshot = null
}

function pluginComponentsSignature(components: PluginMarketplaceItem['components']): string {
  return JSON.stringify(slimPluginComponentsForCache(components))
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
        item.installedVersion ?? '',
        item.installedPluginId ?? '',
        item.updateAvailable ? '1' : '0',
        item.enabled ? '1' : '0',
        item.grantUserCount ?? 0,
        item.grantNamespaceCount ?? 0,
        item.accessRole ?? '',
        item.allowCopy ? '1' : '0',
        item.latestReleaseId ?? '',
        item.interface?.logo ?? '',
        item.interface?.displayName ?? '',
        item.currentDeviceInstallation?.state ?? '',
        item.currentDeviceInstallation?.errorMessage ?? '',
        item.currentDeviceInstallation?.actualReleaseId ?? '',
        // Codex remote lock state — must invalidate SWR equality when admin/plan
        // availability changes after a durable peek painted the unlocked card.
        typeof item.manifest?.availability === 'string' ? item.manifest.availability : '',
        typeof item.manifest?.disabledReason === 'string' ? item.manifest.disabledReason : '',
        typeof item.manifest?.installPolicy === 'string' ? item.manifest.installPolicy : '',
        item.localPersonalSource?.marketplacePath ?? '',
        item.localPersonalSource?.pluginName ?? '',
        pluginComponentsSignature(item.components),
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
        pluginComponentsSignature(item.raw.spec.components),
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
