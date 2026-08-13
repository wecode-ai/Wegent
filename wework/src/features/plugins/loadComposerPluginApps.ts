import type { InstalledPlugin, LocalDeviceApp, PluginMarketplaceItem } from '@/types/api'
import { mergeInstalledPlugins } from '@/components/plugins/installedPluginMerge'
import { installedPluginHasRelativeLogo } from '@/components/plugins/plugin-assets'
import {
  appendInstalledPluginsAsComposerApps,
  enrichComposerApps,
  overlayMarketplaceLogosOnComposerApps,
} from '@/features/plugins/composerPluginMetadata'

export interface ComposerPluginAppSources {
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
}

async function enrichLocalPluginsWithDetails(
  localItems: InstalledPlugin[],
  readLocalInstalledPluginDetail: (plugin: InstalledPlugin) => Promise<InstalledPlugin>
): Promise<InstalledPlugin[]> {
  const pluginsNeedingDetail = localItems.filter(installedPluginHasRelativeLogo)
  if (pluginsNeedingDetail.length === 0) return localItems

  const detailResults = await Promise.allSettled(
    pluginsNeedingDetail.map(plugin => readLocalInstalledPluginDetail(plugin))
  )
  const detailedByKey = new Map<string, InstalledPlugin>()
  detailResults.forEach((result, index) => {
    if (result.status !== 'fulfilled') {
      console.warn(
        '[Wework] Failed to resolve an installed plugin logo for composer.',
        result.reason
      )
      return
    }
    const key =
      pluginsNeedingDetail[index]?.spec.source.pluginKey ||
      pluginsNeedingDetail[index]?.metadata.name
    if (typeof key === 'string' && key) detailedByKey.set(key, result.value)
  })

  return localItems.map(plugin => {
    const key = plugin.spec.source.pluginKey || plugin.metadata.name
    return (typeof key === 'string' && detailedByKey.get(key)) || plugin
  })
}

/**
 * Build the composer plugin inventory from Codex apps + local/cloud installs.
 * Cloud installs are loaded even when the local Codex state read fails.
 */
export async function loadComposerPluginApps(
  sources: ComposerPluginAppSources,
  options: LoadComposerPluginAppsOptions = {}
): Promise<LocalDeviceApp[]> {
  let apps: LocalDeviceApp[] = []
  try {
    apps = await sources.listCodexApps()
  } catch (error) {
    console.warn(
      '[Wework] Failed to load local Codex apps; continuing with installed plugins.',
      error
    )
  }

  let localItems: InstalledPlugin[] = []
  try {
    localItems = await sources.readLocalInstalledPlugins()
  } catch (error) {
    console.warn('[Wework] Failed to read local installed plugins for composer.', error)
  }

  let cloudItems: InstalledPlugin[] = []
  try {
    cloudItems = await sources.listCloudInstalledPlugins()
  } catch (error) {
    console.warn('[Wework] Failed to list cloud installed plugins for composer.', error)
  }

  const readLocalInstalledPluginDetail = sources.readLocalInstalledPluginDetail
  if (options.enrichRelativeLogos && readLocalInstalledPluginDetail) {
    localItems = await enrichLocalPluginsWithDetails(localItems, readLocalInstalledPluginDetail)
  }

  const installedPlugins = mergeInstalledPlugins(cloudItems, localItems, '')
  const marketplaceItems = options.marketplaceItems ?? []

  try {
    apps = enrichComposerApps(apps, installedPlugins, marketplaceItems)
  } catch (error) {
    console.warn(
      '[Wework] Failed to enrich Codex apps for composer; using installed plugins.',
      error
    )
    apps = []
  }

  try {
    apps = appendInstalledPluginsAsComposerApps(apps, installedPlugins, marketplaceItems)
  } catch (error) {
    console.warn('[Wework] Failed to append installed plugins to composer.', error)
  }

  // Last resort: ignore merge filters and map cloud rows directly.
  if (apps.length === 0 && cloudItems.length > 0) {
    try {
      apps = appendInstalledPluginsAsComposerApps([], cloudItems, marketplaceItems)
    } catch (error) {
      console.warn('[Wework] Failed cloud-only composer plugin fallback.', error)
    }
  }

  apps = overlayMarketplaceLogosOnComposerApps(apps, marketplaceItems)

  if (installedPlugins.length > 0 && apps.length === 0) {
    console.warn('[Wework] Installed plugins were loaded but none are composer-visible.', {
      installedCount: installedPlugins.length,
      cloudCount: cloudItems.length,
      localCount: localItems.length,
      pluginKeys: installedPlugins.map(
        plugin => plugin.spec.source?.pluginKey || plugin.metadata.name
      ),
      pluginStates: installedPlugins.map(plugin => ({
        key: plugin.spec.source?.pluginKey || plugin.metadata.name,
        enabled: plugin.spec.enabled,
        installState: plugin.spec.installState,
      })),
    })
  }

  return apps
}
