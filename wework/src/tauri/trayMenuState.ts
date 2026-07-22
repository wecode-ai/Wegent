import {
  getRuntimeChatSidebarTaskItems,
  getRuntimeSidebarTaskItems,
  getRuntimeTaskAddress,
  sortRuntimeTaskItems,
} from '@/components/layout/runtimeTaskSidebarHelpers'
import type {
  RuntimeTaskSummary,
  RuntimeDeviceWorkspace,
  RuntimeWorkListResponse,
} from '@/types/api'
import {
  getRuntimeTaskReminderItemKey,
  type RuntimeTaskReminderState,
} from '@/features/workbench/runtimeTaskReminders'
import { createTrayTaskMenuId } from './trayTaskMenuId'

export interface TrayMenuTaskItem {
  id: string
  title: string
  projectName: string
}

export interface TrayMenuTaskGroups {
  running: TrayMenuTaskItem[]
  runningMore: TrayMenuTaskItem[]
  unread: TrayMenuTaskItem[]
  unreadMore: TrayMenuTaskItem[]
  hasRunningTasks: boolean
  showRunningStatus: boolean
  runningCount: number
  activeTaskCount: number
  unreadCount: number
  pinned: TrayMenuTaskItem[]
  pinnedMore: TrayMenuTaskItem[]
  recent: TrayMenuTaskItem[]
  recentMore: TrayMenuTaskItem[]
}

export const TRAY_MENU_TASK_LIMIT = 3

const PINNED_TASK_FIELDS = ['pinned', 'isPinned', 'is_pinned', 'marked'] as const

export const EMPTY_TRAY_MENU_TASK_GROUPS: TrayMenuTaskGroups = {
  running: [],
  runningMore: [],
  unread: [],
  unreadMore: [],
  hasRunningTasks: false,
  showRunningStatus: false,
  runningCount: 0,
  activeTaskCount: 0,
  unreadCount: 0,
  pinned: [],
  pinnedMore: [],
  recent: [],
  recentMore: [],
}

export interface TrayMenuTaskGroupOptions {
  reminders?: Pick<RuntimeTaskReminderState, 'unreadTaskKeys' | 'unreadCount' | 'hasRunningTasks'>
  showUnread?: boolean
  showRunning?: boolean
}

interface TrayRuntimeTaskItem {
  workspace: RuntimeDeviceWorkspace
  task: RuntimeTaskSummary
  projectName: string
}

function isPinnedRuntimeTask(task: RuntimeTaskSummary): boolean {
  const taskRecord = task as unknown as Record<string, unknown>
  return PINNED_TASK_FIELDS.some(field => taskRecord[field] === true)
}

function collectRuntimeTaskItems(
  runtimeWork: RuntimeWorkListResponse | null | undefined
): TrayRuntimeTaskItem[] {
  if (!runtimeWork) {
    return []
  }

  const projectItems = runtimeWork.projects.flatMap(projectWork =>
    getRuntimeSidebarTaskItems(projectWork.deviceWorkspaces).map(item => ({
      ...item,
      projectName: getProjectDisplayName(
        projectWork.project.name,
        item.workspace,
        projectWork.project.key
      ),
    }))
  )
  const chatItems = getRuntimeChatSidebarTaskItems(runtimeWork.chats).map(item => ({
    ...item,
    projectName: getProjectDisplayName(null, item.workspace, item.workspace.workspacePath),
  }))
  const seenTaskKeys = new Set<string>()
  const sortedItems = sortRuntimeTaskItems([...projectItems, ...chatItems]) as TrayRuntimeTaskItem[]

  return sortedItems.filter(({ workspace, task }) => {
    const taskKey = `${workspace.deviceId}\n${task.taskId}`
    if (seenTaskKeys.has(taskKey)) {
      return false
    }
    seenTaskKeys.add(taskKey)
    return true
  })
}

function getProjectDisplayName(
  projectName: string | null | undefined,
  workspace: RuntimeDeviceWorkspace,
  fallback: string
): string {
  return (
    projectName?.trim() ||
    workspace.label?.trim() ||
    workspace.workspacePath.trim() ||
    fallback.trim()
  )
}

function getTrayTaskTitle(task: RuntimeTaskSummary): string {
  return task.title.trim() || String(task.taskId)
}

function toTrayMenuTaskItem({
  workspace,
  task,
  projectName,
}: TrayRuntimeTaskItem): TrayMenuTaskItem {
  const address = getRuntimeTaskAddress(workspace, task)
  return {
    id: createTrayTaskMenuId(address),
    title: getTrayTaskTitle(task),
    projectName,
  }
}

function splitTrayMenuTasks(items: TrayRuntimeTaskItem[]) {
  return {
    visible: items.slice(0, TRAY_MENU_TASK_LIMIT).map(toTrayMenuTaskItem),
    more: items.slice(TRAY_MENU_TASK_LIMIT).map(toTrayMenuTaskItem),
  }
}

export function buildTrayMenuTaskGroups(
  runtimeWork: RuntimeWorkListResponse | null | undefined,
  options: TrayMenuTaskGroupOptions = {}
): TrayMenuTaskGroups {
  const { reminders, showUnread = true, showRunning = true } = options
  const items = collectRuntimeTaskItems(runtimeWork)
  const activeTasks = items.filter(({ task }) => task.running)
  const running = showRunning ? activeTasks : []
  const unread =
    showUnread && reminders
      ? items.filter(({ workspace, task }) =>
          reminders.unreadTaskKeys.has(getRuntimeTaskReminderItemKey(workspace, task))
        )
      : []
  const pinned = items.filter(({ task }) => isPinnedRuntimeTask(task))
  const runningTasks = splitTrayMenuTasks(running)
  const unreadTasks = splitTrayMenuTasks(unread)
  const pinnedTasks = splitTrayMenuTasks(pinned)
  const recentTasks = splitTrayMenuTasks(items)

  return {
    running: runningTasks.visible,
    runningMore: runningTasks.more,
    unread: unreadTasks.visible,
    unreadMore: unreadTasks.more,
    hasRunningTasks: showRunning ? (reminders?.hasRunningTasks ?? running.length > 0) : false,
    showRunningStatus: showRunning,
    runningCount: running.length,
    activeTaskCount: activeTasks.length,
    unreadCount: showUnread ? (reminders?.unreadCount ?? unread.length) : 0,
    pinned: pinnedTasks.visible,
    pinnedMore: pinnedTasks.more,
    recent: recentTasks.visible,
    recentMore: recentTasks.more,
  }
}
