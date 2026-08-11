import type { InstalledPlugin, LocalDeviceApp } from '@/types/api'
import { mergeInstalledPlugins } from '@/components/plugins/installedPluginMerge'
import {
  appendInstalledPluginsAsComposerApps,
  enrichComposerApps,
} from '@/features/plugins/composerPluginMetadata'

export interface ComposerPluginAppSources {
  listCodexApps: () => Promise<LocalDeviceApp[]>
  readLocalInstalledPlugins: () => Promise<InstalledPlugin[]>
  listCloudInstalledPlugins: () => Promise<InstalledPlugin[]>
}

/**
 * Build the composer plugin inventory from Codex apps + local/cloud installs.
 * Cloud installs are loaded even when the local Codex state read fails.
 */
export async function loadComposerPluginApps(
  sources: ComposerPluginAppSources
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

  const installedPlugins = mergeInstalledPlugins(cloudItems, localItems, '')

  try {
    apps = enrichComposerApps(apps, installedPlugins)
  } catch (error) {
    console.warn(
      '[Wework] Failed to enrich Codex apps for composer; using installed plugins.',
      error
    )
    apps = []
  }

  try {
    apps = appendInstalledPluginsAsComposerApps(apps, installedPlugins)
  } catch (error) {
    console.warn('[Wework] Failed to append installed plugins to composer.', error)
  }

  // Last resort: ignore merge filters and map cloud rows directly.
  if (apps.length === 0 && cloudItems.length > 0) {
    try {
      apps = appendInstalledPluginsAsComposerApps([], cloudItems)
    } catch (error) {
      console.warn('[Wework] Failed cloud-only composer plugin fallback.', error)
    }
  }

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
