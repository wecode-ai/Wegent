import type { DeviceInfo, ProjectWithTasks, Task } from '@/types/api'

export function getProjectDeviceId(project: ProjectWithTasks | null | undefined) {
  return project?.config?.execution?.deviceId ?? project?.config?.device_id
}

export function findProjectForTask(
  projects: ProjectWithTasks[],
  task: Task | null | undefined,
) {
  if (!task) return null
  if (task.project_id && task.project_id > 0) {
    return projects.find(project => project.id === task.project_id) ?? null
  }

  return (
    projects.find(project =>
      project.tasks?.some(projectTask =>
        projectTask.task_id === task.id || projectTask.id === task.id,
      ),
    ) ?? null
  )
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
  const projectDeviceId = getProjectDeviceId(currentProject)
  return (
    projectDeviceId ??
    currentTask?.device_id ??
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
  return Boolean(device && device.status === 'online')
}

export function getWorkbenchDeviceDisplayName(
  device: DeviceInfo | null,
  deviceId: string | null | undefined,
) {
  return device?.name || deviceId || ''
}
