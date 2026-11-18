import { emptyComponents } from '@wegent/chat-core/codex-installed-plugins'
import { compressToUTF16, decompressFromUTF16 } from 'lz-string'
import type { PluginInterface, PluginMarketplaceItem } from '@/types/api'
import { isOpenAiOfficialRemoteMarketplaceId } from '@/features/plugins/marketplaceIdentity'
import { raceWithTimeout } from '@/lib/promise-timeout'

export const REMOTE_PLUGIN_CATALOG_STORAGE_KEY = 'wework.plugins.openAiCatalog.v1'
export const REMOTE_PLUGIN_CATALOG_FRESH_MS = 30 * 60_000
const COMPACT_CATALOG_PREFIX = 'lz:'
const MAX_INLINE_ASSET_LENGTH = 4096

export interface RemotePluginCatalogSnapshot {
  items: PluginMarketplaceItem[]
  fetchedAt: number
}

export class RemotePluginCatalogIdentityChanged extends Error {
  constructor() {
    super('Plugin catalog scope changed')
  }
}

interface PersistedCatalog extends RemotePluginCatalogSnapshot {
  version: 1
  scope: string
}

export function isOpenAiOfficialRemoteMarketplaceItem(item: PluginMarketplaceItem): boolean {
  const marketplaceId = item.manifest?.marketplaceId
  return typeof marketplaceId === 'string' && isOpenAiOfficialRemoteMarketplaceId(marketplaceId)
}

const catalogInterfaceTextFields = [
  'displayName',
  'shortDescription',
  'longDescription',
  'developerName',
  'category',
  'websiteUrl',
  'privacyPolicyUrl',
  'termsOfServiceUrl',
  'brandColor',
  'composerIcon',
  'logo',
  'logoDark',
] as const satisfies readonly (keyof PluginInterface)[]
const catalogInterfaceListFields = ['capabilities', 'defaultPrompt', 'screenshots'] as const

function isOptionalText(value: unknown): boolean {
  return value == null || typeof value === 'string'
}

function isCatalogInterface(value: unknown): boolean {
  if (value == null) return true
  if (typeof value !== 'object' || Array.isArray(value)) return false
  const fields = value as Record<string, unknown>
  return (
    catalogInterfaceTextFields.every(field => isOptionalText(fields[field])) &&
    catalogInterfaceListFields.every(field => {
      const list = fields[field]
      return list == null || (Array.isArray(list) && list.every(item => typeof item === 'string'))
    })
  )
}

const catalogComponentFields = Object.keys(emptyComponents())

function isCatalogSummaryComponents(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const components = value as Record<string, unknown>
  return (
    catalogComponentFields.every(field => field in components) &&
    Object.values(components).every(list => Array.isArray(list) && list.length === 0)
  )
}

function isCatalogItem(value: unknown): value is PluginMarketplaceItem {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const item = value as Partial<PluginMarketplaceItem>
  return (
    typeof item.id === 'string' &&
    typeof item.name === 'string' &&
    typeof item.displayName === 'string' &&
    typeof item.description === 'string' &&
    typeof item.remotePluginId === 'string' &&
    [item.version, item.author, item.ownerDisplayName, item.sourceLabel].every(isOptionalText) &&
    item.visibility === 'public' &&
    typeof item.featured === 'boolean' &&
    item.installed === false &&
    item.enabled === false &&
    item.installedPluginId == null &&
    item.installedLocally == null &&
    item.installedVersion == null &&
    item.updateAvailable == null &&
    item.currentDeviceInstallation == null &&
    item.sourceType === 'marketplace' &&
    item.sourceProvider === 'codex' &&
    isCatalogInterface(item.interface) &&
    isCatalogSummaryComponents(item.components) &&
    isOpenAiOfficialRemoteMarketplaceItem(item as PluginMarketplaceItem)
  )
}

function readPersistedCatalog(scope: string): PersistedCatalog | undefined {
  try {
    const raw = window.localStorage.getItem(REMOTE_PLUGIN_CATALOG_STORAGE_KEY)
    if (!raw) return
    const serialized = raw.startsWith(COMPACT_CATALOG_PREFIX)
      ? decompressFromUTF16(raw.slice(COMPACT_CATALOG_PREFIX.length))
      : raw
    if (!serialized) return
    const value = JSON.parse(serialized) as Partial<PersistedCatalog> | null
    if (
      value?.version === 1 &&
      value.scope === scope &&
      typeof value.fetchedAt === 'number' &&
      Number.isFinite(value.fetchedAt) &&
      value.fetchedAt > 0 &&
      value.fetchedAt <= Date.now() &&
      Array.isArray(value.items) &&
      value.items.every(isCatalogItem)
    ) {
      return value as PersistedCatalog
    }
  } catch {
    // An unreadable entry is rebuilt from the next successful directory read.
  }
}

