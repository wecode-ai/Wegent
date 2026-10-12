import { installedPluginMarketplaceId } from '@/components/plugins/pluginDistribution'
import {
  mergeInstalledPluginSummaries,
  toInstalledPlugin,
  isLocalMarketplacePath,
} from '@wegent/chat-core/codex-installed-plugins'
import type {
  CodexPluginMarketplaceEntry,
  CodexPluginDetail,
} from '@wegent/chat-core/codex-plugin-types'
import {
  createLocalCodexPluginApi,
  toMarketplaceItem,
  applyInstalledPluginsToMarketplaceItems,
  pluginEnabledConfigKeyPath,
  installedPluginConfigId,
  writeCodexPluginEnabled,
  pluginMarketplaceIdentity,
  resolveRemoteInstallPluginNames,
  isRetriablePluginInstallCandidateError,
  type LocalCodexPluginApi,
} from './local/codexPlugins'
import { remotePluginInstallation } from './local/codexPluginInstallation'
import type { InstalledPlugin, PluginMarketplaceItem } from '@/types/api'
import i18n from '@/i18n'

export type ProjectDevicePluginApi = Pick<
  LocalCodexPluginApi,
  'readState' | 'installAvailablePlugin'
>
export type ProjectPluginRequest = <T>(
  method: string,
  params: Record<string, unknown>
) => Promise<T>

function pluginMatches(plugin: InstalledPlugin, item: PluginMarketplaceItem): boolean {
  return (
    pluginMarketplaceIdentity(
      String(plugin.spec.source.pluginKey || plugin.metadata.name || ''),
      installedPluginMarketplaceId(plugin) || ''
    ) === pluginMarketplaceIdentity(item.name, String(item.manifest.marketplaceId || ''))
  )
}

/** Project installation changes global activation only for a newly installed plugin. */
export function createLocalProjectDevicePluginApi(): ProjectDevicePluginApi {
  const local = createLocalCodexPluginApi()
  return {
    readState: local.readState,
    async installAvailablePlugin(item) {
      const before = await local.readState({ mergeAllMarketplaces: true, refresh: true })
      const existing = before.installedPlugins.find(plugin => pluginMatches(plugin, item))
      if (existing) return existing
      const installed = await local.installAvailablePlugin(item)
      const labels = installed.metadata.labels as Record<string, unknown> | undefined
      const id = labels?.id
      if (installed.spec.enabled) {
        if (typeof id !== 'string' && typeof id !== 'number')
          throw new Error('Installed plugin identity is missing')
        await writeCodexPluginEnabled(installedPluginConfigId(installed, id), false)
      }
      return { ...installed, spec: { ...installed.spec, enabled: false } }
    },
  }
}

/** Each instance belongs to exactly one execution device; inventory never crosses devices. */
export function createRemoteProjectDevicePluginApi(
  deviceId: string,
  request: ProjectPluginRequest
): ProjectDevicePluginApi {
  let generation = 0
  let cached: Awaited<ReturnType<ProjectDevicePluginApi['readState']>> | null = null
  const installedInventory = async () => {
    const result = await request<{ marketplaces: CodexPluginMarketplaceEntry[] }>(
      'plugin/installed',
      {}
    )
    return mergeInstalledPluginSummaries(result.marketplaces, [], key => i18n.t(key))
  }
  return {
    async readState(params = {}) {
      if (cached && !params.refresh) return cached
      const revision = generation
      const installedPlugins = await installedInventory()
      const result = await request<{ marketplaces: CodexPluginMarketplaceEntry[] }>('plugin/list', {
        cwds: null,
      })
      const marketplaceItems = applyInstalledPluginsToMarketplaceItems(
        result.marketplaces.flatMap(marketplace =>
          marketplace.plugins.map(plugin => toMarketplaceItem(marketplace, plugin))
        ),
        installedPlugins
      )
      const state = {
        marketplaceItems,
        installedPlugins,
        deviceId,
        marketplaces: result.marketplaces.map(marketplace => ({
          id: marketplace.name,
          name: marketplace.name,
          path: marketplace.path || marketplace.name,
        })),
        selectedMarketplaceId: result.marketplaces[0]?.name || '',
        marketplacePath: '',
        installRegistryPath: '',
      }
      if (revision === generation) cached = state
      return state
    },
    async installAvailablePlugin(item) {
      const existing = (await installedInventory()).find(plugin => pluginMatches(plugin, item))
      if (existing) return existing
      const marketplaceId = String(item.manifest.marketplaceId || '').trim()
      if (!marketplaceId || !item.name.trim())
        throw new Error('Plugin marketplace or name is missing')
      const marketplacePath =
        typeof item.manifest.marketplacePath === 'string' ? item.manifest.marketplacePath : ''
      const local = isLocalMarketplacePath(marketplacePath)
      const installNames = local
        ? [item.name]
        : await resolveRemoteInstallPluginNames(
            { id: marketplaceId, name: marketplaceId, path: marketplacePath || marketplaceId },
            item,
            async (_marketplace, pluginName) =>
              (
                await request<{ plugin: CodexPluginDetail }>('plugin/read', {
                  marketplacePath: null,
                  remoteMarketplaceName: marketplaceId,
                  pluginName,
                })
              ).plugin
          )
      let result: unknown
      for (let index = 0; index < installNames.length; index += 1) {
        try {
          result = await request('plugin/install', {
            marketplacePath: local ? marketplacePath : null,
            remoteMarketplaceName: local ? null : marketplaceId,
            pluginName: installNames[index],
          })
          break
        } catch (error) {
          if (
            index === installNames.length - 1 ||
            !isRetriablePluginInstallCandidateError(
              error instanceof Error ? error.message : String(error)
            )
          )
            throw error
        }
      }
      generation += 1
      cached = null
      const installed = local
        ? toInstalledPlugin(
            { name: marketplaceId, path: marketplacePath, plugins: [] },
            {
              id: String(item.manifest.id || `${item.name}@${marketplaceId}`),
              name: item.name,
              installed: true,
              enabled: true,
              interface: item.interface,
            },
            undefined,
            key => i18n.t(key)
          )
        : remotePluginInstallation(item, result)
      await request('config/value/write', {
        keyPath: pluginEnabledConfigKeyPath(`${item.name}@${marketplaceId}`),
        value: false,
        mergeStrategy: 'upsert',
      })
      return { ...installed, spec: { ...installed.spec, enabled: false } }
    },
  }
}
