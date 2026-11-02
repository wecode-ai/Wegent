import type { PluginMarketplaceItem } from '@/types/api'
import type { InstalledPluginItem } from './PluginManagementRows'
import { isWegentManagedStorePlugin } from './installedPluginMerge'

/**
 * Local created packages belong to the current user. Recipient/catalog cloud
 * listings must not inherit owner actions just because a name matches.
 */
export function marketplaceItemOwnsLocalCreatedPackage(
  item: Pick<PluginMarketplaceItem, 'accessRole' | 'latestReleaseId' | 'visibility'>
): boolean {
  if (item.accessRole === 'owner') return true
  if (item.accessRole === 'recipient' || item.accessRole === 'catalog') return false
  return item.visibility === 'personal' && item.latestReleaseId == null
}

/** Local plugins that can be edited / packaged for publish. */
export function isPackableCreatedPlugin(plugin: InstalledPluginItem): boolean {
  return (
    !isWegentManagedStorePlugin(plugin.raw) &&
    (plugin.origin === 'created' || plugin.raw.spec.source.type === 'local')
  )
}

export function createdPluginSlugFromKey(pluginKey: string): string {
  return pluginKey.toLowerCase().replace(/[^a-z0-9._-]+/g, '-')
}

/**
 * Find a packable local "created" install matching any of the candidate names/keys.
 * Used so owner menus do not wait on the currently selected row's origin field.
 */
export function findPackableCreatedPlugin(
  installedPlugins: InstalledPluginItem[],
  candidates: Array<string | null | undefined>
): InstalledPluginItem | null {
  const normalized = candidates
    .map(candidate => candidate?.trim().toLowerCase())
    .filter((candidate): candidate is string => Boolean(candidate))
  if (normalized.length === 0) return null

  const created = installedPlugins.filter(isPackableCreatedPlugin)
  for (const candidate of normalized) {
    const byKey = created.find(plugin => {
      const pluginKey = plugin.raw.spec.source.pluginKey?.trim().toLowerCase() || ''
      const slug = pluginKey ? createdPluginSlugFromKey(pluginKey) : ''
      return candidate === pluginKey || candidate === slug
    })
    if (byKey) return byKey
  }
  const byDisplayName = created.filter(plugin =>
    normalized.includes(plugin.name.trim().toLowerCase())
  )
  return byDisplayName.length === 1 ? byDisplayName[0] : null
}

/** Prefer packable created install; fall back to listing/plugin key for continue-editing. */
export function resolveContinueEditingPluginKey(input: {
  packableCreated: InstalledPluginItem | null
  currentPlugin?: InstalledPluginItem | null
  ownedListingName?: string | null
  listing?: Pick<PluginMarketplaceItem, 'accessRole' | 'latestReleaseId' | 'visibility'> | null
}): string | null {
  if (input.listing && !marketplaceItemOwnsLocalCreatedPackage(input.listing)) return null
  if (input.packableCreated && isPackableCreatedPlugin(input.packableCreated)) {
    return input.packableCreated.raw.spec.source.pluginKey
  }
  if (input.currentPlugin && isPackableCreatedPlugin(input.currentPlugin)) {
    return input.currentPlugin.raw.spec.source.pluginKey
  }
  if (input.listing?.accessRole === 'owner' && input.listing.visibility === 'personal') {
    const listingName = input.ownedListingName?.trim()
    if (listingName) return listingName
    const currentKey = input.currentPlugin?.raw.spec.source.pluginKey?.trim()
    if (currentKey) return currentKey
  }
  return null
}
