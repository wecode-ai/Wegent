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
import {
  projectEditingCapabilities,
  projectEditingDeviceRevision,
  type ProjectPluginSupport,
} from '@/lib/project-editing-capabilities'
import type { DeviceInfo } from '@/types/api'

export type ProjectDevicePluginApi = Pick<
  LocalCodexPluginApi,
  'readState' | 'installAvailablePlugin'
> & {
  observeDevice?: (device: DeviceInfo | null) => void
  invalidate?: () => void
  checkSupport?: () => Promise<void>
}

export class ProjectPluginsUnsupportedError extends Error {
  constructor() {
    super(i18n.t('common:workbench.project_plugins_upgrade_required'))
    this.name = 'ProjectPluginsUnsupportedError'
  }
}
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
  let inventoryRevision = 0
  let cached: Awaited<ReturnType<ProjectDevicePluginApi['readState']>> | null = null
  let deviceRevision: string | null = null
  let support: 'supported' | 'unsupported' | 'unknown' = 'unknown'
  let advertisedSupport: ProjectPluginSupport = 'unknown'
  let available = true
  let supportRequest: Promise<void> | null = null
  const invalidate = () => {
    generation += 1
    cached = null
    supportRequest = null
    support = advertisedSupport
  }
  const ensureSameRuntime = (revision: number) => {
    if (revision !== generation) throw new Error(i18n.t('common:workbench.project_runtime_changed'))
    if (!available) throw new Error(i18n.t('common:workbench.project_device_offline_settings'))
  }
  const installedInventory = async () => {
    ensureSameRuntime(generation)
    if (support === 'unsupported') throw new ProjectPluginsUnsupportedError()
    const revision = generation
    try {
      const result = await request<{ marketplaces: CodexPluginMarketplaceEntry[] }>(
        'plugin/installed',
        {}
      )
      ensureSameRuntime(revision)
      support = 'supported'
      return mergeInstalledPluginSummaries(result.marketplaces, [], key => i18n.t(key))
    } catch (error) {
      if (
        error instanceof Error &&
        /^(?:(?:unsupported_method|runtime_rpc_failed): )?Unsupported runtime RPC method: runtime\.codex\.app_server\.request$/.test(
          error.message.trim()
        )
      ) {
        if (revision === generation) support = 'unsupported'
        throw new ProjectPluginsUnsupportedError()
      }
      throw error
    }
  }
  return {
    observeDevice(device) {
      const revision = projectEditingDeviceRevision(device)
      if (revision === deviceRevision) return
      deviceRevision = revision
      available = Boolean(device && (device.status === 'online' || device.status === 'busy'))
      advertisedSupport = projectEditingCapabilities(device).plugins
      invalidate()
    },
    invalidate,
    async checkSupport() {
      ensureSameRuntime(generation)
      if (support === 'unsupported') throw new ProjectPluginsUnsupportedError()
      if (support === 'supported') return
      if (!supportRequest) {
        const pending = installedInventory().then(() => undefined)
        supportRequest = pending
        void pending
          .finally(() => {
            if (supportRequest === pending) supportRequest = null
          })
          .catch(() => undefined)
      }
      await supportRequest
    },
    async readState(params = {}) {
      if (cached && !params.refresh) return cached
      const revision = generation
      const readInventoryRevision = inventoryRevision
      const installedPlugins = await installedInventory()
      ensureSameRuntime(revision)
      const result = await request<{ marketplaces: CodexPluginMarketplaceEntry[] }>('plugin/list', {
        cwds: null,
      })
      ensureSameRuntime(revision)
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
      if (readInventoryRevision === inventoryRevision) cached = state
      return state
    },
    async installAvailablePlugin(item) {
      const revision = generation
      const existing = (await installedInventory()).find(plugin => pluginMatches(plugin, item))
      ensureSameRuntime(revision)
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
        ensureSameRuntime(revision)
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
      ensureSameRuntime(revision)
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
      ensureSameRuntime(revision)
      inventoryRevision += 1
      cached = null
      return { ...installed, spec: { ...installed.spec, enabled: false } }
    },
  }
}
