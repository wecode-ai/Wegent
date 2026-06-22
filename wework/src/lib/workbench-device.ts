import type { DeviceInfo, ProjectWithTasks } from '@/types/api'

export function getProjectDeviceId(project: ProjectWithTasks | null | undefined) {
  return project?.config?.execution?.deviceId ?? project?.config?.device_id
}

export function getActiveWorkbenchDeviceId({
  currentProject,
  standaloneDeviceId,
}: {
  currentProject: ProjectWithTasks | null
  standaloneDeviceId?: string | null
}) {
  const projectDeviceId = getProjectDeviceId(currentProject)
  return projectDeviceId ?? (!currentProject ? standaloneDeviceId ?? undefined : undefined)
}

export function findWorkbenchDevice(
  devices: DeviceInfo[],
  deviceId: string | null | undefined,
) {
  if (!deviceId) return null
  return devices.find(device => device.device_id === deviceId) ?? null
}

export function isWorkbenchDeviceOnline(device: DeviceInfo | null) {
  return Boolean(device && device.status === 'online')
}

export function getWorkbenchDeviceDisplayName(
  device: DeviceInfo | null,
  deviceId: string | null | undefined,
) {
  return device?.name || deviceId || ''
}
