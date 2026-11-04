import {
  isCloudManagedInstalledPlugin,
  localMatchesCloudPlugin,
  localPluginId,
  mergeLocalInstalledWithStorePackages,
  pluginIdentity,
} from '@wegent/chat-core/installed-plugin-merge'
import { isPersonalMarketplaceId } from '@wegent/chat-core/personal-plugin-identity'
import type { InstalledPlugin } from '@/types/api'

export type LocalPluginInventorySource = 'codex' | 'store' | 'personal'
export type LocalPluginInventorySourceStatus = 'fulfilled' | 'rejected'
export type LocalInstalledSources = Partial<Record<LocalPluginInventorySource, string[]>>
export type LocalInstalledSourceStatus = Partial<
  Record<LocalPluginInventorySource, LocalPluginInventorySourceStatus>
>
export type LocalPluginSourceItems = Partial<Record<LocalPluginInventorySource, InstalledPlugin[]>>

export interface LocalPluginInventoryRead {
  items: InstalledPlugin[]
  deviceId?: string
  partial?: boolean
  sourceReads?: Partial<
    Record<
      LocalPluginInventorySource,
      { status: LocalPluginInventorySourceStatus; items?: InstalledPlugin[] }
    >
  >
}

interface InventorySnapshot {
  deviceId: string
  installedPlugins: InstalledPlugin[]
  localInstalledSources?: LocalInstalledSources
  localInstalledSourceStatus?: LocalInstalledSourceStatus
}

const sources: LocalPluginInventorySource[] = ['codex', 'store', 'personal']

/** Source membership can change without changing the displayed canonical record. */
export function sameLocalPluginSources(
  left:
    | Pick<InventorySnapshot, 'localInstalledSources' | 'localInstalledSourceStatus'>
    | null
    | undefined,
  right:
    | Pick<InventorySnapshot, 'localInstalledSources' | 'localInstalledSourceStatus'>
    | null
    | undefined
): boolean {
  return sources.every(
    source =>
      JSON.stringify(left?.localInstalledSources?.[source]?.slice().sort()) ===
        JSON.stringify(right?.localInstalledSources?.[source]?.slice().sort()) &&
      left?.localInstalledSourceStatus?.[source] === right?.localInstalledSourceStatus?.[source]
  )
}

/** Keep canonical membership identities independent of display or package versions. */
export function inventoryIdentity(plugin: InstalledPlugin): string {
  return plugin.spec.pluginId != null
    ? `cloud:${plugin.spec.pluginId}`
    : `${plugin.spec.source.marketplace || plugin.spec.source.providerKey}:${plugin.spec.source.pluginKey}`
}

function isPersonal(plugin: InstalledPlugin): boolean {
  const marketplace =
    plugin.spec.source.marketplace || plugin.spec.source.providerKey || plugin.metadata.namespace
  return typeof marketplace === 'string' && isPersonalMarketplaceId(marketplace)
}

/** Older flat snapshots can establish only ownership recorded in their routing metadata. */
function legacySourceItems(plugins: InstalledPlugin[], freshLocal = false): LocalPluginSourceItems {
  const result: LocalPluginSourceItems = { codex: [], store: [], personal: [] }
  for (const plugin of plugins) {
    const payload = plugin.spec.sourcePayload
    const managed =
      payload?.managedByWegent === true ||
      (isCloudManagedInstalledPlugin(plugin) && payload?.localPresent === true)
    if (managed) result.store!.push(plugin)
    if (isPersonal(plugin)) result.personal!.push(plugin)
    else if (
      (freshLocal || !isCloudManagedInstalledPlugin(plugin)) &&
      (!managed || String(payload?.pluginId || localPluginId(plugin) || '').includes('@'))
    )
      result.codex!.push(plugin)
  }
  return result
}

