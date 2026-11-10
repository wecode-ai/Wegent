import { getKnownLocalExecutorDeviceId, requestLocalExecutor } from '@/desktop/localExecutor'
import type { createPluginApi } from '@/api/plugins'
import type {
  DeviceCapabilitySyncResponse,
  InstalledPlugin,
  PluginDeviceSyncResponse,
} from '@/types/api'
import i18n from '@/i18n'
import { normalizeCloudBackendUrl } from '@/features/cloud-connection/cloudConnectionStorage'
import type { PluginRuntimeProfile } from './pluginDeviceApi'

type PluginApi = ReturnType<typeof createPluginApi>
interface LocalSyncResult {
  enabled: boolean
  protocolVersion: number
  localCompleted?: boolean
  receiptPending?: boolean
  recoveryPending?: boolean
  unchanged?: boolean
  sourceDeviceId?: string
  operation?: { plugin?: InstalledPlugin | null }
  result?: {
    scope?: string
    plugins?: Array<{ id: string | number; status: string; version?: string; checksum?: string }>
  }
}

export function createLocalFirstPluginApi(
  api: PluginApi,
  legacy: PluginApi,
  profile: PluginRuntimeProfile
) {
  const completed = new Map<string, { version?: string; checksum?: string }>()
  let active = false
  let backendEnabled = false
  let sourceDeviceId: string | undefined
  const invoke = (params: Record<string, unknown>) => {
    const { backendUrl } = normalizeCloudBackendUrl(
      new URL(profile.apiBaseUrl, window.location.origin).toString()
    )
    return requestLocalExecutor<LocalSyncResult>('executor.plugins.local_sync', {
      backend_url: backendUrl,
      auth_token: profile.token,
      ...params,
    }).catch((cause: unknown) => {
      const code = cause && typeof cause === 'object' && 'code' in cause ? String(cause.code) : ''
      const keys: Record<string, string> = {
        plugin_local_http_unavailable: 'plugins_local_sync_network_error',
        plugin_local_apply_failed: 'plugins_local_sync_apply_error',
        plugin_local_acceptance_unconfirmed: 'plugins_local_sync_unconfirmed',
        plugin_local_journal_unavailable: 'plugins_local_sync_journal_error',
        plugin_local_journal_invalid: 'plugins_local_sync_journal_error',
        INTENT_SUPERSEDED: 'plugins_local_sync_superseded',
        LOCAL_SYNC_DISABLED: 'plugins_local_sync_disabled',
        plugin_route_profile_mismatch: 'plugins_runtime_changed',
      }
      if (!keys[code]) throw cause
      throw Object.assign(new Error(i18n.t(`workbench.${keys[code]}`), { cause }), { code })
    })
  }
  const supportsLocalSync = async () => {
    if (!profile.token) return false
    try {
      const response = await invoke({ probeOnly: true })
      backendEnabled = response.enabled === true
      sourceDeviceId = response.sourceDeviceId?.trim() || undefined
      active =
        (backendEnabled || response.recoveryPending === true) && response.protocolVersion === 1
      return active
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : ''
      if (
        [
          'plugin_local_sync_unsupported',
          'method_not_found',
          'unsupported_method',
          'method_not_allowed',
          'local_executor_unavailable',
          'backend_connection_unavailable',
          'plugin_local_profile_unavailable',
        ].includes(String(code))
      ) {
        active = false
        return false
      }
      throw error
    }
  }
  const hasCurrentProof = (plugin: InstalledPlugin): boolean => {
    const id = String((plugin.metadata.labels as Record<string, unknown> | undefined)?.id ?? '')
    const proof = completed.get(id)
    if (
      !proof ||
      proof.version !== (plugin.spec.version || 'latest') ||
      (plugin.spec.packageRef?.checksum && proof.checksum !== plugin.spec.packageRef.checksum)
    ) {
      return false
    }
    return true
  }
  const project = (plugin: InstalledPlugin): InstalledPlugin => {
    if (!hasCurrentProof(plugin)) return plugin
    return {
      ...plugin,
      status: {
        ...plugin.status,
        localExecution: {
          state: 'installed',
          releaseId: plugin.spec.releaseId ?? null,
        },
      },
    }
  }
  const apply = async (params: Record<string, unknown> = {}) => {
    const response = await invoke(params)
    if (!response.localCompleted) throw new Error('PLUGIN_LOCAL_EXECUTION_UNCONFIRMED')
    if (response.result?.scope !== 'plugin_delta') completed.clear()
    for (const item of response.result?.plugins ?? []) {
      if (item.status === 'synced') completed.set(String(item.id), item)
      else if (item.status === 'removed') completed.delete(String(item.id))
    }
    return response
  }
  const sync = async (
    deviceId: string,
    installedPluginId?: string | number
  ): Promise<PluginDeviceSyncResponse> => {
    const response = await apply(
      installedPluginId === undefined
        ? { full: true }
        : { installedPluginId: Number(installedPluginId) }
    )
    const localChanged = response.unchanged !== true
    const result: DeviceCapabilitySyncResponse = {
      success: true,
      device_id: deviceId,
      mode: 'merge',
      skills: [],
      plugins: response.result?.plugins ?? [],
      mcps: [],
      errors: [],
      synced: response.result?.plugins?.length ?? 0,
      failed: 0,
      skipped: 0,
      results: [],
    }
    // UI synchronization result only: this never writes a cloud Device receipt.
    return { deviceId, pendingCount: 0, reconciled: true, localChanged, sync: result }
  }
  const updateInstalledPlugin = async (
    id: string | number,
    payload: Parameters<PluginApi['updateInstalledPlugin']>[1],
    deviceId?: string
  ) => {
    if (!(await supportsLocalSync())) return legacy.updateInstalledPlugin(id, payload, deviceId)
    const response = await apply({ action: 'update', targetId: Number(id), payload })
    const plugin = response.operation?.plugin
    if (!plugin) throw new Error('PLUGIN_LOCAL_OPERATION_UNCONFIRMED')
    return project(plugin)
  }

  return {
    ...legacy,
    supportsLocalSync,
    async autoUpdateInstalledPlugins() {
      const local = await supportsLocalSync()
      if (local && !backendEnabled) return { updated: [], updatedCount: 0, remainingCount: 0 }
      const candidate = local ? sourceDeviceId || getKnownLocalExecutorDeviceId() : null
      const origin =
        candidate && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/.test(candidate) ? candidate : undefined
      return api.autoUpdateInstalledPlugins(origin, local ? 'local_pull_v1' : undefined)
    },
    async listInstalledPlugins(deviceId?: string) {
      const response = active
        ? await api.listInstalledPlugins()
        : await legacy.listInstalledPlugins(deviceId)
      return { ...response, items: response.items.map(project) }
    },
    async listMarketplacePlugins(params: Parameters<PluginApi['listMarketplacePlugins']>[0] = {}) {
      const response = active
        ? await api.listMarketplacePlugins({ ...params, deviceId: undefined })
        : await legacy.listMarketplacePlugins(params)
      if (!completed.size) return response
      // Catalog membership is account intent. Validate cached materialization
      // against the current owned installation before projecting local presence.
      const inventory = await api.listInstalledPlugins().catch(() => null)
      const confirmed = new Set(
        inventory?.items
          .filter(hasCurrentProof)
          .map(plugin =>
            String((plugin.metadata.labels as Record<string, unknown> | undefined)?.id ?? '')
          )
      )
      return {
        ...response,
        items: response.items.map(item => {
          if (!item.installedPluginId || !completed.has(String(item.installedPluginId))) return item
          return {
            ...item,
            installedLocally: confirmed.has(String(item.installedPluginId)),
            installedVersion: completed.get(String(item.installedPluginId))?.version,
          }
        }),
      }
    },
    async installMarketplacePlugin(id: string | number, deviceId?: string) {
      if (!(await supportsLocalSync())) return legacy.installMarketplacePlugin(id, deviceId)
      const response = await apply({ action: 'install', targetId: Number(id) })
      const plugin = response.operation?.plugin
      if (!plugin) throw new Error('PLUGIN_LOCAL_OPERATION_UNCONFIRMED')
      return { plugin: project(plugin), sync: null }
    },
    async ensureBuiltinPluginInstalled(pluginKey: string, options: { deviceId?: string } = {}) {
      if (!(await supportsLocalSync()))
        return legacy.ensureBuiltinPluginInstalled(pluginKey, options)
      const response = await apply({ action: 'ensure_builtin', targetId: pluginKey })
      const plugin = response.operation?.plugin
      if (!plugin) throw new Error('PLUGIN_LOCAL_OPERATION_UNCONFIRMED')
      return { plugin: project(plugin), sync: null }
    },
    updateInstalledPlugin,
    async updateMarketplacePlugin(id: string | number, releaseId: number, deviceId?: string) {
      return updateInstalledPlugin(id, { releaseId }, deviceId)
    },
    async uninstallInstalledPlugin(id: string | number) {
      if (!(await supportsLocalSync())) return legacy.uninstallInstalledPlugin(id)
      await apply({ action: 'uninstall', targetId: Number(id) })
    },
    async syncInstalledPluginsToDevice(deviceId: string, reconcile = false) {
      return (await supportsLocalSync())
        ? sync(deviceId)
        : legacy.syncInstalledPluginsToDevice(deviceId, reconcile)
    },
    async syncInstalledPluginToDevice(id: string | number, deviceId: string) {
      return (await supportsLocalSync())
        ? sync(deviceId, id)
        : legacy.syncInstalledPluginToDevice(id, deviceId)
    },
    async reportInstalledPluginsOnDevice(
      deviceId: string,
      reports: Parameters<PluginApi['reportInstalledPluginsOnDevice']>[1]
    ) {
      if (!(await supportsLocalSync()))
        return legacy.reportInstalledPluginsOnDevice(deviceId, reports)
      await apply({ full: true })
      return {
        deviceId,
        acknowledgedCount: reports.length,
        acknowledgedInstalledPluginIds: reports.map(report => report.installedPluginId),
      }
    },
  }
}
