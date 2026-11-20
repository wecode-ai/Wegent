import { emptyComponents } from '@wegent/chat-core/codex-installed-plugins'
import { invokeDesktopHost } from '@/api/dsh/desktopHost'
import { isElectronRuntime } from '@/lib/runtime-environment'
import type { PluginInterface, PluginMarketplaceItem } from '@/types/api'
import { isOpenAiOfficialRemoteMarketplaceId } from '@/features/plugins/marketplaceIdentity'
import { raceWithTimeout } from '@/lib/promise-timeout'

export const REMOTE_PLUGIN_CATALOG_FRESH_MS = 30 * 60_000

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

async function readPersistedCatalog(): Promise<PersistedCatalog | undefined> {
  const raw = await invokeDesktopHost<string | null>('pluginCatalog.readOpenAi')
  if (!raw) return
  try {
    const value = JSON.parse(raw) as Partial<PersistedCatalog> | null
    if (
      value?.version === 1 &&
      typeof value.scope === 'string' &&
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

/** Catalog freshness survives renderer and runtime restarts. */
export function createSharedRemotePluginCatalog() {
  let active: { identity: string; pending?: Promise<RemotePluginCatalogSnapshot> } | undefined
  let stored: Promise<PersistedCatalog | undefined> | undefined
  let diskMutations = Promise.resolve()

  function mutateDisk(operation: () => Promise<void>): Promise<void> {
    const result = diskMutations.then(operation)
    diskMutations = result.catch(() => {})
    return result
  }

  function readStored(): Promise<PersistedCatalog | undefined> {
    // A new account must wait for any queued invalidation before reading the file.
    if (stored) return stored
    const read = diskMutations.then(readPersistedCatalog).catch(error => {
      if (stored === read) stored = undefined
      console.warn('[Wework] Failed to read OpenAI plugin catalog', {
        errorType: error instanceof Error ? error.name : typeof error,
      })
      return undefined
    })
    stored = read
    return read
  }

  async function persistCatalog(snapshot: PersistedCatalog, assertCurrent: () => void) {
    await mutateDisk(async () => {
      assertCurrent()
      try {
        await invokeDesktopHost('pluginCatalog.writeOpenAi', {
          snapshot: JSON.stringify(snapshot),
        })
      } catch (error) {
        console.warn('[Wework] Failed to persist OpenAI plugin catalog', {
          errorType: error instanceof Error ? error.name : typeof error,
        })
        throw new RemotePluginCatalogStorageError(error)
      }
      assertCurrent()
      stored = Promise.resolve(snapshot)
    })
  }

  async function hasSnapshotOrRefresh(): Promise<boolean> {
    return Boolean(active?.pending || (await readStored()))
  }

  async function read({
    scope,
    requestIdentity,
    force,
    cacheOnly,
    onCached,
    load,
    isAccountCurrent,
    canStart,
  }: {
    scope: string
    requestIdentity: string
    force: boolean
    cacheOnly: boolean
    onCached: (snapshot: RemotePluginCatalogSnapshot | undefined) => void
    load: (cached: RemotePluginCatalogSnapshot | undefined) => Promise<PluginMarketplaceItem[]>
    isAccountCurrent?: () => boolean
    canStart?: () => boolean
  }): Promise<RemotePluginCatalogSnapshot | undefined> {
    const requestScope =
      active?.identity === requestIdentity ? active : { identity: requestIdentity }
    const assertCurrent = () => {
      if (active !== requestScope || isAccountCurrent?.() === false)
        throw new RemotePluginCatalogIdentityChanged()
    }
    active = requestScope
    const snapshot = await readStored()
    assertCurrent()
    if (canStart?.() === false) throw new RemotePluginCatalogIdentityChanged()
    const cached = snapshot?.scope === scope ? snapshot : undefined
    onCached(cached)
    if (requestScope.pending) return requestScope.pending
    if (cacheOnly) return cached
    if (!force && cached && Date.now() - cached.fetchedAt < REMOTE_PLUGIN_CATALOG_FRESH_MS) {
      return cached
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
    stored = undefined
    if (isElectronRuntime()) {
      void mutateDisk(() => invokeDesktopHost('pluginCatalog.clearOpenAi')).catch(error => {
        console.warn('[Wework] Failed to clear OpenAI plugin catalog', {
          errorType: error instanceof Error ? error.name : typeof error,
        })
      })
    }
  }

  return { read, clear, hasSnapshotOrRefresh }
}

export const openAiRemoteCatalog = createSharedRemotePluginCatalog()
