import type {
  RuntimeWorkListResponse,
  RuntimeTaskSummary,
  RuntimeDeviceWorkspace,
} from './runtime-task-api-types'
import type { RuntimeTaskAddress } from './runtime'

export function findRuntimeTask(
  runtimeWork: RuntimeWorkListResponse | null | undefined,
  address: RuntimeTaskAddress | null | undefined
): RuntimeTaskSummary | null {
  const workspace = findRuntimeTaskWorkspace(runtimeWork, address)
  return workspace?.tasks.find(item => item.taskId === address?.taskId) ?? null
}

export function findRuntimeTaskWorkspace(
  runtimeWork: RuntimeWorkListResponse | null | undefined,
  address: RuntimeTaskAddress | null | undefined
): RuntimeDeviceWorkspace | null {
  if (!runtimeWork || !address) return null
  const workspaces = [
    ...runtimeWork.chats,
    ...runtimeWork.projects.flatMap(project => project.deviceWorkspaces),
  ]
  return (
    workspaces.find(
      workspace =>
        (workspace.deviceId === address.deviceId || workspace.remoteHostId === address.deviceId) &&
        workspace.tasks.some(task => task.taskId === address.taskId)
    ) ?? null
  )
}
