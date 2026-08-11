import type { PluginMarketplaceItem } from '@/types/api'
import type { InstalledPluginItem } from './PluginManagementRows'

/**
 * While install+local-auth is in flight, Codex already reports the plugin as
 * installed. Background catalog paints must not surface strip/actions yet —
 * that races auth and can cancel/uninstall mid-dialog.
 */
export function holdBackInFlightMarketplaceInstalls(input: {
  items: PluginMarketplaceItem[]
  installed: InstalledPluginItem[]
  installingIds: Set<string | number>
  authPluginKey: string | null | undefined
}): { items: PluginMarketplaceItem[]; installed: InstalledPluginItem[] } {
  const authKey = input.authPluginKey?.trim().toLowerCase() || ''
  if (input.installingIds.size === 0 && !authKey) {
    return { items: input.items, installed: input.installed }
  }

  const blockedNames = new Set<string>()
  if (authKey) blockedNames.add(authKey)
  const items = input.items.map(item => {
    const blocked =
      input.installingIds.has(item.id) ||
      (authKey !== '' && item.name.trim().toLowerCase() === authKey)
    if (!blocked) return item
    blockedNames.add(item.name.trim().toLowerCase())
    return {
      ...item,
      installed: false,
      installedLocally: false,
      installedPluginId: null,
    }
  })

  if (blockedNames.size === 0) {
    return { items, installed: input.installed }
  }

  const installed = input.installed.filter(plugin => {
    const pluginKey = (plugin.raw.spec.source.pluginKey || plugin.name).trim().toLowerCase()
    const name = plugin.name.trim().toLowerCase()
    return !blockedNames.has(pluginKey) && !blockedNames.has(name)
  })
  return { items, installed }
}
