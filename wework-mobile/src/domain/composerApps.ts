import type { RuntimeComposerApp, RuntimeInstalledPlugin } from '@/types/runtime'

export function composerApps(installedPlugins: RuntimeInstalledPlugin[]): RuntimeComposerApp[] {
  return deduplicateApps(
    installedPlugins.filter(isComposerVisiblePlugin).flatMap(plugin => {
      const reference = installedPluginReference(plugin)
      if (!reference) return []
      return [
        {
          id: plugin.spec.source.pluginKey,
          name: plugin.spec.displayName || plugin.spec.source.pluginKey,
          description: plugin.spec.description || null,
          logoUrl: plugin.spec.interface?.logo ?? null,
          reference,
        },
      ]
    })
  )
}

export function composerMessage(message: string, apps: RuntimeComposerApp[]): string {
  return [message.trim(), ...apps.map(app => app.reference.trim())].filter(Boolean).join(' ')
}

export function composerLogoUrl(value: string | null | undefined): string | null {
  const url = value?.trim()
  return url && /^(https?:|data:)/i.test(url) ? url : null
}

function installedPluginReference(plugin: RuntimeInstalledPlugin): string | null {
  const name = plugin.spec.displayName || plugin.spec.source.pluginKey
  const app = plugin.spec.components?.apps?.find(item => item.name)
  if (app) return `[$${name}](app://${app.name})`

  const payload = plugin.spec.sourcePayload ?? {}
  const pluginName =
    stringValue(payload.pluginName) ||
    stringValue(payload.remotePluginId) ||
    plugin.spec.source.pluginKey ||
    plugin.metadata.name
  const marketplace =
    stringValue(payload.marketplaceName) ||
    plugin.spec.source.marketplace ||
    (plugin.metadata.namespace && plugin.metadata.namespace !== 'default'
      ? plugin.metadata.namespace
      : null)
  const target =
    pluginName && marketplace
      ? `plugin://${pluginName}@${marketplace}`
      : skillReference(plugin) || commandReference(plugin)
  return target ? `[$${name}](${target})` : null
}

function skillReference(plugin: RuntimeInstalledPlugin): string | null {
  const skill = plugin.spec.components?.skills?.find(item => item.name && item.path)
  if (!skill?.path) return null
  return skill.path.endsWith('/SKILL.md')
    ? skill.path
    : `${skill.path.replace(/\/+$/, '')}/SKILL.md`
}

function commandReference(plugin: RuntimeInstalledPlugin): string | null {
  const command = plugin.spec.components?.commands?.find(item => item.name)
  return command ? `command://${command.name}` : null
}

function isComposerVisiblePlugin(plugin: RuntimeInstalledPlugin): boolean {
  return plugin.spec.enabled && ['installed', 'update_available'].includes(plugin.spec.installState)
}

function deduplicateApps(apps: RuntimeComposerApp[]): RuntimeComposerApp[] {
  const seen = new Set<string>()
  return apps.filter(app => {
    const key = app.reference.trim().toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}
