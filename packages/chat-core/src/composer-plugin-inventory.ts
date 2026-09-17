import type { InstalledPlugin } from './installed-plugin-types'
import type { LocalDeviceApp } from './runtime-composer-catalog'
import { mergeInstalledPlugins } from './installed-plugin-merge'
import { applyScopedPluginVisibility } from './composer-plugin-scope'
import {
  appendInstalledPluginsAsComposerApps,
  enrichComposerApps,
  type ComposerPluginPresentation,
} from './composer-plugin-metadata'

/** Both hosts apply device membership and project scope before presenting plugins. */
export function buildComposerPluginInventory(options: {
  deviceId: string
  apps: LocalDeviceApp[]
  localInstalledPlugins: InstalledPlugin[]
  cloudInstalledPlugins: InstalledPlugin[]
  visiblePluginKeys?: ReadonlySet<string>
  presentation: (plugin: InstalledPlugin) => ComposerPluginPresentation
}): LocalDeviceApp[] {
  if (!options.deviceId.trim()) throw new Error('Composer plugin inventory requires a device ID')
  const installed = applyScopedPluginVisibility(
    mergeInstalledPlugins(
      options.cloudInstalledPlugins,
      options.localInstalledPlugins,
      options.deviceId
    ),
    options.visiblePluginKeys
  )
  return appendInstalledPluginsAsComposerApps(
    enrichComposerApps(options.apps, installed, options.presentation),
    installed,
    options.presentation
  )
}