function matchesCanonical(raw: InstalledPlugin, canonical: InstalledPlugin): boolean {
  if (isCloudManagedInstalledPlugin(raw) && isCloudManagedInstalledPlugin(canonical))
    return raw.spec.pluginId === canonical.spec.pluginId
  if (isCloudManagedInstalledPlugin(canonical)) return localMatchesCloudPlugin(raw, canonical)
  if (isCloudManagedInstalledPlugin(raw)) return localMatchesCloudPlugin(canonical, raw)
  return (
    inventoryIdentity(raw) === inventoryIdentity(canonical) ||
    Boolean(pluginIdentity(raw) && pluginIdentity(raw) === pluginIdentity(canonical)) ||
    Boolean(localPluginId(raw) && localPluginId(raw) === localPluginId(canonical))
  )
}

/** Resolve native/store ownership after a cloud merge changes the displayed record ID. */
export function indexLocalPluginSources(
  finalCanonical: InstalledPlugin[],
  rawSources: LocalPluginSourceItems,
  deviceId: string
): LocalInstalledSources {
  if (!deviceId) return {}
  const result: LocalInstalledSources = {}
  for (const source of sources) {
    const rows = rawSources[source]
    if (!rows) continue
    result[source] = finalCanonical
      .filter(canonical => rows.some(raw => matchesCanonical(raw, canonical)))
      .map(inventoryIdentity)
  }
  return result
}

export function localPluginSourceItems(snapshot: InventorySnapshot | null): LocalPluginSourceItems {
  if (!snapshot) return {}
  if (!snapshot.localInstalledSources) return legacySourceItems(snapshot.installedPlugins)
  const result: LocalPluginSourceItems = {}
  for (const source of sources) {
    const ids = snapshot.localInstalledSources[source]
    if (Array.isArray(ids)) {
      const members = new Set(ids)
      result[source] = snapshot.installedPlugins.filter(plugin =>
        members.has(inventoryIdentity(plugin))
      )
    }
  }
  return result
}

/** Successful sources replace their own rows; a failed read cannot establish absence. */
export function resolveLocalPluginInventory(
  previousSnapshot: InventorySnapshot | null,
  read: LocalPluginInventoryRead,
  deviceId: string
): {
  items: InstalledPlugin[]
  sourceItems: LocalPluginSourceItems
  localInstalledSources: LocalInstalledSources
  localInstalledSourceStatus: LocalInstalledSourceStatus
} {
  if (deviceId && read.deviceId && deviceId !== read.deviceId)
    throw new Error('Local plugin device changed during refresh')
  if (read.partial && !read.sourceReads)
    throw new Error('Partial local inventory requires source read results')
  const currentDeviceId = deviceId || read.deviceId || ''
  const previous =
    currentDeviceId && previousSnapshot?.deviceId === currentDeviceId ? previousSnapshot : null
  const sourceItems = localPluginSourceItems(previous)
  const sourceReads =
    read.sourceReads ??
    Object.fromEntries(
      Object.entries(legacySourceItems(read.items, true)).map(([source, items]) => [
        source,
        { status: 'fulfilled' as const, items },
      ])
    )
  const localInstalledSourceStatus: LocalInstalledSourceStatus = {
    ...previous?.localInstalledSourceStatus,
  }
  for (const source of sources) {
    const result = sourceReads[source]
    if (!result) continue
    if (result.status !== 'fulfilled' && result.status !== 'rejected')
      throw new Error(`Invalid ${source} plugin source status`)
    localInstalledSourceStatus[source] = result.status
    if (result.status === 'fulfilled') {
      if (!Array.isArray(result.items)) throw new Error(`Invalid ${source} plugin source`)
      sourceItems[source] = result.items
    }
  }
  // Codex membership covers the personal market too. A newer full Codex read
  // supersedes an earlier disk override, including a previous successful empty.
  if (sourceReads.codex?.status === 'fulfilled' && sourceReads.personal?.status !== 'fulfilled') {
    delete sourceItems.personal
    delete localInstalledSourceStatus.personal
  }
  if (sourceReads.personal?.status === 'fulfilled')
    sourceItems.codex = (sourceItems.codex ?? []).filter(plugin => !isPersonal(plugin))
  const items = mergeLocalInstalledWithStorePackages(
    [...(sourceItems.codex ?? []), ...(sourceItems.personal ?? [])],
    sourceItems.store ?? []
  )
  return {
    items,
    sourceItems,
    localInstalledSources: indexLocalPluginSources(items, sourceItems, currentDeviceId),
    localInstalledSourceStatus,
  }
}
