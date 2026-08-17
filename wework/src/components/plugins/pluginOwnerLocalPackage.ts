import type { InstalledPluginItem } from './PluginManagementRows'

/** Local plugins that can be edited / packaged for publish. */
export function isPackableCreatedPlugin(plugin: InstalledPluginItem): boolean {
  return plugin.origin === 'created' || plugin.raw.spec.source.type === 'local'
}

export function createdPluginSlugFromKey(pluginKey: string): string {
  return pluginKey.toLowerCase().replace(/[^a-z0-9._-]+/g, '-')
}

/**
 * Find a packable local "created" install matching any of the candidate names/keys.
 * Used so owner menus do not wait on the currently selected row's origin field.
 */
export function findPackableCreatedPlugin(
  installedPlugins: InstalledPluginItem[],
  candidates: Array<string | null | undefined>
): InstalledPluginItem | null {
  const normalized = candidates
    .map(candidate => candidate?.trim().toLowerCase())
    .filter((candidate): candidate is string => Boolean(candidate))
  if (normalized.length === 0) return null

  return (
    installedPlugins.find(plugin => {
      if (!isPackableCreatedPlugin(plugin)) return false
      const pluginKey = plugin.raw.spec.source.pluginKey?.trim().toLowerCase() || ''
      const slug = pluginKey ? createdPluginSlugFromKey(pluginKey) : ''
      const displayName = plugin.name.trim().toLowerCase()
      return normalized.some(
        candidate => candidate === pluginKey || candidate === slug || candidate === displayName
      )
    }) ?? null
  )
}

/** Prefer packable created install; fall back to listing/plugin key for continue-editing. */
export function resolveContinueEditingPluginKey(input: {
  packableCreated: InstalledPluginItem | null
  currentPlugin?: InstalledPluginItem | null
  ownedListingName?: string | null
  isPersonalOwner?: boolean
}): string | null {
  if (input.packableCreated) {
    return input.packableCreated.raw.spec.source.pluginKey
  }
  if (input.currentPlugin && isPackableCreatedPlugin(input.currentPlugin)) {
    return input.currentPlugin.raw.spec.source.pluginKey
  }
  if (input.isPersonalOwner) {
    const listingName = input.ownedListingName?.trim()
    if (listingName) return listingName
    const currentKey = input.currentPlugin?.raw.spec.source.pluginKey?.trim()
    if (currentKey) return currentKey
  }
  return null
}
