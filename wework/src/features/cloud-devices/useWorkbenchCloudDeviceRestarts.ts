import { createContext, useContext } from 'react'
import type { DeviceInfo } from '@/types/api'
import type { DeviceLifecyclePhase } from './useDeviceOfflineLifecycleAction'

export interface DeviceRestartProgress {
  device: DeviceInfo
  upgrade: boolean
  phase: DeviceLifecyclePhase
  error: string | null
  onRefresh: () => void
}

interface RestartActions {
  requestRestart: (devices: DeviceInfo[], upgrade?: boolean) => void
  remindOnUse: (deviceId: string | null | undefined) => void
  progress: Record<string, DeviceRestartProgress>
  isConfirming: boolean
  isRestarting: (device: DeviceInfo) => boolean
}

export function cloudDeviceRestartKey(device: DeviceInfo) {
  return device.cloud_config?.sandboxId || device.device_id
}

export const CloudDeviceRestartContext = createContext<RestartActions | null>(null)

export function useWorkbenchCloudDeviceRestarts() {
  return useContext(CloudDeviceRestartContext)
}
