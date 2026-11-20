import { getInitializedBundledPluginMarketplace } from '@/desktop/localExecutor'
import { isPersonalMarketplaceId } from '@/features/plugins/builtinPlugins'
import type { PluginMarketplaceItem } from '@/types/api'
import type { InstalledPluginItem } from '../PluginManagementRows'
import { installedPluginMarketplaceId, marketplaceItemMarketplaceId } from '../pluginDistribution'
import { createdPluginSlugFromKey, isPackableCreatedPlugin } from '../pluginOwnerLocalPackage'

export type PersonalPluginInstallSource = {
  key: string
  name: string
} & ({ installed: InstalledPluginItem } | { installed: null; marketplacePath: string })

export function isPersonalPluginInstallSource(plugin: InstalledPluginItem): boolean {
  return (
    isPackableCreatedPlugin(plugin) &&
    isPersonalMarketplaceId(installedPluginMarketplaceId(plugin.raw) ?? '')
  )
}

export function ownedPersonalPluginListings(items: PluginMarketplaceItem[], key: string) {
  const slug = createdPluginSlugFromKey(key)
  return items.filter(
    item =>
      item.visibility === 'personal' &&
      item.accessRole === 'owner' &&
      createdPluginSlugFromKey(item.name) === slug
  )
}

export function personalPluginInstallSource(
  installedPlugins: InstalledPluginItem[],
  listing?: PluginMarketplaceItem
): PersonalPluginInstallSource | null {
  if (
    listing &&
    (listing.visibility !== 'personal' ||
      listing.accessRole === 'recipient' ||
      listing.accessRole === 'catalog')
  )
    return null

  const diskPluginName = listing?.localPersonalSource?.pluginName
  const pluginName = diskPluginName ?? listing?.name
  const matches = installedPlugins.filter(plugin => {
    if (!isPersonalPluginInstallSource(plugin)) return false
    const key = plugin.raw.spec.source.pluginKey
    if (diskPluginName) return key === diskPluginName
    return !pluginName || createdPluginSlugFromKey(key) === createdPluginSlugFromKey(pluginName)
  })
  if (matches.length > 1) return null
  const [installed] = matches
  if (installed) {
    return {
      key: installed.raw.spec.source.pluginKey,
      name: installed.name,
      installed,
    }
  }

  if (!listing || !pluginName) return null
  const marketplacePath =
    listing.localPersonalSource?.marketplacePath ??
    (listing.latestReleaseId == null &&
    isPersonalMarketplaceId(marketplaceItemMarketplaceId(listing) ?? '')
      ? listing.manifest.marketplacePath
      : undefined)
  if (
    typeof marketplacePath !== 'string' ||
    !marketplacePath.trim() ||
    getInitializedBundledPluginMarketplace()?.defaultPluginNames?.includes(pluginName)
  )
    return null

  return {
    key: pluginName,
    name: listing.displayName || pluginName,
    installed: null,
    marketplacePath,
  }
}

export async function readPersonalPluginPackageVersion(file: File): Promise<string | null> {
  const { default: JSZip } = await import('jszip')
  const archive = await JSZip.loadAsync(file)
  const entry =
    archive.file('.codex-plugin/plugin.json') ?? archive.file('.claude-plugin/plugin.json')
  if (!entry) return null
  const manifest: unknown = JSON.parse(await entry.async('string'))
  if (!manifest || typeof manifest !== 'object' || !('version' in manifest)) return null
  return typeof manifest.version === 'string' ? manifest.version.trim() || null : null
}
