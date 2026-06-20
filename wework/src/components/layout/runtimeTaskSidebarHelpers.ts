import type { LocalTaskSummary, RuntimeDeviceWorkspace, RuntimeTaskAddress } from '@/types/api'

export function getRuntimeTaskTime(task: LocalTaskSummary) {
  return task.updatedAt || task.createdAt || undefined
}

export function sortRuntimeTasks(tasks: LocalTaskSummary[] = []) {
  return [...tasks].sort((left, right) => {
    const leftTime = new Date(getRuntimeTaskTime(left) || 0).getTime()
    const rightTime = new Date(getRuntimeTaskTime(right) || 0).getTime()
    return rightTime - leftTime
  })
}

export function getRuntimeTaskRuntimeLabel(runtime: string) {
  if (runtime === 'claude_code') return 'Claude Code'
  if (runtime === 'codex') return 'Codex'
  return runtime
}

export function isRuntimeTaskSelected(
  currentRuntimeTask: RuntimeTaskAddress | null | undefined,
  workspace: RuntimeDeviceWorkspace,
  task: LocalTaskSummary
) {
  return (
    currentRuntimeTask?.deviceId === workspace.deviceId &&
    currentRuntimeTask.workspacePath === workspace.workspacePath &&
    currentRuntimeTask.localTaskId === task.localTaskId
  )
}
