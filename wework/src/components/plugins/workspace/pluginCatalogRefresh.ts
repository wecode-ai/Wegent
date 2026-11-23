import { isElectronRuntime } from '@/lib/runtime-environment'

import { listPersonalMarketplacePluginsFromDisk } from '@/api/local/codexPlugins'

import type { InstalledPlugin, PluginMarketplaceItem } from '@/types/api'

import { mergeDiskPersonalIntoLocalRows, mergeMarketplaceCatalog } from '../marketplaceCatalogMerge'

import { marketplacePluginDistribution } from '../pluginDistribution'

import { isCodexCatalogItem } from '../workspace/marketplaceWorkspaceHelpers'

type PersonalMarketplaceRefreshResult =
  | { complete: true; items: PluginMarketplaceItem[] }
  | { complete: false }

export async function readPersonalMarketplaceForCloudRefresh(): Promise<PersonalMarketplaceRefreshResult> {
  try {
    const items = isElectronRuntime() ? await listPersonalMarketplacePluginsFromDisk(true) : []
    return { complete: true, items }
  } catch (error) {
    console.warn(
      '[Wework] personal marketplace refresh incomplete; retaining existing source rows',
      error
    )
    return { complete: false }
  }
}

export function mergeCloudMarketplaceRefresh(
  previousItems: PluginMarketplaceItem[],
  cloudItems: PluginMarketplaceItem[],
  installed: InstalledPlugin[],
  personalRead: PersonalMarketplaceRefreshResult
): PluginMarketplaceItem[] {
  const localRows = previousItems.filter(isCodexCatalogItem)
  const refreshedLocalRows = personalRead.complete
    ? mergeDiskPersonalIntoLocalRows(
        localRows.filter(item => marketplacePluginDistribution(item) !== 'personal'),
        personalRead.items
      )
    : localRows
  const items = mergeMarketplaceCatalog(cloudItems, refreshedLocalRows, installed)
  if (personalRead.complete) return items
  const previousById = new Map(previousItems.map(item => [String(item.id), item]))
  return items.map(item => {
    const previous = previousById.get(String(item.id))
    const normalizedName = item.name.toLowerCase()
    if (
      item.accessRole !== 'owner' ||
      previous?.accessRole !== 'owner' ||
      marketplacePluginDistribution(item) !== 'personal' ||
      marketplacePluginDistribution(previous) !== 'personal' ||
      previous.name.toLowerCase() !== normalizedName ||
      previous.localPersonalSource?.pluginName.toLowerCase() !== normalizedName
    ) {
      return item
    }
    return {
      ...item,
      version: previous.version,
      sharedVersion: item.sharedVersion ?? item.version,
      localPersonalSource: previous.localPersonalSource,
    }
  })
}
