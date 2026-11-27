import { useCallback, useState, useSyncExternalStore } from 'react'
import {
  createWorkbenchDeviceUpgradeSource,
  type WorkbenchDeviceUpgradeInput,
} from './workbenchDeviceUpgradeSource'

export function useWorkbenchDeviceUpgrades({
  state: { devices },
  dispatch,
  executorClient,
  services,
  refreshDevices,
}: WorkbenchDeviceUpgradeInput) {
  const [source] = useState(createWorkbenchDeviceUpgradeSource)
  const subscribe = useCallback(
    (listener: () => void) =>
      source.subscribe(listener, {
        state: { devices },
        dispatch,
        executorClient,
        services,
        refreshDevices,
      }),
    [source, devices, dispatch, executorClient, services, refreshDevices]
  )
  const upgradingDevices = useSyncExternalStore(subscribe, source.getSnapshot)
  return { upgradingDevices, upgradeDevice: source.upgradeDevice }
}
