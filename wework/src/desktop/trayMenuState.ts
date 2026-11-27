import {
  getRuntimeChatSidebarTaskItems,
  getRuntimeSidebarTaskItems,
  sortRuntimeTaskItems,
} from '@/components/layout/runtimeTaskSidebarHelpers'
import type {
  RuntimeTaskSummary,
  RuntimeDeviceWorkspace,
  RuntimeWorkListResponse,
} from '@/types/api'
import {
  getRuntimeTaskLifecycleKey,
  type RuntimeTaskLifecycleStoreSnapshot,
} from '@/features/workbench/runtimeTaskLifecycle'
import { type RuntimeTaskReminderState } from '@/features/workbench/runtimeTaskReminders'
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
  activeTaskIds: string[] | null
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
  activeTaskIds: null,
  unreadCount: 0,
  pinned: [],
  pinnedMore: [],
  recent: [],
  recentMore: [],
}

export interface TrayMenuTaskGroupOptions {
  reminders?: Pick<RuntimeTaskReminderState, 'unreadTaskKeys' | 'unreadCount' | 'hasRunningTasks'>
  lifecycle?: Pick<RuntimeTaskLifecycleStoreSnapshot, 'runningTaskKeys'>
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
  return sortRuntimeTaskItems([...projectItems, ...chatItems]) as TrayRuntimeTaskItem[]
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

function splitTrayMenuTasks(items: TrayMenuTaskItem[]) {
  return {
    visible: items.slice(0, TRAY_MENU_TASK_LIMIT),
    more: items.slice(TRAY_MENU_TASK_LIMIT),
  }
}

function indexTrayMenuTasks(runtimeWork?: RuntimeWorkListResponse | null) {
  const byKey = new Map<string, { item: TrayMenuTaskItem; taskId: string; index: number }>()
  const pinned: TrayMenuTaskItem[] = []
  const recent: TrayMenuTaskItem[] = []
  for (const { workspace, task, projectName } of collectRuntimeTaskItems(runtimeWork)) {
    const address = { deviceId: workspace.deviceId, taskId: task.taskId }
    const key = getRuntimeTaskLifecycleKey(address)
    if (byKey.has(key)) continue
    const item = { id: createTrayTaskMenuId(address), title: getTrayTaskTitle(task), projectName }
    byKey.set(key, { item, taskId: task.taskId, index: recent.length })
    recent.push(item)
    if (isPinnedRuntimeTask(task)) pinned.push(item)
  }
  return { byKey, pinned: splitTrayMenuTasks(pinned), recent: splitTrayMenuTasks(recent) }
}

const emptyTrayIndex = indexTrayMenuTasks()
const trayIndexes = new WeakMap<RuntimeWorkListResponse, ReturnType<typeof indexTrayMenuTasks>>()

function trayIndex(runtimeWork: RuntimeWorkListResponse | null | undefined) {
  if (!runtimeWork) return emptyTrayIndex
  let index = trayIndexes.get(runtimeWork)
  if (!index) {
    index = indexTrayMenuTasks(runtimeWork)
    trayIndexes.set(runtimeWork, index)
  }
  return index
}

export function buildTrayMenuTaskGroups(
  runtimeWork: RuntimeWorkListResponse | null | undefined,
  options: TrayMenuTaskGroupOptions = {}
): TrayMenuTaskGroups {
  const { reminders, showUnread = true, showRunning = true } = options
  const { byKey, pinned, recent } = trayIndex(runtimeWork)
  const select = (keys: ReadonlySet<string> | undefined) =>
    keys
      ? [...keys]
          .flatMap(key => byKey.get(key) ?? [])
          .sort((left, right) => left.index - right.index)
      : []
  const activeTasks = select(options.lifecycle?.runningTaskKeys)
  const running = showRunning ? activeTasks : []
  const unread = showUnread ? select(reminders?.unreadTaskKeys) : []
  const runningTasks = splitTrayMenuTasks(running.map(entry => entry.item))
  const unreadTasks = splitTrayMenuTasks(unread.map(entry => entry.item))

  return {
    running: runningTasks.visible,
    runningMore: runningTasks.more,
    unread: unreadTasks.visible,
    unreadMore: unreadTasks.more,
    hasRunningTasks: showRunning && activeTasks.length > 0,
    showRunningStatus: showRunning,
    runningCount: running.length,
    activeTaskIds: activeTasks.map(({ taskId }) => taskId),
    unreadCount: showUnread ? (reminders?.unreadCount ?? unread.length) : 0,
    pinned: pinned.visible,
    pinnedMore: pinned.more,
    recent: recent.visible,
    recentMore: recent.more,
  }
}
