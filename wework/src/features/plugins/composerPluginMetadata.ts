import type { InstalledPlugin, LocalDeviceApp } from '@/types/api'
import { pluginTrialTemplates } from './pluginTrial'

function normalized(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase()
}

export function composerAppPluginKey(app: LocalDeviceApp): string {
  if (app.source === 'installed-plugin') {
    return app.id.replace(/^plugin:/, '')
  }
  if (app.source === 'wegent-connector') {
    return app.id.replace(/^wegent:/, '')
  }
  return app.pluginDisplayNames?.[0] ?? app.id
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
    plugin.spec.source?.marketplace ||
    // Cloud InstalledPlugin rows use namespace "default"; composer mentions need the
    // marketplace id (wegent / openai-official / …), not the Kind namespace.
    (metadataNamespace && metadataNamespace !== 'default' ? metadataNamespace : null) ||
    (plugin.spec.source?.providerKey === 'wegent-market' ? 'wegent' : null)
  if (typeof pluginName !== 'string' || !pluginName.trim()) return null
  if (typeof marketplaceName !== 'string' || !marketplaceName.trim()) return null
  return `plugin://${pluginName}@${marketplaceName}`
}

function skillFilePath(path: string): string {
  return path.endsWith('/SKILL.md') ? path : `${path.replace(/\/+$/, '')}/SKILL.md`
}

function installedPluginAsComposerApp(plugin: InstalledPlugin): LocalDeviceApp | null {
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
    trialTemplates: pluginTrialTemplates(plugin),
  }
}

export function enrichComposerApps(
  apps: LocalDeviceApp[],
  installedPlugins: InstalledPlugin[]
): LocalDeviceApp[] {
  return apps.flatMap(app => {
    try {
      const plugin = bestPluginForApp(app, installedPlugins)
      // Composer only lists installed plugins. Remote Codex apps and authorized
      // cloud connectors are not shown unless they match an installed plugin.
      if (!plugin) return []
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
          trialTemplates: pluginTrialTemplates(plugin),
        },
      ]
    } catch (error) {
      console.warn('[Wework] Skipping Codex app for composer menu.', error)
      return []
    }
  })
}

/** Include enabled installed plugins that have no Codex/app entry yet (e.g. skill-only). */
export function appendInstalledPluginsAsComposerApps(
  apps: LocalDeviceApp[],
  installedPlugins: InstalledPlugin[]
): LocalDeviceApp[] {
  const extras: LocalDeviceApp[] = []
  for (const plugin of installedPlugins) {
    try {
      if (!isComposerVisiblePlugin(plugin)) continue
      if (apps.some(app => pluginMatchScore(app, plugin) > 0)) continue
      const entry = installedPluginAsComposerApp(plugin)
      if (entry) extras.push(entry)
    } catch (error) {
      console.warn('[Wework] Skipping installed plugin for composer menu.', error)
    }
  }
  return extras.length > 0 ? [...apps, ...extras] : apps
}
