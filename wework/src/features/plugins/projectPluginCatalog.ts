import {
  buildInstalledPluginProjectCatalog,
  mergeProjectPluginCatalogs,
} from '@wegent/collaboration'
import type { InstalledPlugin, LocalDeviceApp, RuntimeProjectPluginRef } from '@/types/api'

export { mergeProjectPluginCatalogs } from '@wegent/collaboration'

function normalized(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase()
}

export function buildProjectPluginCatalog(
  installedPlugins: InstalledPlugin[],
  codexApps: LocalDeviceApp[] = []
): RuntimeProjectPluginRef[] {
  const appNames = new Map<string, string>()
  const appDescriptions = new Map<string, string>()
  codexApps.forEach(app => {
    const aliases = [app.pluginKey, app.id, ...(app.pluginDisplayNames ?? [])]
    aliases.forEach(alias => {
      const key = normalized(alias)
      if (key) {
        appNames.set(key, app.name.trim() || alias || '')
        if (app.description?.trim()) appDescriptions.set(key, app.description.trim())
      }
    })
  })

  return mergeProjectPluginCatalogs(
    buildInstalledPluginProjectCatalog(installedPlugins).map(ref => {
      const appName =
        appNames.get(normalized(ref.pluginName)) || appNames.get(normalized(ref.displayName))
      const appDescription =
        appDescriptions.get(normalized(ref.pluginName)) ||
        appDescriptions.get(normalized(ref.displayName))
      return {
        ...ref,
        displayName: appName || ref.displayName,
        ...(appDescription || ref.description
          ? { description: appDescription || ref.description }
          : {}),
      }
    })
  )
}
