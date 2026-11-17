import { useCallback } from 'react'
import type { LocalRuntime } from '@/services/localRuntime'
import type { RuntimeApi } from '@/services/runtimeApi'
import type { RuntimePermissionMode } from '@/services/runtimePermissionPreference'
import type {
  DeviceInfo,
  RuntimeTaskAddress,
  RuntimeTaskSummary,
  UnifiedModel,
} from '@/types/runtime'
import { useDeviceModels } from './useDeviceModels'

interface MobileModelsOptions {
  api: RuntimeApi
  devices: DeviceInfo[]
  address: RuntimeTaskAddress | null
  task?: RuntimeTaskSummary | null
  selectedDeviceId: string | null
  cloudModels: UnifiedModel[]
  backendIdentity: string | null
  local?: LocalRuntime
  permissionMode: RuntimePermissionMode
}

export function useMobileModels({
  api,
  devices,
  address,
  task,
  selectedDeviceId,
  cloudModels,
  backendIdentity,
  local,
  permissionMode,
}: MobileModelsOptions) {
  const deviceId = address?.deviceId ?? selectedDeviceId
  const device = devices.find(device => device.device_id === deviceId)
  const models = useDeviceModels(
    api,
    device,
    cloudModels,
    backendIdentity,
    local?.status.generation,
    {
      address,
      task,
      autoLoad:
        Boolean(device && device.status !== 'offline') &&
        (!local?.ownsDevice(deviceId ?? undefined) || local?.status.state === 'running'),
    }
  )
  const loadLocalModels = useCallback(
    () => models.loadDeviceModels(local?.device(), true),
    [models.loadDeviceModels, local]
  )
  const modelSelection = models.modelSelection
    ? { ...models.modelSelection, options: { ...models.modelSelection.options, permissionMode } }
    : null
  return { ...models, loadLocalModels, modelSelection }
}
