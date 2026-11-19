import { emptyComponents } from '@wegent/chat-core/codex-installed-plugins'
import { decompressFromUTF16 } from 'lz-string'
import {
  clearOpenAiCatalogStorage,
  commitLocalStorageValue,
  readOpenAiCatalogStorage,
  REMOTE_PLUGIN_CATALOG_STORAGE_KEY,
} from '@/desktop/localStoragePersistence'
import type { PluginInterface, PluginMarketplaceItem } from '@/types/api'
import { isOpenAiOfficialRemoteMarketplaceId } from '@/features/plugins/marketplaceIdentity'
import { raceWithTimeout } from '@/lib/promise-timeout'

export const REMOTE_PLUGIN_CATALOG_FRESH_MS = 30 * 60_000
const COMPACT_CATALOG_PREFIX = 'lz:'

export interface RemotePluginCatalogSnapshot {
  items: PluginMarketplaceItem[]
  fetchedAt: number
}

export class RemotePluginCatalogIdentityChanged extends Error {
  constructor() {
    super('Plugin catalog scope changed')
  }
}

export class RemotePluginCatalogStorageError extends Error {
  constructor(cause: unknown) {
    super('Could not save the OpenAI plugin catalog', { cause })
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
    item.id.trim().length > 0 &&
    typeof item.name === 'string' &&
    item.name.trim().length > 0 &&
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
    const raw = readOpenAiCatalogStorage()
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

async function persistCatalog(
  snapshot: PersistedCatalog,
  assertCurrent: () => void
): Promise<void> {
  try {
    await commitLocalStorageValue(REMOTE_PLUGIN_CATALOG_STORAGE_KEY, JSON.stringify(snapshot), {
      assertCurrent,
    })
  } catch (error) {
    if (error instanceof RemotePluginCatalogIdentityChanged) throw error
    console.warn('[Wework] Failed to persist OpenAI plugin catalog', {
      errorType: error instanceof Error ? error.name : typeof error,
    })
    throw new RemotePluginCatalogStorageError(error)
  }
}

/** Catalog freshness survives renderer and runtime restarts. */
export function createSharedRemotePluginCatalog() {
  let active: { identity: string; pending?: Promise<RemotePluginCatalogSnapshot> } | undefined
  let latest: PersistedCatalog | undefined

  function hasSnapshotOrRefresh(): boolean {
    return Boolean(latest || active?.pending || readOpenAiCatalogStorage())
  }

  function read({
    scope,
    requestIdentity,
    force,
    cacheOnly,
    onCached,
    load,
    isAccountCurrent,
  }: {
    scope: string
    requestIdentity: string
    force: boolean
    cacheOnly: boolean
    onCached: (snapshot: RemotePluginCatalogSnapshot | undefined) => void
    load: (cached: RemotePluginCatalogSnapshot | undefined) => Promise<PluginMarketplaceItem[]>
    isAccountCurrent?: () => boolean
  }): Promise<RemotePluginCatalogSnapshot | undefined> {
    const requestScope =
      active?.identity === requestIdentity ? active : { identity: requestIdentity }
    const assertCurrent = () => {
      if (active !== requestScope || isAccountCurrent?.() === false)
        throw new RemotePluginCatalogIdentityChanged()
    }
    active = requestScope
    if (latest?.scope !== scope) {
      latest = readPersistedCatalog(scope)
    }
    const cached = latest
    onCached(cached)
    if (requestScope.pending) return requestScope.pending
    if (cacheOnly) return Promise.resolve(cached)
    if (!force && cached && Date.now() - cached.fetchedAt < REMOTE_PLUGIN_CATALOG_FRESH_MS) {
      return Promise.resolve(cached)
    }
    const request = raceWithTimeout(
      Promise.resolve().then(() => load(cached)),
      30_000,
      () => new Error('Remote plugin catalog timed out')
    ).then(async items => {
      assertCurrent()
      if ((cached?.items.length && items.length === 0) || !items.every(isCatalogItem))
        throw new Error('Incomplete remote plugin catalog')
      const result: PersistedCatalog = { version: 1, scope, fetchedAt: Date.now(), items }
      await persistCatalog(result, assertCurrent)
      assertCurrent()
      latest = result
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
    clearOpenAiCatalogStorage()
  }

  return { read, clear, hasSnapshotOrRefresh }
}

export const openAiRemoteCatalog = createSharedRemotePluginCatalog()
