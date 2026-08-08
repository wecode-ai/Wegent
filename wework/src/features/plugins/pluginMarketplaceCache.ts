import type { PluginMarketplaceItem } from '@/types/api'
import type { InstalledPluginItem } from '@/components/plugins/PluginManagementRows'

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
  canPublish: boolean
  canSharePersonalPlugins: boolean
  fetchedAt: number
}

let snapshot: PluginMarketplaceCacheSnapshot | null = null

export function pluginMarketplaceCacheKey(
  cloudApiBaseUrl?: string | null,
  cloudToken?: string | null
): string {
  const tokenHint = cloudToken ? cloudToken.slice(-12) : 'anon'
  return `${cloudApiBaseUrl || ''}|${tokenHint}`
}

export function getPluginMarketplaceCache(cacheKey: string): PluginMarketplaceCacheSnapshot | null {
  if (!snapshot || snapshot.cacheKey !== cacheKey) return null
  return snapshot
}

export function setPluginMarketplaceCache(next: PluginMarketplaceCacheSnapshot): void {
  snapshot = next
}

export function clearPluginMarketplaceCache(): void {
  snapshot = null
}

export function marketplaceItemsSignature(items: PluginMarketplaceItem[]): string {
  return items
    .map(item =>
      [
        item.id,
        item.version ?? '',
        item.installed ? '1' : '0',
        item.installedLocally ? '1' : '0',
        item.updateAvailable ? '1' : '0',
        item.enabled ? '1' : '0',
        item.grantUserCount ?? 0,
        item.grantNamespaceCount ?? 0,
        item.accessRole ?? '',
        item.latestReleaseId ?? '',
        item.currentDeviceInstallation?.state ?? '',
        item.currentDeviceInstallation?.errorMessage ?? '',
        item.currentDeviceInstallation?.actualReleaseId ?? '',
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
