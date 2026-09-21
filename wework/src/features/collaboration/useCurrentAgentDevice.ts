import { useEffect, useMemo, useState } from 'react'

import type {
  ProjectPluginCatalogApi,
  WorkbenchServices,
} from '@/features/workbench/workbenchServices'
import { useTranslation } from '@/hooks/useTranslation'
import type { DeviceInfo } from '@/types/devices'

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

export function useCurrentAgentDevice(deviceApi?: DeviceApi, pluginApi?: ProjectPluginCatalogApi) {
  const { t } = useTranslation()
  const [device, setDevice] = useState<DeviceInfo | null>(null)
  const [pluginNames, setPluginNames] = useState<string[]>([])
  const [skillCount, setSkillCount] = useState(0)
  const [loading, setLoading] = useState(Boolean(deviceApi))

  useEffect(() => {
    if (!deviceApi) return

    let active = true
    void deviceApi
      .listDevices()
      .then(async devices => {
        const currentDevice = selectCurrentDevice(devices)
        if (!active) return
        setDevice(currentDevice)
        if (!currentDevice) return

        const [skills, plugins] = await Promise.all([
          deviceApi.listSkills(currentDevice.device_id).catch(() => []),
          pluginApi?.listPlugins(currentDevice.device_id).catch(() => []) ?? Promise.resolve([]),
        ])
        if (!active) return
        setSkillCount(skills.length)
        setPluginNames(plugins.map(plugin => plugin.displayName || plugin.pluginName).slice(0, 3))
      })
      .catch(() => {
        if (active) setDevice(null)
      })
      .finally(() => {
        if (active) setLoading(false)
      })

    return () => {
      active = false
    }
  }, [deviceApi, pluginApi])

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
