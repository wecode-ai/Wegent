import type { ProjectWithTasks, RuntimeTaskAddress } from '@/types/api'

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
