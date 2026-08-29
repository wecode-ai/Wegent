import {
  isLocalConnector,
  localConnectorAuthHealth,
  type LocalConnectorAuthTarget,
} from '@/api/local/localConnectorAuth'
import { parsePluginUri } from '@/features/plugins/pluginNavigation'
import type { InstalledPlugin, PluginLocalAuthDefinition } from '@/types/api'
import type { WorkbenchMessage } from '@/types/workbench'

const PLUGIN_URI_PATTERN = /plugin:\/\/[^\s)\]]+/g
const CONNECTOR_AUTH_TEXT_LIMIT = 64 * 1024
const CONNECTOR_AUTH_FIELD_TEXT_LIMIT = 16 * 1024
const CONNECTOR_AUTH_OBJECT_KEYS = [
  'error',
  'message',
  'detail',
  'content',
  'text',
  'output',
  'stderr',
  'pluginKey',
  'plugin_key',
  'connectorSlug',
  'connector_slug',
  'data',
  'result',
  'cause',
  'response',
] as const

export interface LocalConnectorRequirement {
  plugin: InstalledPlugin
  pluginKey: string
  connectorSlug: string
  localAuth: PluginLocalAuthDefinition
  displayName: string
}

export interface MentionedPluginReference {
  pluginName: string
  marketplaceName: string
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

export function listLocalConnectors(
  plugins: InstalledPlugin[],
  options?: { authPolicies?: Array<'on_install' | 'on_use' | 'optional'> }
): LocalConnectorRequirement[] {
  const policies = new Set(options?.authPolicies ?? ['on_install', 'on_use', 'optional'])
  const results: LocalConnectorRequirement[] = []
  for (const plugin of plugins) {
    for (const connector of plugin.spec.components.connectors ?? []) {
      if (!policies.has(connector.authPolicy)) continue
      if (!isLocalConnector(connector) || !connector.localAuth) continue
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

export function findLocalConnectorsForMessage(
  message: string,
  plugins: InstalledPlugin[]
): LocalConnectorRequirement[] {
  const uris = message.match(PLUGIN_URI_PATTERN) ?? []
  if (uris.length === 0) {
    // Also gate plugins with on_use when message doesn't mention them but skills may still load.
    // Prefer explicit mentions; fall back to enabled on_install/on_use local connectors only
    // when the message clearly references their display name.
    return listLocalConnectors(plugins, { authPolicies: ['on_install', 'on_use'] }).filter(
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

  return listLocalConnectors(plugins, {
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

export function messageNeedsConnectorPreflight(text: string | null | undefined): boolean {
  if (!text) return false
  return text.match(PLUGIN_URI_PATTERN) !== null || resolveLocalConnectorAuthHint(text) !== null
}

/** Plugin names referenced by explicit `plugin://` mentions in composer text. */
export function listMentionedPluginNames(text: string | null | undefined): string[] {
  if (!text) return []
  const names = new Set<string>()
  for (const uri of text.match(PLUGIN_URI_PATTERN) ?? []) {
    const parsed = parsePluginUri(uri)
    if (parsed?.pluginName) names.add(parsed.pluginName)
  }
  return Array.from(names)
}

export function listMentionedPluginReferences(
  text: string | null | undefined
): MentionedPluginReference[] {
  if (!text) return []
  const seen = new Set<string>()
  const refs: MentionedPluginReference[] = []
  for (const uri of text.match(PLUGIN_URI_PATTERN) ?? []) {
    const parsed = parsePluginUri(uri)
    if (!parsed?.pluginName || !parsed.marketplaceName) continue
    const pluginName = parsed.pluginName.trim()
    const marketplaceName = parsed.marketplaceName.trim()
    if (!pluginName || !marketplaceName) continue
    const key = `${pluginName.toLowerCase()}@@${marketplaceName.toLowerCase()}`
    if (seen.has(key)) continue
    seen.add(key)
    refs.push({ pluginName, marketplaceName })
  }
  return refs
}

export function installedPluginMatchesName(plugin: InstalledPlugin, pluginName: string): boolean {
  return pluginMatchesName(plugin, pluginName)
}

export function toLocalConnectorAuthTarget(
  requirement: LocalConnectorRequirement
): LocalConnectorAuthTarget {
  return {
    pluginKey: requirement.pluginKey,
    connectorSlug: requirement.connectorSlug,
    localAuth: requirement.localAuth,
  }
}

export async function findFirstLocalNeedingLogin(
  requirements: LocalConnectorRequirement[]
): Promise<LocalConnectorRequirement | null> {
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

function appendBoundedText(parts: string[], value: string, remaining: number): number {
  if (remaining <= 0 || !value) return remaining
  const separatorLength = parts.length > 0 ? 1 : 0
  const available = Math.min(remaining - separatorLength, CONNECTOR_AUTH_FIELD_TEXT_LIMIT)
  if (available <= 0) return remaining
  if (value.length <= available) {
    parts.push(value)
    return remaining - separatorLength - value.length
  }

  const headLength = Math.floor(available / 2)
  const tailLength = available - headLength
  parts.push(value.slice(0, headLength) + value.slice(-tailLength))
  return remaining - separatorLength - available
}

function appendConnectorAuthObjectText(
  parts: string[],
  value: unknown,
  remaining: number,
  depth = 0
): number {
  if (remaining <= 0 || value == null || depth > 3) return remaining
  if (typeof value === 'string') return appendBoundedText(parts, value, remaining)
  if (typeof value !== 'object') return remaining

  const record = value as Record<string, unknown>
  for (const key of CONNECTOR_AUTH_OBJECT_KEYS) {
    const field = record[key]
    if (field == null) continue
    if (typeof field === 'string') {
      remaining = appendBoundedText(parts, `${key}=${field}`, remaining)
    } else {
      remaining = appendConnectorAuthObjectText(parts, field, remaining, depth + 1)
    }
    if (remaining <= 0) break
  }
  return remaining
}

export function connectorAuthMessageText(message: WorkbenchMessage): string {
  const parts: string[] = []
  let remaining = CONNECTOR_AUTH_TEXT_LIMIT
  remaining = appendBoundedText(parts, message.error ?? '', remaining)

  for (const block of [...(message.blocks ?? [])].reverse()) {
    if (remaining <= 0) break
    if ('content' in block && typeof block.content === 'string') {
      remaining = appendBoundedText(parts, block.content, remaining)
    }
    if ('toolOutput' in block) {
      remaining = appendConnectorAuthObjectText(parts, block.toolOutput, remaining)
    }
  }
  appendBoundedText(parts, message.content, remaining)
  return parts.join('\n')
}

export function latestConnectorAuthMessage(
  messages: WorkbenchMessage[]
): { message: WorkbenchMessage; text: string } | null {
  const message = messages.findLast(
    candidate => candidate.role === 'assistant' || candidate.role === 'system'
  )
  if (!message) return null

  const text = connectorAuthMessageText(message)
  return messageRequiresConnectorAuth(text) ? { message, text } : null
}

export function messageRequiresConnectorAuth(text: string | null | undefined): boolean {
  if (!text) return false
  if (
    text.includes('connector_auth_required') ||
    /"error"\s*:\s*"connector_auth_required"/i.test(text) ||
    /need_login/i.test(text)
  ) {
    return true
  }
  // Agents often paraphrase the machine error; match host-resume phrasing.
  return /尚未登录|需要重新登录|会话已过期|登录会话已失效|重新认证|身份认证|主机连接器|二维码(?:登录|卡片)|扫码登录|\b\w[\w.-]*\s+Connector\b/i.test(
    text
  )
}

export function extractConnectorAuthPluginKey(text: string | null | undefined): string | null {
  if (!text) return null
  const match =
    text.match(/"plugin(?:Key|_key)"\s*:\s*"([^"]+)"/i) ||
    text.match(/pluginKey[=:]\s*([a-z0-9._-]+)/i)
  return match?.[1] ?? null
}

export function extractConnectorAuthConnectorSlug(text: string | null | undefined): string | null {
  if (!text) return null
  const match =
    text.match(/"connector(?:Slug|_slug)"\s*:\s*"([^"]+)"/i) ||
    text.match(/connectorSlug[=:]\s*([a-z0-9._-]+)/i)
  if (match?.[1]) return match[1]
  const prose = text.match(/\b([a-z][a-z0-9._-]*)\s+Connector\b/i)
  return prose?.[1] ?? null
}

/**
 * Build a minimal auth target from assistant/tool text.
 * Prefer structured `pluginKey` / `connectorSlug` fields. When only a connector
 * slug is present, use it as a last-resort pluginKey so the executor can resolve
 * localAuth from the installed plugin manifest. Prefer matching installed
 * plugins via `filterLocalRequirements` before relying on this hint.
 */
export function resolveLocalConnectorAuthHint(
  text: string | null | undefined
): { pluginKey: string; connectorSlug: string; displayName: string } | null {
  if (!text || !messageRequiresConnectorAuth(text)) return null
  const pluginKey = extractConnectorAuthPluginKey(text)
  const connectorSlug = extractConnectorAuthConnectorSlug(text)
  if (pluginKey && connectorSlug) {
    return { pluginKey, connectorSlug, displayName: pluginKey }
  }
  if (!pluginKey && connectorSlug) {
    return { pluginKey: connectorSlug, connectorSlug, displayName: connectorSlug }
  }
  return null
}

function pluginHasLocalConnector(plugin: InstalledPlugin): boolean {
  return (plugin.spec.components.connectors ?? []).some(connector => isLocalConnector(connector))
}

/**
 * `plugin/installed` summaries omit connector localAuth. Enrich from plugin/read
 * so mid-task QR resume can resolve health/start/poll commands.
 *
 * Callers on the send path must pass `shouldEnrich` so only mentioned plugins are
 * detailed — never fan out `plugin/read` (or worse, `plugin/list`) across the
 * whole install set before a conversation can open.
 */
export async function enrichInstalledPluginsForLocalAuth(
  plugins: InstalledPlugin[],
  readDetail: (plugin: InstalledPlugin) => Promise<InstalledPlugin>,
  options?: { shouldEnrich?: (plugin: InstalledPlugin) => boolean }
): Promise<InstalledPlugin[]> {
  const shouldEnrich = options?.shouldEnrich
  return Promise.all(
    plugins.map(async plugin => {
      if (pluginHasLocalConnector(plugin)) return plugin
      if (shouldEnrich && !shouldEnrich(plugin)) return plugin
      try {
        const detailed = await readDetail(plugin)
        return pluginHasLocalConnector(detailed) ? detailed : plugin
      } catch {
        return plugin
      }
    })
  )
}

export function filterLocalRequirements(
  plugins: InstalledPlugin[],
  options?: {
    pluginKey?: string | null
    connectorSlug?: string | null
  }
): LocalConnectorRequirement[] {
  const pluginKey = options?.pluginKey?.trim()
  const connectorSlug = options?.connectorSlug?.trim()
  // Resume/auth cards must target an explicit plugin or connector. Never return
  // every local connector — that incorrectly surfaces unrelated QR flows
  // (e.g. Wegent) during GitHub cloud-connector failures.
  if (!pluginKey && !connectorSlug) return []

  let requirements = pluginKey
    ? listLocalConnectors(plugins).filter(
        item =>
          item.pluginKey.toLowerCase() === pluginKey.toLowerCase() ||
          item.displayName.toLowerCase() === pluginKey.toLowerCase()
      )
    : listLocalConnectors(plugins, { authPolicies: ['on_install', 'on_use'] })
  if (connectorSlug) {
    const matched = requirements.filter(
      item => item.connectorSlug.toLowerCase() === connectorSlug.toLowerCase()
    )
    if (matched.length > 0) requirements = matched
    else if (!pluginKey) requirements = []
  }
  return requirements
}
