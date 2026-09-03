import type { InstalledPlugin, PluginMarketplaceItem } from '@/types/api'
import { applyInstalledPluginsToMarketplaceItems } from '@/api/local/codexPlugins'
import { isPersonalMarketplaceId } from '@/features/plugins/builtinPlugins'
import { isBuiltInMarketplaceId } from '@/features/plugins/marketplaceIdentity'
import { marketplaceItemMarketplaceId } from './pluginDistribution'
import {
  hasLocalCodexMaterialization,
  linkedCloudPluginId,
  localMaterializedVersion,
  localPluginId,
} from './installedPluginMerge'

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

function preferLocalMarketplaceItem(
  current: PluginMarketplaceItem,
  candidate: PluginMarketplaceItem
): PluginMarketplaceItem {
  const currentIsDisk = isDiskPersonalMarketplaceItem(current)
  const candidateIsDisk = isDiskPersonalMarketplaceItem(candidate)
  if (currentIsDisk && !candidateIsDisk) {
    return candidate
  }
  if (!currentIsDisk && candidateIsDisk) {
    return current
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
  const cloudManagedInstalls = new Map<string, InstalledPlugin>()
  for (const plugin of installedPlugins) {
    const cloudPluginId = linkedCloudPluginId(plugin)
    if (
      cloudPluginId !== null &&
      localPluginId(plugin) !== null &&
      typeof plugin.spec.pluginId !== 'number'
    ) {
      localPublishedInstalls.set(String(cloudPluginId), plugin)
    }
    // Account installs from /installed-plugins carry spec.pluginId == catalog id.
    // After install, a marketplace refresh can still return installed:false on the
    // cloud row; overlay from the installed list so the card shows "..." immediately.
    if (typeof plugin.spec.pluginId === 'number') {
      cloudManagedInstalls.set(String(plugin.spec.pluginId), plugin)
    }
  }

  const merged = new Map<string, PluginMarketplaceItem>()
  const cloudNames = new Set<string>()
  const cloudKeysByCatalogId = new Map<string, string>()
  const ownedPersonalCloudKeysByName = new Map<string, string>()
  for (const item of cloudItems) {
    const localInstall = localPublishedInstalls.get(String(item.id))
    const cloudInstall = localInstall ? undefined : cloudManagedInstalls.get(String(item.id))
    const matchedInstall = localInstall ?? cloudInstall
    const installedVersion = matchedInstall
      ? localMaterializedVersion(matchedInstall) ||
        (typeof matchedInstall.spec.pluginId !== 'number'
          ? matchedInstall.spec.version?.trim() || null
          : null)
      : null
    const catalogVersion = (item.version ?? '').trim()
    const localVersionLags = Boolean(
      installedVersion && catalogVersion && installedVersion !== catalogVersion
    )
    // Cloud catalog ids are unique; never collapse distinct plugins by display name.
    const cloudKey = `cloud:${item.id}`
    merged.set(cloudKey, {
      ...item,
      ...(matchedInstall
        ? {
            installed: true,
            installedPluginId: localPluginId(matchedInstall) ?? item.installedPluginId,
            installedLocally:
              Boolean(localInstall) ||
              Boolean(item.installedLocally) ||
              hasLocalCodexMaterialization(matchedInstall),
            installedVersion,
            enabled: matchedInstall.spec.enabled,
            updateAvailable:
              item.updateAvailable ||
              matchedInstall.spec.installState === 'update_available' ||
              localVersionLags,
            currentDeviceInstallation: localInstall ? null : item.currentDeviceInstallation,
          }
        : {}),
    })
    const normalizedName = item.name.toLowerCase()
    cloudNames.add(normalizedName)
    cloudKeysByCatalogId.set(String(item.id), cloudKey)
    if (
      item.accessRole === 'owner' &&
      (item.visibility === 'personal' || item.sourceProvider === 'user')
    ) {
      ownedPersonalCloudKeysByName.set(normalizedName, cloudKey)
    }
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
    const normalizedName = item.name.toLowerCase()
    if (cloudNames.has(normalizedName)) {
      const matchingCloudKey = cloudKeysByCatalogId.get(String(item.id))
      if (matchingCloudKey) {
        const cloudItem = merged.get(matchingCloudKey)
        if (cloudItem && item.installedLocally && item.installedVersion) {
          merged.set(matchingCloudKey, {
            ...cloudItem,
            installedLocally: true,
            installedVersion: item.installedVersion,
          })
        }
      }
      const ownedCloudKey = ownedPersonalCloudKeysByName.get(normalizedName)
      const marketplacePath = item.manifest?.marketplacePath
      if (
        ownedCloudKey &&
        marketplaceId &&
        isPersonalMarketplaceId(marketplaceId) &&
        typeof marketplacePath === 'string' &&
        marketplacePath.trim()
      ) {
        const cloudItem = merged.get(ownedCloudKey)
        if (cloudItem) {
          merged.set(ownedCloudKey, {
            ...cloudItem,
            // The owned personal card represents the editable local source. The
            // cloud row can still describe an older shared/published release, so
            // keep the card aligned with the version that detail and publication
            // flows will actually package.
            version: item.version || cloudItem.version,
            localPersonalSource: {
              marketplacePath: marketplacePath.trim(),
              pluginName: item.name,
            },
          })
        }
      }
      continue
    }
    // Personal aliases (wework-personal / personal) share one catalog slot.
    const key =
      marketplaceId && isPersonalMarketplaceId(marketplaceId)
        ? `local-personal:${normalizedName}`
        : `local-builtin:${(marketplaceId || 'unknown').toLowerCase()}:${normalizedName}`
    const existing = merged.get(key)
    merged.set(key, existing ? preferLocalMarketplaceItem(existing, item) : item)
  }
  // Local Codex catalogs (e.g. openai-curated-remote) can lag behind the installed
  // list after plugin/install. Overlay by name@marketplace so cards flip off
  // "安装" as soon as the strip shows the plugin.
  return applyInstalledPluginsToMarketplaceItems(Array.from(merged.values()), installedPlugins)
}
