import type { InstalledPlugin, PluginMarketplaceItem } from '@/types/api'
import { isPersonalMarketplaceId } from '@/features/plugins/builtinPlugins'
import { isBuiltInMarketplaceId } from '@/features/plugins/marketplaceIdentity'
import { marketplaceItemMarketplaceId } from './pluginDistribution'
import { linkedCloudPluginId, localPluginId } from './installedPluginMerge'

export function isLocalMarketplaceItem(item: PluginMarketplaceItem): boolean {
  if (item.latestReleaseId != null) return false
  return marketplaceItemMarketplaceId(item) !== null
}

function isDiskPersonalMarketplaceItem(item: PluginMarketplaceItem): boolean {
  return String(item.id).startsWith('personal-disk:')
}

/**
 * Collapse wework-personal / personal aliases so disk bypass and Codex plugin/list
 * do not paint the same created plugin twice.
 */
export function localMarketplaceDedupeKey(item: PluginMarketplaceItem): string {
  const name = item.name.trim().toLowerCase()
  const marketplaceId = marketplaceItemMarketplaceId(item)
  if (marketplaceId && isPersonalMarketplaceId(marketplaceId)) {
    return `personal:${name}`
  }
  return `${(marketplaceId || 'unknown').toLowerCase()}:${name}`
}

function withDiskInstallHints(
  primary: PluginMarketplaceItem,
  disk: PluginMarketplaceItem
): PluginMarketplaceItem {
  if (!disk.installed && !disk.installedLocally) return primary
  return {
    ...primary,
    installed: true,
    installedLocally: true,
    installedPluginId: primary.installedPluginId || disk.installedPluginId,
    enabled: primary.enabled || disk.enabled,
  }
}

function preferLocalMarketplaceItem(
  current: PluginMarketplaceItem,
  candidate: PluginMarketplaceItem
): PluginMarketplaceItem {
  const currentIsDisk = isDiskPersonalMarketplaceItem(current)
  const candidateIsDisk = isDiskPersonalMarketplaceItem(candidate)
  if (currentIsDisk && !candidateIsDisk) {
    return withDiskInstallHints(candidate, current)
  }
  if (!currentIsDisk && candidateIsDisk) {
    return withDiskInstallHints(current, candidate)
  }
  if (candidate.installed && !current.installed) return candidate
  return current
}

/** Prefer Codex/local rows; keep disk-personal extras that are not in the primary list yet. */
export function mergeDiskPersonalIntoLocalRows(
  localRows: PluginMarketplaceItem[],
  diskPersonalItems: PluginMarketplaceItem[] | null | undefined
): PluginMarketplaceItem[] {
  if (!diskPersonalItems?.length) return localRows
  if (!localRows.length) return diskPersonalItems

  const byKey = new Map<string, PluginMarketplaceItem>()
  for (const item of localRows) {
    const key = localMarketplaceDedupeKey(item)
    const existing = byKey.get(key)
    byKey.set(key, existing ? preferLocalMarketplaceItem(existing, item) : item)
  }
  for (const item of diskPersonalItems) {
    const key = localMarketplaceDedupeKey(item)
    const existing = byKey.get(key)
    byKey.set(key, existing ? preferLocalMarketplaceItem(existing, item) : item)
  }
  return Array.from(byKey.values())
}

export function shouldShowInstalledMarketplaceActions(
  item: PluginMarketplaceItem,
  isLoggedIn: boolean
): boolean {
  return item.installed && (isLoggedIn || item.installedLocally || isLocalMarketplaceItem(item))
}

export function mergeMarketplaceCatalog(
  cloudItems: PluginMarketplaceItem[],
  localItems: PluginMarketplaceItem[],
  installedPlugins: InstalledPlugin[]
): PluginMarketplaceItem[] {
  const localPublishedInstalls = new Map<string, InstalledPlugin>()
  for (const plugin of installedPlugins) {
    const cloudPluginId = linkedCloudPluginId(plugin)
    if (cloudPluginId !== null && localPluginId(plugin) !== null) {
      localPublishedInstalls.set(String(cloudPluginId), plugin)
    }
  }

  const merged = new Map<string, PluginMarketplaceItem>()
  const cloudNames = new Set<string>()
  for (const item of cloudItems) {
    const localInstall = localPublishedInstalls.get(String(item.id))
    // Cloud catalog ids are unique; never collapse distinct plugins by display name.
    merged.set(`cloud:${item.id}`, {
      ...item,
      ...(localInstall
        ? {
            installed: true,
            installedPluginId: localPluginId(localInstall),
            installedLocally: true,
            enabled: localInstall.spec.enabled,
            updateAvailable: false,
            currentDeviceInstallation: null,
          }
        : {}),
    })
    cloudNames.add(item.name.toLowerCase())
  }
  for (const item of localItems) {
    const marketplaceId = marketplaceItemMarketplaceId(item)
    if (marketplaceId && !isBuiltInMarketplaceId(marketplaceId)) {
      const key = `local:${marketplaceId.toLowerCase()}:${item.name.toLowerCase()}`
      const existing = merged.get(key)
      merged.set(key, existing ? preferLocalMarketplaceItem(existing, item) : item)
      continue
    }
    // Built-in local mirrors of a cloud listing are already represented above.
    if (cloudNames.has(item.name.toLowerCase())) continue
    // Personal aliases (wework-personal / personal) share one catalog slot.
    const key =
      marketplaceId && isPersonalMarketplaceId(marketplaceId)
        ? `local-personal:${item.name.toLowerCase()}`
        : `local-builtin:${(marketplaceId || 'unknown').toLowerCase()}:${item.name.toLowerCase()}`
    const existing = merged.get(key)
    merged.set(key, existing ? preferLocalMarketplaceItem(existing, item) : item)
  }
  return Array.from(merged.values())
}
