import {
  isLocalQrConnector,
  localConnectorAuthHealth,
  type LocalConnectorAuthTarget,
} from '@/api/local/localConnectorAuth'
import { parsePluginUri } from '@/features/plugins/pluginNavigation'
import type { InstalledPlugin, PluginLocalAuthDefinition } from '@/types/api'

const PLUGIN_URI_PATTERN = /plugin:\/\/[^\s)\]]+/g

export interface LocalQrConnectorRequirement {
  plugin: InstalledPlugin
  pluginKey: string
  connectorSlug: string
  localAuth: PluginLocalAuthDefinition
  displayName: string
}

function normalized(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

function pluginMatchesName(plugin: InstalledPlugin, pluginName: string): boolean {
  const wanted = normalized(pluginName)
  if (!wanted) return false
  const candidates = [
    plugin.spec.source.pluginKey,
    plugin.spec.displayName,
    plugin.metadata.name,
    plugin.spec.source.catalogItemId,
  ]
  return candidates.some(candidate => normalized(candidate) === wanted)
}

export function listLocalQrConnectors(
  plugins: InstalledPlugin[],
  options?: { authPolicies?: Array<'on_install' | 'on_use' | 'optional'> }
): LocalQrConnectorRequirement[] {
  const policies = new Set(options?.authPolicies ?? ['on_install', 'on_use', 'optional'])
  const results: LocalQrConnectorRequirement[] = []
  for (const plugin of plugins) {
    for (const connector of plugin.spec.components.connectors ?? []) {
      if (!policies.has(connector.authPolicy)) continue
      if (!isLocalQrConnector(connector) || !connector.localAuth) continue
      results.push({
        plugin,
        pluginKey: String(plugin.spec.source.pluginKey || plugin.metadata.name),
        connectorSlug: connector.slug,
        localAuth: connector.localAuth,
        displayName: String(plugin.spec.displayName || plugin.spec.source.pluginKey),
      })
    }
  }
  return results
}

export function findLocalQrConnectorsForMessage(
  message: string,
  plugins: InstalledPlugin[]
): LocalQrConnectorRequirement[] {
  const uris = message.match(PLUGIN_URI_PATTERN) ?? []
  if (uris.length === 0) {
    // Also gate plugins with on_use when message doesn't mention them but skills may still load.
    // Prefer explicit mentions; fall back to all enabled on_install/on_use local_qr plugins only
    // when the message clearly references their display name.
    return listLocalQrConnectors(plugins, { authPolicies: ['on_install', 'on_use'] }).filter(
      requirement => {
        const name = requirement.displayName.trim()
        const key = requirement.pluginKey.trim()
        if (!name && !key) return false
        const lower = message.toLowerCase()
        return (
          (name.length > 0 && lower.includes(name.toLowerCase())) ||
          (key.length > 0 && lower.includes(key.toLowerCase()))
        )
      }
    )
  }

  const mentioned = new Set<string>()
  for (const uri of uris) {
    const parsed = parsePluginUri(uri)
    if (parsed) mentioned.add(normalized(parsed.pluginName))
  }

  return listLocalQrConnectors(plugins, {
    authPolicies: ['on_install', 'on_use', 'optional'],
  }).filter(
    requirement =>
      mentioned.has(normalized(requirement.pluginKey)) ||
      mentioned.has(normalized(requirement.displayName)) ||
      plugins.some(
        plugin =>
          plugin === requirement.plugin &&
          [...mentioned].some(name => pluginMatchesName(plugin, name))
      )
  )
}

export function toLocalConnectorAuthTarget(
  requirement: LocalQrConnectorRequirement
): LocalConnectorAuthTarget {
  return {
    pluginKey: requirement.pluginKey,
    connectorSlug: requirement.connectorSlug,
    localAuth: requirement.localAuth,
  }
}

export async function findFirstLocalQrNeedingLogin(
  requirements: LocalQrConnectorRequirement[]
): Promise<LocalQrConnectorRequirement | null> {
  for (const requirement of requirements) {
    try {
      const health = await localConnectorAuthHealth(toLocalConnectorAuthTarget(requirement))
      if (health.status === 'ok') continue
      return requirement
    } catch {
      return requirement
    }
  }
  return null
}

export function messageRequiresConnectorAuth(text: string | null | undefined): boolean {
  if (!text) return false
  return (
    text.includes('connector_auth_required') ||
    /"error"\s*:\s*"connector_auth_required"/i.test(text) ||
    /需要重新登录|会话已过期|need_login/i.test(text)
  )
}

export function extractConnectorAuthPluginKey(text: string | null | undefined): string | null {
  if (!text) return null
  const match =
    text.match(/"plugin(?:Key|_key)"\s*:\s*"([^"]+)"/i) ||
    text.match(/pluginKey[=:]\s*([a-z0-9._-]+)/i)
  return match?.[1] ?? null
}
