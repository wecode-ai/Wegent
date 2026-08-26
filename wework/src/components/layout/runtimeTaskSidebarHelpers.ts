import type { RuntimeTaskSummary, RuntimeDeviceWorkspace, RuntimeTaskAddress } from '@/types/api'
import { isProjectAutomationManagerRuntimeTask } from '@/features/workbench/runtimeTaskOrigin'

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

export function isRuntimeTaskQueued(task: RuntimeTaskSummary): boolean {
  return task.status?.trim().toLowerCase() === 'queued'
}

function getRuntimeTaskSortTime(task: RuntimeTaskSummary) {
  const value = task.updatedAt ?? task.createdAt ?? task.completedAt
  if (value == null) return 0
  const timestamp = new Date(value).getTime()
  return Number.isNaN(timestamp) ? 0 : timestamp
}

function compareRuntimeTasks(
  left: RuntimeTaskSummary,
  right: RuntimeTaskSummary,
  useSidebarOrder: boolean
) {
  const leftOrder = left.sidebarOrder
  const rightOrder = right.sidebarOrder
  if (useSidebarOrder && leftOrder != null && rightOrder != null && leftOrder !== rightOrder) {
    return leftOrder - rightOrder
  }
  if (useSidebarOrder && leftOrder != null && rightOrder == null) return 1
  if (useSidebarOrder && leftOrder == null && rightOrder != null) return -1
  return getRuntimeTaskSortTime(right) - getRuntimeTaskSortTime(left)
}

function getRuntimeTaskQueuePosition(task: RuntimeTaskSummary) {
  if (!isRuntimeTaskQueued(task)) return null
  if (!Number.isInteger(task.queuePosition) || Number(task.queuePosition) <= 0) return null
  return Number(task.queuePosition)
}

function sortQueuedTasksWithinRecencyOrder<T>(
  items: T[],
  getTask: (item: T) => RuntimeTaskSummary,
  getQueueKey: (item: T) => string
) {
  const sorted = [...items].sort((left, right) =>
    compareRuntimeTasks(getTask(left), getTask(right), getQueueKey(left) === getQueueKey(right))
  )
  const queues = new Map<string, T[]>()

  for (const item of sorted) {
    const task = getTask(item)
    if (getRuntimeTaskQueuePosition(task) === null) continue
    const key = getQueueKey(item)
    const queue = queues.get(key) ?? []
    queue.push(item)
    queues.set(key, queue)
  }

  for (const queue of queues.values()) {
    queue.sort(
      (left, right) =>
        (getRuntimeTaskQueuePosition(getTask(left)) ?? 0) -
        (getRuntimeTaskQueuePosition(getTask(right)) ?? 0)
    )
  }

  const queueOffsets = new Map<string, number>()
  return sorted.map(item => {
    if (getRuntimeTaskQueuePosition(getTask(item)) === null) return item
    const key = getQueueKey(item)
    const offset = queueOffsets.get(key) ?? 0
    queueOffsets.set(key, offset + 1)
    return queues.get(key)?.[offset] ?? item
  })
}

export function sortRuntimeTasks(tasks: RuntimeTaskSummary[] = []) {
  return sortQueuedTasksWithinRecencyOrder(
    tasks,
    task => task,
    () => 'local'
  )
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
  return getRuntimeSidebarTaskItems(workspaces.filter(isRuntimeChatWorkspace)).filter(
    ({ task }) => !isProjectAutomationManagerRuntimeTask(task)
  )
}

export function sortRuntimeTaskItems(items: RuntimeSidebarTaskItem[]) {
  return sortQueuedTasksWithinRecencyOrder(
    items,
    item => item.task,
    item => item.workspace.deviceId
  )
}

export function getVisibleRuntimeSidebarTaskItems(
  items: RuntimeSidebarTaskItem[],
  visibleLimit = RUNTIME_PROJECT_TASK_PREVIEW_LIMIT,
  alwaysVisibleTaskId?: string | null,
  isAlwaysVisibleTask?: (item: RuntimeSidebarTaskItem) => boolean
) {
  const { pinnedItems, unpinnedItems } = partitionRuntimeSidebarTaskItems(items)
  const visibleUnpinnedItems = unpinnedItems.slice(
    0,
    Math.max(RUNTIME_PROJECT_TASK_PREVIEW_LIMIT, visibleLimit)
  )
  const mostRecentItem = unpinnedItems.reduce<RuntimeSidebarTaskItem | undefined>(
    (latest, item) =>
      !latest || getRuntimeTaskSortTime(item.task) > getRuntimeTaskSortTime(latest.task)
        ? item
        : latest,
    undefined
  )
  const alwaysVisibleItems = unpinnedItems.filter(
    item =>
      item === mostRecentItem ||
      item.task.taskId === alwaysVisibleTaskId ||
      isAlwaysVisibleTask?.(item) ||
      isRuntimeTaskQueued(item.task)
  )
  for (const item of alwaysVisibleItems) {
    if (!visibleUnpinnedItems.some(visibleItem => visibleItem.task.taskId === item.task.taskId)) {
      visibleUnpinnedItems.push(item)
    }
  }
  return [...pinnedItems, ...visibleUnpinnedItems]
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
  const deviceName = workspace.deviceName?.trim()
  return deviceName ? `${deviceName} ${workspace.workspacePath}` : workspace.workspacePath
}

export function getRuntimeTaskWorkspacePath(
  workspace: RuntimeDeviceWorkspace,
  task: RuntimeTaskSummary
) {
  return task.workspacePath || workspace.workspacePath
}

export function getRuntimeTaskAddress(
  workspace: RuntimeDeviceWorkspace,
  task: RuntimeTaskSummary
): RuntimeTaskAddress {
  return {
    deviceId: workspace.deviceId,
    taskId: task.taskId,
    ...(task.runtime !== 'codex' ? { runtime: task.runtime } : {}),
    workspacePath: getRuntimeTaskWorkspacePath(workspace, task),
    ...(task.taskId ? { taskId: task.taskId } : {}),
    ...(task.runtimeHandle ? { runtimeHandle: task.runtimeHandle } : {}),
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
    return previous === '.wework'
  }
  return parts[0] === 'workspace' && parts[1] === 'chats'
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
