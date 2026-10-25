import type { createPluginApi } from '@/api/plugins'
import { ensureLocalExecutorAvailable } from '@/desktop/localExecutor'
import i18n from '@/i18n'
import type {
  DeviceCapabilitySyncResponse,
  InstalledPlugin,
  PluginMarketplaceInstallResponse,
} from '@/types/api'

type PluginApi = ReturnType<typeof createPluginApi>
interface DeviceScope {
  deviceId: string
  requestId: string
}

/** Resolve one fresh registration without changing the stable inventory identity. */
export async function resolveLocalPluginDeviceRouteId(deviceId: string): Promise<string> {
  const executor = await ensureLocalExecutorAvailable({ refresh: true })
  if (executor.deviceId?.trim() !== deviceId.trim()) {
    throw new Error(i18n.t('workbench.plugins_runtime_changed'))
  }
  const routeId = executor.deviceRouteId?.trim()
  if (!routeId) throw new Error(i18n.t('workbench.plugins_runtime_not_registered'))
  return routeId
}

function localDeviceId(deviceId: string, scope: DeviceScope): string {
  return deviceId === scope.requestId ? scope.deviceId : deviceId
}

function localInstallation<T extends { deviceId: string } | null | undefined>(
  installation: T,
  scope: DeviceScope
): T {
  return installation && installation.deviceId === scope.requestId
    ? { ...installation, deviceId: scope.deviceId }
    : installation
}

function localPlugin(plugin: InstalledPlugin, scope: DeviceScope): InstalledPlugin {
  if (!scope.deviceId || scope.deviceId === scope.requestId) return plugin
  return {
    ...plugin,
    status: {
      ...plugin.status,
      devices: plugin.status.devices?.map(device => localInstallation(device, scope)),
    },
  }
}

function localSync(sync: DeviceCapabilitySyncResponse, scope: DeviceScope) {
  return {
    ...sync,
    device_id: localDeviceId(sync.device_id, scope),
    results: sync.results.map(result => ({
      ...result,
      device_id: localDeviceId(result.device_id, scope),
    })),
  }
}

function localInstallResponse(response: PluginMarketplaceInstallResponse, scope: DeviceScope) {
  return {
    ...response,
    plugin: localPlugin(response.plugin, scope),
    sync: response.sync ? localSync(response.sync, scope) : response.sync,
  }
}

/** Address the Runtime record on the wire; retain stable identity in plugin state. */
export function createLocalDevicePluginApi(
  api: PluginApi,
  resolveDeviceRouteId: (deviceId: string) => Promise<string>
): PluginApi {
  const deviceScope = async (
    deviceId = '',
    context: 'required' | 'optional' = 'required'
  ): Promise<DeviceScope> => {
    const stableDeviceId = deviceId.trim()
    if (!stableDeviceId) {
      if (context === 'required')
        throw new Error(i18n.t('workbench.plugins_device_identity_required'))
      return { deviceId: '', requestId: '' }
    }
    try {
      const requestId = (await resolveDeviceRouteId(stableDeviceId)).trim()
      if (!requestId) throw new Error(i18n.t('workbench.plugins_runtime_not_registered'))
      return { deviceId: stableDeviceId, requestId }
    } catch (error) {
      // Account reads and preferences remain available without a local Runtime.
      // Omit unavailable targeting context; never reuse a stale record route.
      if (context === 'required') throw error
      return { deviceId: stableDeviceId, requestId: '' }
    }
  }
  return {
    ...api,
    async listInstalledPlugins(deviceId) {
      const scope = await deviceScope(deviceId, 'optional')
      const response = await api.listInstalledPlugins(scope.requestId)
      return { ...response, items: response.items.map(plugin => localPlugin(plugin, scope)) }
    },
    async listMarketplacePlugins(params = {}) {
      const scope = await deviceScope(params.deviceId, 'optional')
      const response = await api.listMarketplacePlugins({ ...params, deviceId: scope.requestId })
      return {
        ...response,
        items: response.items.map(item => ({
          ...item,
          currentDeviceInstallation: localInstallation(item.currentDeviceInstallation, scope),
        })),
      }
    },
    async installMarketplacePlugin(id, deviceId) {
      const scope = await deviceScope(deviceId)
      const response = await api.installMarketplacePlugin(id, scope.requestId)
      return localInstallResponse(response, scope)
    },
    async ensureBuiltinPluginInstalled(pluginKey, options = {}) {
      const scope = await deviceScope(options.deviceId)
      const response = await api.ensureBuiltinPluginInstalled(pluginKey, {
        ...options,
        deviceId: scope.requestId,
      })
      return localInstallResponse(response, scope)
    },
    async updateMarketplacePlugin(id, releaseId, deviceId) {
      const scope = await deviceScope(deviceId)
      return localPlugin(await api.updateMarketplacePlugin(id, releaseId, scope.requestId), scope)
    },
    async updateInstalledPlugin(id, request, deviceId) {
      const scope = await deviceScope(
        deviceId,
        request.releaseId === undefined ? 'optional' : 'required'
      )
      return localPlugin(await api.updateInstalledPlugin(id, request, scope.requestId), scope)
    },
    uninstallInstalledPlugin(id) {
      return api.uninstallInstalledPlugin(id)
    },
    async syncInstalledPluginToDevice(id, deviceId) {
      const scope = await deviceScope(deviceId)
      const response = await api.syncInstalledPluginToDevice(id, scope.requestId)
      return {
        ...response,
        deviceId: localDeviceId(response.deviceId, scope),
        sync: localSync(response.sync, scope),
      }
    },
    async syncInstalledPluginsToDevice(deviceId, reconcile = false) {
      const scope = await deviceScope(deviceId)
      const response = await api.syncInstalledPluginsToDevice(scope.requestId, reconcile)
      return {
        ...response,
        deviceId: localDeviceId(response.deviceId, scope),
        sync: localSync(response.sync, scope),
      }
    },
    async reportInstalledPluginsOnDevice(deviceId, reports) {
      const scope = await deviceScope(deviceId)
      const response = await api.reportInstalledPluginsOnDevice(scope.requestId, reports)
      return { ...response, deviceId: localDeviceId(response.deviceId, scope) }
    },
  }
}