function compactInterface(value: PluginInterface | null | undefined) {
  if (!value) return value
  const keepAsset = (asset: string | null | undefined) =>
    asset?.startsWith('data:') && asset.length > MAX_INLINE_ASSET_LENGTH ? null : asset
  return {
    ...value,
    logo: keepAsset(value.logo),
    logoDark: keepAsset(value.logoDark),
    composerIcon: keepAsset(value.composerIcon),
    screenshots: value.screenshots?.filter(asset => keepAsset(asset) != null),
  }
}

function persistCatalog(snapshot: PersistedCatalog): boolean {
  try {
    const storage = window.localStorage
    try {
      storage.setItem(REMOTE_PLUGIN_CATALOG_STORAGE_KEY, JSON.stringify(snapshot))
    } catch (error) {
      if (!(error instanceof DOMException) || error.name !== 'QuotaExceededError') throw error
      const compact = {
        ...snapshot,
        items: snapshot.items.map(item => ({
          ...item,
          interface: compactInterface(item.interface),
        })),
      }
      storage.setItem(
        REMOTE_PLUGIN_CATALOG_STORAGE_KEY,
        COMPACT_CATALOG_PREFIX + compressToUTF16(JSON.stringify(compact))
      )
    }
    return true
  } catch (error) {
    console.warn('[Wework] Failed to persist OpenAI plugin catalog', {
      errorType: error instanceof Error ? error.name : typeof error,
    })
    return false
  }
}

/** Catalog freshness survives renderer and runtime restarts. */
export function createSharedRemotePluginCatalog() {
  let active: { identity: string; pending?: Promise<RemotePluginCatalogSnapshot> } | undefined
  let latest: PersistedCatalog | undefined
  let needsPersistence = false

  function hasSnapshotOrRefresh(): boolean {
    if (latest || active?.pending) return true
    try {
      return window.localStorage.getItem(REMOTE_PLUGIN_CATALOG_STORAGE_KEY) !== null
    } catch {
      return false
    }
  }

  function read({
    scope,
    requestIdentity,
    force,
    cacheOnly,
    onCached,
    load,
  }: {
    scope: string
    requestIdentity: string
    force: boolean
    cacheOnly: boolean
    onCached: (snapshot: RemotePluginCatalogSnapshot | undefined) => void
    load: (cached: RemotePluginCatalogSnapshot | undefined) => Promise<PluginMarketplaceItem[]>
  }): Promise<RemotePluginCatalogSnapshot | undefined> {
    const requestScope =
      active?.identity === requestIdentity ? active : { identity: requestIdentity }
    active = requestScope
    if (latest?.scope !== scope) {
      latest = readPersistedCatalog(scope)
      needsPersistence = false
    }
    const cached = latest
    onCached(cached)
    if (requestScope.pending) return requestScope.pending
    if (cached && needsPersistence) needsPersistence = !persistCatalog(cached)
    if (cacheOnly) return Promise.resolve(cached)
    if (!force && cached && Date.now() - cached.fetchedAt < REMOTE_PLUGIN_CATALOG_FRESH_MS) {
      return Promise.resolve(cached)
    }
    const request = raceWithTimeout(
      Promise.resolve().then(() => load(cached)),
      30_000,
      () => new Error('Remote plugin catalog timed out')
    ).then(items => {
      if (active !== requestScope) throw new Error('Plugin catalog scope changed')
      if ((cached?.items.length && items.length === 0) || !items.every(isCatalogItem))
        throw new Error('Incomplete remote plugin catalog')
      const result: PersistedCatalog = { version: 1, scope, fetchedAt: Date.now(), items }
      latest = result
      needsPersistence = !persistCatalog(result)
      return result
    })
    requestScope.pending = request
    const settled = () => {
      requestScope.pending = undefined
    }
    void request.then(settled, settled)
    return request
  }

  function clear() {
    active = undefined
    latest = undefined
    needsPersistence = false
    if (typeof window === 'undefined') return
    try {
      window.localStorage.removeItem(REMOTE_PLUGIN_CATALOG_STORAGE_KEY)
    } catch (error) {
      console.warn('[Wework] Failed to clear OpenAI plugin catalog', {
        errorType: error instanceof Error ? error.name : typeof error,
      })
    }
  }

  return { read, clear, hasSnapshotOrRefresh }
}

export const openAiRemoteCatalog = createSharedRemotePluginCatalog()
