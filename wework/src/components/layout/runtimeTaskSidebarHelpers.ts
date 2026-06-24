import type { LocalTaskSummary, RuntimeDeviceWorkspace, RuntimeTaskAddress } from '@/types/api'

export interface RuntimeSidebarTaskItem {
  workspace: RuntimeDeviceWorkspace
  task: LocalTaskSummary
}

export const RUNTIME_PROJECT_TASK_PREVIEW_LIMIT = 5

export function getRuntimeTaskTime(task: LocalTaskSummary) {
  return task.updatedAt || task.createdAt || undefined
}

export function sortRuntimeTasks(tasks: LocalTaskSummary[] = []) {
  return [...tasks].sort((left, right) => {
    const leftTime = new Date(getRuntimeTaskTime(left) || 0).getTime()
    const rightTime = new Date(getRuntimeTaskTime(right) || 0).getTime()
    const normalizedLeftTime = Number.isNaN(leftTime) ? 0 : leftTime
    const normalizedRightTime = Number.isNaN(rightTime) ? 0 : rightTime
    return normalizedRightTime - normalizedLeftTime
  })
}

export function getRuntimeTaskRuntimeLabel(runtime: string) {
  if (runtime === 'claude_code') return 'Claude Code'
  if (runtime === 'codex') return 'Codex'
  return runtime
}

export function getRuntimeSidebarTaskItems(
  workspaces: RuntimeDeviceWorkspace[] = []
): RuntimeSidebarTaskItem[] {
  return sortRuntimeTaskItems(
    workspaces.flatMap(workspace => workspace.localTasks.map(task => ({ workspace, task })))
  )
}

export function getRuntimeChatSidebarTaskItems(
  workspaces: RuntimeDeviceWorkspace[] = []
): RuntimeSidebarTaskItem[] {
  return getRuntimeSidebarTaskItems(workspaces.filter(isRuntimeChatWorkspace))
}

export function sortRuntimeTaskItems(items: RuntimeSidebarTaskItem[]) {
  return [...items].sort((left, right) => {
    const leftTime = new Date(getRuntimeTaskTime(left.task) || 0).getTime()
    const rightTime = new Date(getRuntimeTaskTime(right.task) || 0).getTime()
    const normalizedLeftTime = Number.isNaN(leftTime) ? 0 : leftTime
    const normalizedRightTime = Number.isNaN(rightTime) ? 0 : rightTime
    return normalizedRightTime - normalizedLeftTime
  })
}

export function getVisibleRuntimeSidebarTaskItems(
  items: RuntimeSidebarTaskItem[],
  expanded: boolean
) {
  if (expanded) return items
  return items.slice(0, RUNTIME_PROJECT_TASK_PREVIEW_LIMIT)
}

export function hasHiddenRuntimeSidebarTaskItems(items: RuntimeSidebarTaskItem[]) {
  return items.length > RUNTIME_PROJECT_TASK_PREVIEW_LIMIT
}

export function getRuntimeTaskWorkspaceTitle(workspace: RuntimeDeviceWorkspace) {
  const deviceLabel = workspace.deviceName || workspace.deviceId
  return `${deviceLabel} ${workspace.workspacePath}`
}

export function getRuntimeTaskAddress(
  workspace: RuntimeDeviceWorkspace,
  task: LocalTaskSummary
): RuntimeTaskAddress {
  return {
    deviceId: workspace.deviceId,
    localTaskId: task.localTaskId,
  }
}

export function isRuntimeWorktreeTask(task: LocalTaskSummary) {
  return task.workspaceKind === 'worktree' || Boolean(getWorktreeIdFromPath(task.workspacePath))
}

export function isRuntimeChatWorkspace(workspace: RuntimeDeviceWorkspace) {
  return (
    workspace.workspaceKind === 'chat' ||
    workspace.localTasks.some(task => task.workspaceKind === 'chat') ||
    isRuntimeChatPath(workspace.workspacePath)
  )
}

function isRuntimeChatPath(path: string) {
  const parts = path.split('/').filter(Boolean)
  for (let index = 0; index < parts.length; index += 1) {
    if (parts[index] !== 'workspace' || parts[index + 1] !== 'chats') continue
    const previous = parts[index - 1]
    if (!previous) return true
    return previous === 'wegent-executor' || previous === '.wegent-executor'
  }
  return parts[0] === 'workspace' && parts[1] === 'chats'
}

function getWorktreeIdFromPath(path: string) {
  const parts = path.split('/').filter(Boolean)
  const index = parts.indexOf('worktrees')
  if (index < 0 || index + 1 >= parts.length) return null
  return parts[index + 1] || null
}

export function isRuntimeTaskSelected(
  currentRuntimeTask: RuntimeTaskAddress | null | undefined,
  workspace: RuntimeDeviceWorkspace,
  task: LocalTaskSummary
) {
  const taskAddress = getRuntimeTaskAddress(workspace, task)
  return (
    currentRuntimeTask?.deviceId === taskAddress.deviceId &&
    currentRuntimeTask.localTaskId === taskAddress.localTaskId
  )
}
