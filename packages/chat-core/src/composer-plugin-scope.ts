import type { InstalledPlugin } from './installed-plugin-types'

export function applyScopedPluginVisibility(
  plugins: InstalledPlugin[],
  visiblePluginKeys: ReadonlySet<string> | undefined
): InstalledPlugin[] {
  if (!visiblePluginKeys?.size) return plugins
  return plugins.map(plugin => {
    const key =
      plugin.spec.source.pluginKey ||
      (typeof plugin.metadata.name === 'string' ? plugin.metadata.name : '')
    if (!key || !visiblePluginKeys.has(key) || plugin.spec.enabled) return plugin
    return {
      ...plugin,
      spec: {
        ...plugin.spec,
        enabled: true,
      },
    }
  })
}

export function normalizeProjectPluginNames(pluginIds: string[]): string[] {
  return Array.from(
    new Set(
      pluginIds.map(id => {
        const separator = id.lastIndexOf('@')
        return separator > 0 ? id.slice(0, separator) : id
      })
    )
  ).sort()
}
