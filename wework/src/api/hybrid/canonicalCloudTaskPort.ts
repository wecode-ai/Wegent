import type { WeworkWorkspaceRuntimePort, WorkspaceRuntimeTaskAddress } from '@wegent/collaboration'
import type { DeviceInfo } from '@/types/api'

export function registeredCloudDeviceIdentity(
  deviceId: string,
  device: Pick<DeviceInfo, 'device_id' | 'device_type'> | null
): { deviceId: string; backendDeviceId: string } | null {
  return device?.device_id === deviceId &&
    (device.device_type === 'cloud' || device.device_type === 'remote')
    ? { deviceId, backendDeviceId: deviceId }
    : null
}

export async function registeredCloudDeviceId(
  deviceId: string,
  identity: (deviceId: string) => Promise<{ backendDeviceId: string }>
): Promise<string> {
  const { backendDeviceId } = await identity(deviceId)
  if (!backendDeviceId?.trim()) throw new Error('Runtime has no registered cloud device identity')
  return backendDeviceId
}

/** Persist the Runtime's registered identity instead of a reusable desktop alias. */
export function canonicalCloudTaskPort(
  port: WeworkWorkspaceRuntimePort,
  identity: (deviceId: string) => Promise<{ backendDeviceId: string }>,
  resolveDevice: (deviceId: string) => Promise<Pick<DeviceInfo, 'device_id' | 'device_type'> | null>
): WeworkWorkspaceRuntimePort {
  const address = async (task: WorkspaceRuntimeTaskAddress) => {
    if (registeredCloudDeviceIdentity(task.deviceId, await resolveDevice(task.deviceId)))
      return task
    return { ...task, deviceId: await registeredCloudDeviceId(task.deviceId, identity) }
  }
  // Existing backend record routes identify persisted metadata even while offline.
  // Aliases still require attestation; authorization remains owned by the backend.
  const existingAddress = async (task: WorkspaceRuntimeTaskAddress) =>
    /^app-record-0*[1-9][0-9]*$/.test(task.deviceId) ? task : address(task)
  return {
    ...port,
    async findIssueForTask(task) {
      return port.findIssueForTask(await existingAddress(task))
    },
    async findCloudContextForTask(task) {
      return port.findCloudContextForTask(await existingAddress(task))
    },
    async bindTask(issueId, task, title, dispatch) {
      return port.bindTask(issueId, await address(task), title, dispatch)
    },
    async unbindTask(issueId, task) {
      return port.unbindTask(issueId, await existingAddress(task))
    },
    async unbindCloudContext(task) {
      return port.unbindCloudContext(await existingAddress(task))
    },
    async trackProjectTask(projectId, task, title, description) {
      return port.trackProjectTask(projectId, await address(task), title, description)
    },
  }
}
