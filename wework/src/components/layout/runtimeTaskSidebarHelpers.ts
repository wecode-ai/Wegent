import type { RuntimeTaskSummary, RuntimeDeviceWorkspace, RuntimeTaskAddress } from '@/types/api'

export interface RuntimeSidebarTaskItem {
  workspace: RuntimeDeviceWorkspace
  task: RuntimeTaskSummary
  pinned?: boolean
}

export const RUNTIME_PROJECT_TASK_PREVIEW_LIMIT = 5
export const RUNTIME_PROJECT_TASK_EXPAND_STEP = 10

export function getRuntimeTaskTime(task: RuntimeTaskSummary) {
  return task.updatedAt || task.createdAt || undefined
}

function getRuntimeTaskSortTime(task: RuntimeTaskSummary) {
  return (
    task.completedAt ||
    (!task.running ? task.updatedAt : null) ||
    task.createdAt ||
    task.updatedAt ||
    undefined
  )
}

export function sortRuntimeTasks(tasks: RuntimeTaskSummary[] = []) {
  return [...tasks].sort((left, right) => {
    const leftTime = new Date(getRuntimeTaskSortTime(left) || 0).getTime()
    const rightTime = new Date(getRuntimeTaskSortTime(right) || 0).getTime()
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
    workspaces.flatMap(workspace => workspace.tasks.map(task => ({ workspace, task })))
  )
}

export function getRuntimeChatSidebarTaskItems(
  workspaces: RuntimeDeviceWorkspace[] = []
): RuntimeSidebarTaskItem[] {
  return getRuntimeSidebarTaskItems(workspaces.filter(isRuntimeChatWorkspace))
}

export function sortRuntimeTaskItems(items: RuntimeSidebarTaskItem[]) {
  return [...items].sort((left, right) => {
    const leftTime = new Date(getRuntimeTaskSortTime(left.task) || 0).getTime()
    const rightTime = new Date(getRuntimeTaskSortTime(right.task) || 0).getTime()
    const normalizedLeftTime = Number.isNaN(leftTime) ? 0 : leftTime
    const normalizedRightTime = Number.isNaN(rightTime) ? 0 : rightTime
    return normalizedRightTime - normalizedLeftTime
  })
}

export function getVisibleRuntimeSidebarTaskItems(
  items: RuntimeSidebarTaskItem[],
  visibleLimit = RUNTIME_PROJECT_TASK_PREVIEW_LIMIT
) {
  const { pinnedItems, unpinnedItems } = partitionRuntimeSidebarTaskItems(items)
  return [
    ...pinnedItems,
    ...unpinnedItems.slice(0, Math.max(RUNTIME_PROJECT_TASK_PREVIEW_LIMIT, visibleLimit)),
  ]
}

export function getNextRuntimeSidebarTaskVisibleLimit(currentLimit: number, totalCount: number) {
  return Math.min(
    Math.max(RUNTIME_PROJECT_TASK_PREVIEW_LIMIT, currentLimit) + RUNTIME_PROJECT_TASK_EXPAND_STEP,
    totalCount
  )
}

export function hasHiddenRuntimeSidebarTaskItems(
  items: RuntimeSidebarTaskItem[],
  visibleLimit = RUNTIME_PROJECT_TASK_PREVIEW_LIMIT
) {
  const { unpinnedItems } = partitionRuntimeSidebarTaskItems(items)
  return unpinnedItems.length > Math.max(RUNTIME_PROJECT_TASK_PREVIEW_LIMIT, visibleLimit)
}

export function hasExpandedRuntimeSidebarTaskItems(
  items: RuntimeSidebarTaskItem[],
  visibleLimit = RUNTIME_PROJECT_TASK_PREVIEW_LIMIT
) {
  const { unpinnedItems } = partitionRuntimeSidebarTaskItems(items)
  return (
    unpinnedItems.slice(0, Math.max(RUNTIME_PROJECT_TASK_PREVIEW_LIMIT, visibleLimit)).length >
    RUNTIME_PROJECT_TASK_PREVIEW_LIMIT
  )
}

export function getRuntimeTaskWorkspaceTitle(workspace: RuntimeDeviceWorkspace) {
  const deviceLabel = workspace.deviceName || workspace.deviceId
  return `${deviceLabel} ${workspace.workspacePath}`
}

function isRuntimeWorktreeWorkspace(workspace: RuntimeDeviceWorkspace) {
  return (
    workspace.workspaceKind === 'worktree' ||
    Boolean(workspace.worktreeId) ||
    Boolean(getWorktreeIdFromPath(workspace.workspacePath))
  )
}

export function getRuntimeTaskWorkspacePath(
  workspace: RuntimeDeviceWorkspace,
  task: RuntimeTaskSummary
) {
  if (isRuntimeWorktreeWorkspace(workspace)) return workspace.workspacePath
  return task.workspacePath || workspace.workspacePath
}

export function getRuntimeTaskAddress(
  workspace: RuntimeDeviceWorkspace,
  task: RuntimeTaskSummary
): RuntimeTaskAddress {
  return {
    deviceId: workspace.deviceId,
    taskId: task.taskId,
    workspacePath: getRuntimeTaskWorkspacePath(workspace, task),
    ...(task.taskId ? { taskId: task.taskId } : {}),
    ...(task.runtimeHandle ? { runtimeHandle: task.runtimeHandle } : {}),
    ...(task.permissionMode ? { permissionMode: task.permissionMode } : {}),
  }
}

export function isRuntimeWorktreeTask(task: RuntimeTaskSummary) {
  return task.workspaceKind === 'worktree' || Boolean(task.worktreeId)
}

export function isRuntimeChatWorkspace(workspace: RuntimeDeviceWorkspace) {
  return (
    workspace.workspaceKind === 'chat' ||
    workspace.tasks.some(task => task.workspaceKind === 'chat') ||
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

function partitionRuntimeSidebarTaskItems(items: RuntimeSidebarTaskItem[]) {
  const pinnedItems: RuntimeSidebarTaskItem[] = []
  const unpinnedItems: RuntimeSidebarTaskItem[] = []
  for (const item of items) {
    if (item.pinned) {
      pinnedItems.push(item)
    } else {
      unpinnedItems.push(item)
    }
  }
  return { pinnedItems, unpinnedItems }
}

export function isRuntimeTaskSelected(
  currentRuntimeTask: RuntimeTaskAddress | null | undefined,
  workspace: RuntimeDeviceWorkspace,
  task: RuntimeTaskSummary
) {
  const taskAddress = getRuntimeTaskAddress(workspace, task)
  const currentPath = currentRuntimeTask?.workspacePath?.trim()
  const taskPath = taskAddress.workspacePath?.trim()
  return (
    currentRuntimeTask?.deviceId === taskAddress.deviceId &&
    currentRuntimeTask.taskId === taskAddress.taskId &&
    (!currentPath || !taskPath || currentPath === taskPath)
  )
}
