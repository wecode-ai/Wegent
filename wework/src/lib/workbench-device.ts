import type { DeviceInfo, ProjectWithTasks, Task } from '@/types/api'

export function getProjectDeviceId(project: ProjectWithTasks | null | undefined) {
  return project?.config?.execution?.deviceId ?? project?.config?.device_id
}

export function getActiveWorkbenchDeviceId({
  currentTask,
  currentProject,
  standaloneDeviceId,
}: {
  currentTask: Task | null
  currentProject: ProjectWithTasks | null
  standaloneDeviceId?: string | null
}) {
  return (
    currentTask?.device_id ??
    getProjectDeviceId(currentProject) ??
    (!currentProject ? standaloneDeviceId ?? undefined : undefined)
  )
}

export function findWorkbenchDevice(
  devices: DeviceInfo[],
  deviceId: string | null | undefined,
) {
  if (!deviceId) return null
  return devices.find(device => device.device_id === deviceId) ?? null
}

export function isWorkbenchDeviceOnline(device: DeviceInfo | null) {
  return !device || device.status === 'online'
}

export function getWorkbenchDeviceDisplayName(
  device: DeviceInfo | null,
  deviceId: string | null | undefined,
) {
  return device?.name || deviceId || ''
}
