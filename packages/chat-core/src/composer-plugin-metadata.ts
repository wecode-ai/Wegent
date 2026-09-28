import type { LocalDeviceApp, PluginPathComponent } from './runtime-composer-catalog'

/** Installed membership independent of a desktop API or a marketplace transport. */
export interface ComposerInstalledPlugin {
  metadata: Record<string, unknown>
  spec: {
    source: {
      pluginKey: string
      catalogItemId?: string | number | null
      marketplace?: string | null
      providerKey?: string | null
    }
    sourcePayload?: Record<string, unknown> | null
    visibility?: string
    enabled: boolean
    installState: string
    displayName: string
    description: string
    components?: {
      skills?: PluginPathComponent[]
      commands?: PluginPathComponent[]
      templates?: PluginPathComponent[]
      apps?: PluginPathComponent[]
    }
  }
}
export interface ComposerPluginPresentation {
  shortDescription?: string | null
  logoUrl?: string | null
  logoUrlDark?: string | null
  trialTemplates?: PluginPathComponent[]
}
export function marketplaceNameForVisibility(visibility?: string | null): string | null {
  switch (visibility) {
    case 'personal':
      return 'wework-personal'
    case 'workspace':
      return 'wegent'
    case 'public':
      return 'wework'
    default:
      return null
  }
}
export function managedComposerMarketplaceName(plugin: ComposerInstalledPlugin): string | null {
  const provider = plugin.spec.source.providerKey
  if (provider !== 'wegent-market' && provider !== 'wegent-marketplace') return null
  return marketplaceNameForVisibility(plugin.spec.visibility) ?? 'wegent'
}
function normalized(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase()
}

export function composerAppPluginKey(app: LocalDeviceApp): string {
  const pluginKey = app.pluginKey?.trim()
  if (pluginKey) return pluginKey
  if (app.source === 'installed-plugin') {
    return app.id.replace(/^plugin:/, '')
  }
  if (app.source === 'wegent-connector') {
    return app.id.replace(/^wegent:/, '')
  }
  return app.pluginDisplayNames?.[0] ?? app.id
}

