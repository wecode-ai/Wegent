import type { ProjectWithTasks, RuntimeTaskAddress, RuntimeWorkListResponse } from '@/types/api'

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
  paneKey: string
): WorkbenchPaneIdentity | null {
  if (!runtimeWork || !paneKey.startsWith('runtime:')) return null
  const workspaces = [
    ...runtimeWork.chats,
    ...runtimeWork.projects.flatMap(project => project.deviceWorkspaces),
  ]
  for (const workspace of workspaces) {
    const task = workspace.tasks.find(candidate => {
      const key = getWorkbenchPaneKey({
        currentRuntimeTask: {
          deviceId: workspace.deviceId,
          taskId: candidate.taskId,
        },
        currentProject: null,
      })
      return key === paneKey
    })
    if (!task) continue
    return {
      currentRuntimeTask: {
        deviceId: workspace.deviceId,
        taskId: task.taskId,
        threadId: task.threadId,
        workspacePath: task.workspacePath || workspace.workspacePath,
        runtimeHandle: task.runtimeHandle,
      },
      currentProject: null,
    }
  }
  return null
}
