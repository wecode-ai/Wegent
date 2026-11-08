import type {
  DeviceInfo,
  ProjectWithTasks,
  RuntimeTaskAddress,
  RuntimeWorkListResponse,
} from '@/types/api'
import { runtimeProjectToProject } from '@/lib/runtime-project'
import { findRuntimeTaskProjectWork } from '@/features/workbench/workbenchRuntimeHelpers'
import { getLocalRuntimeSourceIdentity } from '@/lib/local-runtime-sidebar-identity'

export interface WorkbenchPaneIdentity {
  currentRuntimeTask: RuntimeTaskAddress | null
  currentProject: ProjectWithTasks | null
  standaloneChatKey?: number
}

export function getWorkbenchPaneKey({
  currentRuntimeTask,
  standaloneChatKey,
}: WorkbenchPaneIdentity): string {
  if (currentRuntimeTask) {
    return ['runtime', currentRuntimeTask.deviceId, currentRuntimeTask.taskId].join(':')
  }
  return `blank:${standaloneChatKey ?? 0}`
}

export function getRuntimeWorkbenchPaneKeys(runtimeWork: RuntimeWorkListResponse | null): string[] {
  if (!runtimeWork) return []
  const workspaces = [
    ...runtimeWork.chats,
    ...runtimeWork.projects.flatMap(project => project.deviceWorkspaces),
  ]
  return workspaces.flatMap(workspace =>
    workspace.tasks.map(task =>
      getWorkbenchPaneKey({
        currentRuntimeTask: { deviceId: workspace.deviceId, taskId: task.taskId },
        currentProject: null,
      })
    )
  )
}

export function resolveRuntimeWorkbenchPane(
  runtimeWork: RuntimeWorkListResponse | null,
  paneKey: string,
  devices: readonly Pick<DeviceInfo, 'device_id'>[] = []
): WorkbenchPaneIdentity | null {
  if (!runtimeWork || !paneKey.startsWith('runtime:')) return null
  const separator = paneKey.indexOf(':', 'runtime:'.length)
  if (separator < 0) return null
  const deviceId = paneKey.slice('runtime:'.length, separator)
  const taskId = paneKey.slice(separator + 1)
  if (!deviceId || !taskId) return null
  const workspaces = [
    ...runtimeWork.chats,
    ...runtimeWork.projects.flatMap(project => project.deviceWorkspaces),
  ]
  const ownsSavedAddress = (workspace: (typeof workspaces)[number]) =>
    workspace.deviceId === deviceId || workspace.remoteHostId === deviceId
  const ownerKnown =
    devices.some(device => device.device_id === deviceId) || workspaces.some(ownsSavedAddress)
  // The live local IPC catalog owns local data, not the device ID saved in a view.
  // Remote addresses stay owner-qualified; JSON cannot manufacture IPC provenance.
  const matches = workspaces.flatMap(workspace => {
    const eligible = ownerKnown
      ? ownsSavedAddress(workspace)
      : getLocalRuntimeSourceIdentity(workspace)?.deviceId === workspace.deviceId &&
        !workspace.remoteHostId &&
        workspace.workspaceSource !== 'remote'
    const task = eligible && workspace.tasks.find(candidate => candidate.taskId === taskId)
    return task ? [{ workspace, task }] : []
  })
  if (matches.length === 1) {
    const { workspace, task } = matches[0]
    const currentRuntimeTask = {
      deviceId: workspace.deviceId,
      taskId: task.taskId,
      threadId: task.threadId,
      workspacePath: task.workspacePath || workspace.workspacePath,
      runtimeHandle: task.runtimeHandle,
    }
    const projectWork = findRuntimeTaskProjectWork(runtimeWork, currentRuntimeTask)
    return {
      currentRuntimeTask,
      currentProject: projectWork ? runtimeProjectToProject(projectWork) : null,
    }
  }
  return null
}
