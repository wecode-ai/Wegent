import { gt, valid } from 'semver'
import type { PluginMarketplaceItem } from '@/types/api'
import type { InstalledPluginItem } from './PluginManagementRows'
import { createdPluginSlugFromKey, isPackableCreatedPlugin } from './pluginOwnerLocalPackage'

export function hasNewPersonalPluginVersion(
  plugin: InstalledPluginItem | null | undefined,
  listing: PluginMarketplaceItem | null | undefined
): boolean {
  if (
    !plugin ||
    !listing ||
    !isPackableCreatedPlugin(plugin) ||
    createdPluginSlugFromKey(plugin.raw.spec.source.pluginKey) !==
      createdPluginSlugFromKey(listing.name) ||
    listing.accessRole !== 'owner' ||
    listing.visibility !== 'personal' ||
    !listing.latestReleaseId
  ) {
    return false
  }
  const localVersion = valid(plugin.version?.trim() ?? '')
  const sharedVersion = valid((listing.sharedVersion ?? listing.version)?.trim() ?? '')
  return Boolean(localVersion && sharedVersion && gt(localVersion, sharedVersion))
}
