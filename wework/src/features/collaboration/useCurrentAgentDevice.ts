import { useMemo, useSyncExternalStore } from 'react'
import {
  createAsyncResource,
  getIdleResourceSnapshot,
  subscribeIdleResource,
} from '@wegent/chat-core/async-resource'

import type {
  ProjectPluginCatalogApi,
  WorkbenchServices,
} from '@/features/workbench/workbenchServices'
import { useTranslation } from '@/hooks/useTranslation'
import type { DeviceInfo } from '@/types/devices'

const EMPTY_PLUGIN_NAMES: string[] = []

type DeviceApi = Pick<WorkbenchServices['deviceApi'], 'listDevices' | 'listSkills'>

function selectCurrentDevice(devices: DeviceInfo[]): DeviceInfo | null {
  const localDevices = devices.filter(
    device => device.device_type === 'local' || device.device_type === 'app'
  )
  return (
    localDevices.find(device => device.is_default && device.status !== 'offline') ??
    localDevices.find(device => device.status !== 'offline') ??
    localDevices.find(device => device.is_default) ??
    localDevices[0] ??
    null
  )
}

export function useCurrentAgentDevice(
  deviceApi?: DeviceApi,
  pluginApi?: ProjectPluginCatalogApi,
  enabled = true
) {
  const { t } = useTranslation()
  const deviceResource = useMemo(
    () =>
      createAsyncResource(
        'current-device',
        async () => selectCurrentDevice(await deviceApi!.listDevices()),
        { refreshOnSubscribe: true }
      ),
    [deviceApi]
  )
  const deviceQuery = useSyncExternalStore(
    enabled && deviceApi ? deviceResource.subscribe : subscribeIdleResource,
    deviceResource.getSnapshot,
    getIdleResourceSnapshot
  )
  const device = deviceQuery.status === 'error' ? null : (deviceQuery.data ?? null)
  const deviceId = device?.device_id
  const capabilities = useMemo(
    () =>
      createAsyncResource(
        deviceId ?? '',
        async () => {
          const [skills, plugins] = await Promise.all([
            deviceApi!.listSkills(deviceId!).catch(() => []),
            pluginApi?.listPlugins(deviceId!).catch(() => []) ?? Promise.resolve([]),
          ])
          return {
            skillCount: skills.length,
            pluginNames: plugins.map(plugin => plugin.displayName || plugin.pluginName).slice(0, 3),
          }
        },
        { refreshOnSubscribe: true }
      ),
    [deviceApi, pluginApi, deviceId]
  )
  const capabilityQuery = useSyncExternalStore(
    enabled && deviceId && deviceQuery.status === 'ready'
      ? capabilities.subscribe
      : subscribeIdleResource,
    capabilities.getSnapshot,
    getIdleResourceSnapshot
  )
  const pluginNames = capabilityQuery.data?.pluginNames ?? EMPTY_PLUGIN_NAMES
  const skillCount = capabilityQuery.data?.skillCount ?? 0
  const loading = Boolean(
    deviceApi &&
    (deviceQuery.status === 'idle' ||
      deviceQuery.status === 'loading' ||
      (device && (capabilityQuery.status === 'idle' || capabilityQuery.status === 'loading')))
  )

  return useMemo(
    () => ({
      capabilityItems: device
        ? [
            ...pluginNames,
            ...(skillCount
              ? [
                  t('workbench.agent_creator_device_skill_count', '{{count}} Skills', {
                    count: skillCount,
                  }),
                ]
              : []),
            t(
              'workbench.agent_creator_device_local_capabilities',
              'Local files and desktop control'
            ),
          ]
        : [],
      capabilitySummary: device
        ? t(
            'workbench.agent_creator_device_capability_summary',
            '{{plugins}} plugins · {{skills}} Skills · Local files and desktop control',
            { plugins: pluginNames.length, skills: skillCount }
          )
        : '',
      currentDevice: device ? { id: device.device_id, name: device.name } : null,
      loading,
    }),
    [device, loading, pluginNames, skillCount, t]
  )
}
