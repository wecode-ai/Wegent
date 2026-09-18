import { composerAppPluginKey } from '@wegent/chat-core/composer-plugin-metadata'
export { composerAppPluginKey } from '@wegent/chat-core/composer-plugin-metadata'
import type { InstalledPlugin, LocalDeviceApp, PluginMarketplaceItem } from '@/types/api'
import { findMarketplaceItemForInstalledPlugin } from '@/components/plugins/findMarketplaceItemForInstalled'
import {
  resolveInstalledPluginLogoUrl,
  resolvePluginLogo,
  resolvePluginLogoUrl,
} from '@/components/plugins/plugin-assets'
import { createComposerPluginPresentation } from '@wegent/chat-core/composer-plugin-presentation'

const sharedPresentation = createComposerPluginPresentation(resolveInstalledPluginLogoUrl)

function installedPluginLabelId(plugin: InstalledPlugin): string | number | null {
  const labels = plugin.metadata.labels
  if (!labels || typeof labels !== 'object') return null
  const id = (labels as Record<string, unknown>).id
  return typeof id === 'string' || typeof id === 'number' ? id : null
}

function marketplaceLogoInterface(
  plugin: InstalledPlugin,
  marketplaceItems: PluginMarketplaceItem[]
) {
  const market = findMarketplaceItemForInstalledPlugin(
    plugin,
    marketplaceItems,
    installedPluginLabelId(plugin)
  )
  const marketInterface = market?.interface
  if (!marketInterface) return plugin.spec.interface ?? null
  return {
    logo: marketInterface.logo || plugin.spec.interface?.logo,
    logoDark: marketInterface.logoDark || plugin.spec.interface?.logoDark,
    composerIcon: marketInterface.composerIcon || plugin.spec.interface?.composerIcon,
    shortDescription: marketInterface.shortDescription || plugin.spec.interface?.shortDescription,
  }
}

/**
 * Prefer marketplace-catalog package logos (same source as the plugin market UI)
 * when the installed-plugin row only has unresolved relative assets.
 */
export function overlayMarketplaceLogosOnComposerApps(
  apps: LocalDeviceApp[],
  marketplaceItems: PluginMarketplaceItem[]
): LocalDeviceApp[] {
  if (apps.length === 0 || marketplaceItems.length === 0) return apps

  return apps.map(app => {
    if (app.source === 'wegent-connector') return app

    const key = composerAppPluginKey(app).trim().toLowerCase()
    const displayName = app.name.trim().toLowerCase()
    const item =
      marketplaceItems.find(candidate => candidate.name.trim().toLowerCase() === key) ||
      marketplaceItems.find(candidate => candidate.displayName.trim().toLowerCase() === displayName)
    if (!item?.interface) return app

    const light = resolvePluginLogo({
      pluginKey: key,
      logo: item.interface.logo,
      logoDark: item.interface.logoDark,
      composerIcon: item.interface.composerIcon,
      appearanceMode: 'light',
    })
    if (light.source !== 'provided') return app

    return {
      ...app,
      logoUrl: light.url,
      logoUrlDark: resolvePluginLogoUrl({
        pluginKey: key,
        logo: item.interface.logo,
        logoDark: item.interface.logoDark,
        composerIcon: item.interface.composerIcon,
        appearanceMode: 'dark',
      }),
    }
  })
}

export function pluginPresentation(
  plugin: InstalledPlugin,
  marketplaceItems: PluginMarketplaceItem[]
) {
  return sharedPresentation(plugin, marketplaceLogoInterface(plugin, marketplaceItems))
}
