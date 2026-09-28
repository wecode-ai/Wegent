import type { InstalledPlugin, PluginMarketplaceItem } from '@/types/api'

export type PluginDistribution = 'official' | 'enterprise' | 'personal' | 'unknown'

export interface PluginTelemetryIdentity extends Readonly<Record<string, unknown>> {
  readonly plugin_distribution: PluginDistribution
  readonly plugin_id: string
}

const MARKETPLACE_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/
const PLUGIN_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,95}$/

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

function opaqueSegment(value: string): string {
  let hash = 0xcbf29ce484222325n
  for (let index = 0; index < value.length; index += 1) {
    hash ^= BigInt(value.charCodeAt(index))
    hash = BigInt.asUintN(64, hash * 0x100000001b3n)
  }
  return `opaque-${hash.toString(16).padStart(16, '0')}`
}

function safeSegment(value: string, pattern: RegExp): string {
  const normalized = value.trim().toLowerCase()
  return pattern.test(normalized) ? normalized : opaqueSegment(normalized || 'unknown')
}

export function pluginTelemetryIdentityFromParts(input: {
  distribution?: PluginDistribution
  marketplace: string
  pluginKey: string
  sourceProvider?: string | null
  visibility?: string | null
}): PluginTelemetryIdentity {
  const marketplace = input.marketplace.trim().toLowerCase()
  const distribution: PluginDistribution =
    input.distribution ??
    (input.visibility === 'personal' ||
    input.sourceProvider === 'user' ||
    marketplace.includes('personal')
      ? 'personal'
      : input.visibility === 'workspace' || marketplace === 'wegent'
        ? 'enterprise'
        : input.sourceProvider === 'codex' ||
            marketplace === 'wework' ||
            marketplace.includes('openai')
          ? 'official'
          : 'unknown')
  const publicMarketplace = distribution === 'personal' ? 'personal' : marketplace || distribution
  return {
    plugin_distribution: distribution,
    plugin_id: `${safeSegment(publicMarketplace, MARKETPLACE_PATTERN)}/${safeSegment(input.pluginKey, PLUGIN_KEY_PATTERN)}`,
  }
}

export function installedPluginTelemetryIdentity(plugin: InstalledPlugin): PluginTelemetryIdentity {
  const payload = record(plugin.spec.sourcePayload)
  const isPersonal =
    plugin.spec.visibility === 'personal' ||
    plugin.spec.origin === 'created' ||
    plugin.spec.source?.type === 'local' ||
    plugin.spec.sourceProvider === 'user'
  return pluginTelemetryIdentityFromParts({
    marketplace: isPersonal
      ? 'personal'
      : String(
          payload.marketplaceName ??
            plugin.spec.source?.marketplace ??
            plugin.spec.source?.providerKey ??
            'unknown'
        ),
    pluginKey: plugin.spec.source?.pluginKey || String(plugin.metadata.name ?? 'unknown'),
    sourceProvider: isPersonal ? 'user' : plugin.spec.sourceProvider,
    visibility: isPersonal ? 'personal' : plugin.spec.visibility,
  })
}

export function marketplacePluginTelemetryIdentity(
  plugin: PluginMarketplaceItem
): PluginTelemetryIdentity {
  const manifest = record(plugin.manifest)
  const marketplace =
    plugin.visibility === 'personal' || plugin.sourceProvider === 'user'
      ? 'personal'
      : String(manifest.marketplaceId ?? plugin.sourceProvider ?? 'unknown')
  return pluginTelemetryIdentityFromParts({
    marketplace,
    pluginKey: plugin.name || String(plugin.id),
    sourceProvider: plugin.sourceProvider,
    visibility: plugin.visibility,
  })
}
