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

function isComposerVisiblePlugin(plugin: InstalledPlugin): boolean {
  return (
    Boolean(plugin.spec.enabled) &&
    (plugin.spec.installState === 'installed' || plugin.spec.installState === 'update_available')
  )
}

function pluginMentionPath(plugin: InstalledPlugin): string | null {
  const payload = plugin.spec.sourcePayload
  const payloadRecord = payload && typeof payload === 'object' ? payload : {}
  const pluginName =
    (typeof payloadRecord.pluginName === 'string' && payloadRecord.pluginName.trim()) ||
    (typeof payloadRecord.remotePluginId === 'string' && payloadRecord.remotePluginId.trim()) ||
    plugin.spec.source.pluginKey
  const marketplaceName =
    (typeof payloadRecord.marketplaceName === 'string' && payloadRecord.marketplaceName.trim()) ||
    plugin.spec.source.marketplace ||
    plugin.metadata.namespace
  if (typeof pluginName !== 'string' || !pluginName.trim()) return null
  if (typeof marketplaceName !== 'string' || !marketplaceName.trim()) return null
  return `plugin://${pluginName}@${marketplaceName}`
}

function skillFilePath(path: string): string {
  return path.endsWith('/SKILL.md') ? path : `${path.replace(/\/+$/, '')}/SKILL.md`
}

function installedPluginAsComposerApp(plugin: InstalledPlugin): LocalDeviceApp | null {
  const displayName = plugin.spec.displayName || plugin.spec.source.pluginKey
  const pluginKey = plugin.spec.source.pluginKey || plugin.metadata.name
  if (!displayName || !pluginKey) return null

  const mentionPath = pluginMentionPath(plugin)
  const skill = plugin.spec.components.skills.find(item => item.path && item.name)
  const skillPath = mentionPath ?? (skill ? skillFilePath(skill.path) : null)
  if (!skillPath) return null

  const interfaceData = plugin.spec.interface
  return {
    id: `plugin:${pluginKey}`,
    name: displayName,
    description:
      interfaceData?.shortDescription || plugin.spec.description || skill?.description || null,
    logoUrl: interfaceData?.composerIcon || interfaceData?.logo || null,
    isAccessible: true,
    isEnabled: true,
    pluginDisplayNames: [displayName],
    source: 'installed-plugin',
    skillPath,
  }
}

export function enrichComposerApps(
  apps: LocalDeviceApp[],
  installedPlugins: InstalledPlugin[]
): LocalDeviceApp[] {
  return apps.flatMap(app => {
    const plugin = bestPluginForApp(app, installedPlugins)
    if (!plugin) return [app]
    if (!isComposerVisiblePlugin(plugin)) {
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

/** Include enabled installed plugins that have no Codex/app entry yet (e.g. skill-only). */
export function appendInstalledPluginsAsComposerApps(
  apps: LocalDeviceApp[],
  installedPlugins: InstalledPlugin[]
): LocalDeviceApp[] {
  const extras: LocalDeviceApp[] = []
  for (const plugin of installedPlugins) {
    if (!isComposerVisiblePlugin(plugin)) continue
    if (apps.some(app => pluginMatchScore(app, plugin) > 0)) continue
    const entry = installedPluginAsComposerApp(plugin)
    if (entry) extras.push(entry)
  }
  return extras.length > 0 ? [...apps, ...extras] : apps
}
