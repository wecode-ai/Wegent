import type { InstalledPlugin, LocalDeviceApp } from '@/types/api'

function normalized(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase()
}

function pluginAliases(plugin: InstalledPlugin): Set<string> {
  const source = plugin.spec.source
  const payload = plugin.spec.sourcePayload
  const payloadRecord = payload && typeof payload === 'object' ? payload : {}
  return new Set(
    [
      plugin.spec.displayName,
      plugin.spec.source.pluginKey,
      source.catalogItemId,
      typeof payloadRecord.pluginName === 'string' ? payloadRecord.pluginName : null,
      typeof payloadRecord.remotePluginId === 'string' ? payloadRecord.remotePluginId : null,
      plugin.metadata.name,
    ]
      .map(value => normalized(typeof value === 'string' ? value : String(value ?? '')))
      .filter(Boolean)
  )
}

function pluginAppIds(plugin: InstalledPlugin): Set<string> {
  const components = plugin.spec.components
  return new Set(
    [
      ...(components.apps ?? []).flatMap(app => [app.name, app.path]),
      ...(components.templates ?? components.commands).flatMap(app => [
        app.name,
        app.path,
        ...(app.materializedAppIds ?? []),
      ]),
    ]
      .map(value => normalized(value))
      .filter(Boolean)
  )
}

function pluginMatchScore(app: LocalDeviceApp, plugin: InstalledPlugin): number {
  const appIds = pluginAppIds(plugin)
  const aliases = pluginAliases(plugin)
  const appId = normalized(app.id)
  const appName = normalized(app.name)
  const appPluginNames = (app.pluginDisplayNames ?? []).map(normalized)

  if (appIds.has(appId) || appIds.has(appName)) return 4
  if (appPluginNames.some(name => aliases.has(name))) return 3
  if (aliases.has(appId)) return 2
  if (aliases.has(appName)) return 1
  return 0
}

function bestPluginForApp(app: LocalDeviceApp, plugins: InstalledPlugin[]): InstalledPlugin | null {
  let best: InstalledPlugin | null = null
  let bestScore = 0
  for (const plugin of plugins) {
    const score = pluginMatchScore(app, plugin)
    if (score > bestScore) {
      best = plugin
      bestScore = score
    }
  }
  return best
}

export function enrichComposerApps(
  apps: LocalDeviceApp[],
  installedPlugins: InstalledPlugin[]
): LocalDeviceApp[] {
  return apps.flatMap(app => {
    const plugin = bestPluginForApp(app, installedPlugins)
    if (!plugin) return [app]
    if (
      !plugin.spec.enabled ||
      (plugin.spec.installState !== 'installed' && plugin.spec.installState !== 'update_available')
    ) {
      return []
    }

    const interfaceData = plugin.spec.interface
    return [
      {
        ...app,
        name: plugin.spec.displayName || app.name,
        description:
          interfaceData?.shortDescription || plugin.spec.description || app.description || null,
        logoUrl: interfaceData?.composerIcon || interfaceData?.logo || app.logoUrl || null,
        pluginDisplayNames: [plugin.spec.displayName, ...(app.pluginDisplayNames ?? [])].filter(
          (name, index, names): name is string => Boolean(name) && names.indexOf(name) === index
        ),
      },
    ]
  })
}
