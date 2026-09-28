import { buildComposerPluginInventory } from '@wegent/chat-core/composer-plugin-inventory'
import type { InstalledPlugin, LocalDeviceApp, PluginMarketplaceItem } from '@/types/api'
import { installedPluginHasRelativeLogo } from '@/components/plugins/plugin-assets'
import {
  pluginPresentation,
  overlayMarketplaceLogosOnComposerApps,
} from '@/features/plugins/composerPluginMetadata'
import { publishPluginInvocationCatalog } from '@/features/plugins/pluginInvocationTelemetry'

export interface ComposerPluginAppSources {
  deviceId: string
  listCodexApps: () => Promise<LocalDeviceApp[]>
  readLocalInstalledPlugins: () => Promise<InstalledPlugin[]>
  readLocalInstalledPluginDetail?: (plugin: InstalledPlugin) => Promise<InstalledPlugin>
  listCloudInstalledPlugins: () => Promise<InstalledPlugin[]>
}

export interface LoadComposerPluginAppsOptions {
  /**
   * When true, await per-plugin detail reads for relative package logos.
   * Keep false on the composer warm path so the toolbar can paint first.
   */
  enrichRelativeLogos?: boolean
  /**
   * Marketplace catalog rows (same source as the plugin market UI). Prefer their
   * package logos when installed rows still carry unresolved relative assets.
   */
  marketplaceItems?: PluginMarketplaceItem[]
  /**
   * Project-scoped installs stay disabled in the global Codex config. Treat the
   * selected plugin keys as enabled while building this composer's inventory.
   */
  visiblePluginKeys?: ReadonlySet<string>
}

async function enrichLocalPluginsWithDetails(
  localItems: InstalledPlugin[],
  readLocalInstalledPluginDetail: (plugin: InstalledPlugin) => Promise<InstalledPlugin>
): Promise<InstalledPlugin[]> {
  const pluginsNeedingDetail = localItems.filter(installedPluginHasRelativeLogo)
  if (pluginsNeedingDetail.length === 0) return localItems

  const detailResults = await Promise.all(
    pluginsNeedingDetail.map(plugin => readLocalInstalledPluginDetail(plugin))
  )
  const detailedByKey = new Map<string, InstalledPlugin>()
  detailResults.forEach((plugin, index) => {
    const key =
      pluginsNeedingDetail[index].spec.source.pluginKey || pluginsNeedingDetail[index].metadata.name
    if (typeof key === 'string' && key) detailedByKey.set(key, plugin)
  })

  return localItems.map(plugin => {
    const key = plugin.spec.source.pluginKey || plugin.metadata.name
    return (typeof key === 'string' && detailedByKey.get(key)) || plugin
  })
}

/** Reject failed sources; a successful empty inventory is authoritative. */
export async function loadComposerPluginApps(
  sources: ComposerPluginAppSources,
  options: LoadComposerPluginAppsOptions = {}
): Promise<LocalDeviceApp[]> {
  const [apps, local, cloud] = await Promise.all([
    sources.listCodexApps(),
    sources.readLocalInstalledPlugins(),
    sources.listCloudInstalledPlugins(),
  ])
  const localInstalledPlugins =
    options.enrichRelativeLogos && sources.readLocalInstalledPluginDetail
      ? await enrichLocalPluginsWithDetails(local, sources.readLocalInstalledPluginDetail)
      : local
  publishPluginInvocationCatalog(sources.deviceId, localInstalledPlugins, cloud)
  const marketplaceItems = options.marketplaceItems ?? []
  return overlayMarketplaceLogosOnComposerApps(
    buildComposerPluginInventory({
      deviceId: sources.deviceId,
      apps,
      localInstalledPlugins,
      cloudInstalledPlugins: cloud,
      visiblePluginKeys: options.visiblePluginKeys,
      presentation: plugin => pluginPresentation(plugin, marketplaceItems),
    }),
    marketplaceItems
  )
}