function pluginAliases(plugin: ComposerInstalledPlugin): Set<string> {
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

function pluginAppIds(plugin: ComposerInstalledPlugin): Set<string> {
  const components = plugin.spec.components
  const apps = Array.isArray(components?.apps) ? components.apps : []
  const commands = Array.isArray(components?.commands) ? components.commands : []
  const templates = Array.isArray(components?.templates) ? components.templates : commands
  return new Set(
    [
      ...apps.flatMap(app => [app.name, app.path]),
      ...templates.flatMap(app => [app.name, app.path, ...(app.materializedAppIds ?? [])]),
    ]
      .map(value => normalized(value))
      .filter(Boolean)
  )
}

function pluginMatchScore(app: LocalDeviceApp, plugin: ComposerInstalledPlugin): number {
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

function bestPluginForApp<Plugin extends ComposerInstalledPlugin>(
  app: LocalDeviceApp,
  plugins: Plugin[]
): Plugin | null {
  let best: Plugin | null = null
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

function isComposerVisiblePlugin(plugin: ComposerInstalledPlugin): boolean {
  return (
    Boolean(plugin.spec.enabled) &&
    (plugin.spec.installState === 'installed' || plugin.spec.installState === 'update_available')
  )
}

function pluginMentionPath(plugin: ComposerInstalledPlugin): string | null {
  const payload = plugin.spec.sourcePayload
  const payloadRecord = payload && typeof payload === 'object' ? payload : {}
  const metadataName = typeof plugin.metadata.name === 'string' ? plugin.metadata.name : null
  const metadataNamespace =
    typeof plugin.metadata.namespace === 'string' ? plugin.metadata.namespace : null
  const pluginName =
    (typeof payloadRecord.pluginName === 'string' && payloadRecord.pluginName.trim()) ||
    (typeof payloadRecord.remotePluginId === 'string' && payloadRecord.remotePluginId.trim()) ||
    plugin.spec.source?.pluginKey ||
    metadataName
  const marketplaceName =
    (typeof payloadRecord.marketplaceName === 'string' && payloadRecord.marketplaceName.trim()) ||
    managedComposerMarketplaceName(plugin) ||
    plugin.spec.source?.marketplace ||
    // Cloud ComposerInstalledPlugin rows use namespace "default"; composer mentions need the
    // marketplace id selected by visibility, not the Kind namespace.
    (metadataNamespace && metadataNamespace !== 'default' ? metadataNamespace : null)
  if (typeof pluginName !== 'string' || !pluginName.trim()) return null
  if (typeof marketplaceName !== 'string' || !marketplaceName.trim()) return null
  return `plugin://${pluginName}@${marketplaceName}`
}

function skillFilePath(path: string): string {
  return path.endsWith('/SKILL.md') ? path : `${path.replace(/\/+$/, '')}/SKILL.md`
}

function installedPluginAsComposerApp(
  plugin: ComposerInstalledPlugin,
  presentation: ComposerPluginPresentation
): LocalDeviceApp | null {
  const metadataName = typeof plugin.metadata.name === 'string' ? plugin.metadata.name : null
  const displayName = plugin.spec.displayName || plugin.spec.source?.pluginKey || metadataName
  const pluginKey = plugin.spec.source?.pluginKey || metadataName
  if (!displayName || !pluginKey) return null

  const mentionPath = pluginMentionPath(plugin)
  const skills = Array.isArray(plugin.spec.components?.skills) ? plugin.spec.components.skills : []
  const skill = skills.find(item => item.path && item.name)
  const commands = Array.isArray(plugin.spec.components?.commands)
    ? plugin.spec.components.commands
    : []
  const command = commands.find(item => item.path && item.name)
  // Marketplace mention paths are preferred so cloud plugins stay selectable even
  // when the local skill file has not been materialized yet.
  const skillPath =
    mentionPath ||
    (skill ? skillFilePath(skill.path) : null) ||
    (command ? `command://${pluginKey}` : null)
  if (!skillPath) return null

  const { shortDescription, logoUrl, logoUrlDark, trialTemplates } = presentation
  return {
    id: `plugin:${pluginKey}`,
    name: displayName,
    pluginKey,
    description: shortDescription || plugin.spec.description || skill?.description || null,
    logoUrl: logoUrl,
    logoUrlDark: logoUrlDark,
    isAccessible: true,
    isEnabled: true,
    pluginDisplayNames: [displayName],
    source: 'installed-plugin',
    skillPath,
    trialTemplates: trialTemplates,
  }
}

export function enrichComposerApps<Plugin extends ComposerInstalledPlugin>(
  apps: LocalDeviceApp[],
  installedPlugins: Plugin[],
  presentation: (plugin: Plugin) => ComposerPluginPresentation
): LocalDeviceApp[] {
  return apps.flatMap(app => {
    const plugin = bestPluginForApp(app, installedPlugins)
    // Composer only lists installed plugins. Remote Codex apps and authorized
    // cloud connectors are not shown unless they match an installed plugin.
    if (!plugin) return []
    if (!isComposerVisiblePlugin(plugin)) {
      return []
    }

    const { shortDescription, logoUrl, logoUrlDark, trialTemplates } = presentation(plugin)
    return [
      {
        ...app,
        name: plugin.spec.displayName || app.name,
        pluginKey: plugin.spec.source.pluginKey,
        description: shortDescription || plugin.spec.description || app.description || null,
        logoUrl: logoUrl || app.logoUrl || null,
        logoUrlDark: logoUrlDark || app.logoUrlDark || null,
        pluginDisplayNames: [plugin.spec.displayName, ...(app.pluginDisplayNames ?? [])].filter(
          (name, index, names): name is string => Boolean(name) && names.indexOf(name) === index
        ),
        trialTemplates: trialTemplates,
      },
    ]
  })
}

/** Include enabled installed plugins that have no Codex/app entry yet (e.g. skill-only). */
export function appendInstalledPluginsAsComposerApps<Plugin extends ComposerInstalledPlugin>(
  apps: LocalDeviceApp[],
  installedPlugins: Plugin[],
  presentation: (plugin: Plugin) => ComposerPluginPresentation
): LocalDeviceApp[] {
  const extras: LocalDeviceApp[] = []
  for (const plugin of installedPlugins) {
    if (!isComposerVisiblePlugin(plugin)) continue
    if (apps.some(app => pluginMatchScore(app, plugin) > 0)) continue
    const entry = installedPluginAsComposerApp(plugin, presentation(plugin))
    if (entry) extras.push(entry)
  }
  return extras.length > 0 ? [...apps, ...extras] : apps
}
