import { toInstalledPlugin } from '@wegent/chat-core/codex-installed-plugins'
import type { InstalledPlugin } from '@/types/api'
import i18n from '@/i18n'
import {
  CODEX_PERSONAL_MARKETPLACE_ID,
  WEWORK_PERSONAL_MARKETPLACE_ID,
} from '@/features/plugins/builtinPlugins'

export interface PersonalMarketplacePluginSummary {
  name: string
  version?: string | null
  displayName?: string | null
  description?: string | null
  logo?: string | null
  category?: string | null
  marketplacePath?: string | null
  pluginPath: string
}

export interface PersonalMarketplaceListResult {
  marketplaceId: string
  marketplacePath: string
  plugins: PersonalMarketplacePluginSummary[]
}

interface PersonalPluginConfig {
  enabledPluginKeys?: string[]
  disabledPluginKeys?: string[]
}

/** The owned source and local configuration establish membership independently of Codex. */
export function personalInstalledFromDisk(
  personal: PersonalMarketplaceListResult | null,
  config: PersonalPluginConfig | null,
  previous: InstalledPlugin[]
): InstalledPlugin[] {
  const enabled = config && new Set(config.enabledPluginKeys ?? [])
  const installed =
    config && new Set([...(config.enabledPluginKeys ?? []), ...(config.disabledPluginKeys ?? [])])
  const keys = (name: string) =>
    [WEWORK_PERSONAL_MARKETPLACE_ID, CODEX_PERSONAL_MARKETPLACE_ID].map(
      market => `${name}@${market}`
    )
  if (!personal || !config)
    return previous.filter(
      plugin =>
        (!personal || personal.plugins.some(item => item.name === plugin.spec.source.pluginKey)) &&
        (!installed || keys(plugin.spec.source.pluginKey).some(key => installed.has(key)))
    )
  return personal.plugins
    .filter(plugin => keys(plugin.name).some(key => installed!.has(key)))
    .map(plugin =>
      toInstalledPlugin(
        {
          name: WEWORK_PERSONAL_MARKETPLACE_ID,
          path:
            plugin.marketplacePath || personal.marketplacePath || WEWORK_PERSONAL_MARKETPLACE_ID,
          interface: { displayName: WEWORK_PERSONAL_MARKETPLACE_ID },
          plugins: [],
        },
        {
          name: plugin.name,
          id: `${plugin.name}@${WEWORK_PERSONAL_MARKETPLACE_ID}`,
          source: { source: 'local', path: plugin.pluginPath },
          installed: true,
          enabled: keys(plugin.name).some(key => enabled!.has(key)),
          localVersion: plugin.version ?? undefined,
          interface: {
            displayName: plugin.displayName ?? plugin.name,
            shortDescription: plugin.description ?? '',
            logo: plugin.logo ?? null,
            category: plugin.category ?? null,
          },
        },
        null,
        key => i18n.t(key)
      )
    )
}

/** Enrich surviving members only; runtime summaries cannot add or remove a disk member. */
export function withPersonalInventoryDetails(
  items: InstalledPlugin[],
  summaries: InstalledPlugin[]
): InstalledPlugin[] {
  return items.map(item => {
    const summary = summaries.find(
      candidate => candidate.spec.source.pluginKey === item.spec.source.pluginKey
    )
    if (!summary) return item
    const sourcePayload = { ...summary.spec.sourcePayload }
    for (const key of ['cloudPluginId', 'cloudReleaseId', 'cloudInstalledPluginId']) {
      delete sourcePayload[key]
      if (item.spec.sourcePayload?.[key] !== undefined)
        sourcePayload[key] = item.spec.sourcePayload[key]
    }
    return {
      ...summary,
      spec: {
        ...summary.spec,
        enabled: item.spec.enabled,
        version: item.spec.version ?? summary.spec.version,
        sourcePayload,
      },
      status: { ...summary.status, state: item.spec.enabled ? 'enabled' : 'disabled' },
    }
  })
}
