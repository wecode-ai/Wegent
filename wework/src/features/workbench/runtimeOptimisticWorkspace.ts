import type { DeviceInfo, RuntimeDeviceWorkspace } from '@/types/api'
import { findNativeLocalWorkbenchDevice, findWorkbenchDevice } from '@/lib/workbench-device'
import {
  getLocalRuntimeSourceIdentity,
  qualifyLocalRuntimeWorkspace,
} from '@/lib/local-runtime-sidebar-identity'
import { logRuntimeTaskCreateStage } from '@/lib/runtime-create-diagnostics'

export function buildOptimisticRuntimeWorkspace({
  baseWorkspace,
  devices,
  deviceId,
  workspacePath,
  projectId,
  workspaceKind,
}: {
  baseWorkspace?: RuntimeDeviceWorkspace | null
  devices: DeviceInfo[]
  deviceId: string
  workspacePath: string
  projectId: number | null
  workspaceKind?: RuntimeDeviceWorkspace['workspaceKind']
}): RuntimeDeviceWorkspace {
  const device = findWorkbenchDevice(devices, deviceId)
  const workspace: RuntimeDeviceWorkspace = {
    ...baseWorkspace,
    projectId: projectId ?? baseWorkspace?.projectId,
    deviceId,
    deviceName: device?.name ?? baseWorkspace?.deviceName ?? null,
    deviceStatus: device?.status ?? baseWorkspace?.deviceStatus ?? null,
    workspacePath,
    workspaceKind:
      workspaceKind ?? baseWorkspace?.workspaceKind ?? (projectId ? 'workspace' : 'chat'),
    mapped: baseWorkspace?.mapped ?? Boolean(projectId),
    available: baseWorkspace?.available ?? (device ? device.status !== 'offline' : true),
    tasks: [],
  }
  const nativeDevice = findNativeLocalWorkbenchDevice(devices, deviceId)
  const identity = nativeDevice ? getLocalRuntimeSourceIdentity(nativeDevice) : undefined
  const qualified = identity ? qualifyLocalRuntimeWorkspace(workspace, identity) : workspace
  logRuntimeTaskCreateStage('optimistic-workspace-prepared', {
    deviceId,
    nativeIdentityAvailable: Boolean(identity),
    nativeRuntimeInstanceId: identity?.runtimeInstanceId ?? null,
    qualifiedLocalSource: Boolean(getLocalRuntimeSourceIdentity(qualified)),
  })
  return qualified
}
