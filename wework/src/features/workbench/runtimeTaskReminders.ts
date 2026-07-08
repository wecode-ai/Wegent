import { useEffect, useMemo, useRef, useState } from 'react'
import {
  APP_PREFERENCES_CHANGED_EVENT,
  defaultAppPreferences,
  getAppPreferences,
  type AppPreferences,
} from '@/tauri/appPreferences'
import type {
  RuntimeDeviceWorkspace,
  RuntimeTaskAddress,
  RuntimeTaskSummary,
  RuntimeWorkListResponse,
} from '@/types/api'
import {
  getRuntimeTaskAddress,
  getRuntimeTaskWorkspaceTitle,
} from '@/components/layout/runtimeTaskSidebarHelpers'
import { getRuntimeTaskNotificationText } from './runtimeTaskNotificationContent'
import { sendRuntimeTaskCompletionNotification } from './runtimeTaskSystemNotifications'

export interface RuntimeTaskReminderItem {
  key: string
  address: RuntimeTaskAddress
  task: RuntimeTaskSummary
  workspace: RuntimeDeviceWorkspace
  projectName: string
}

export interface RuntimeTaskReminderState {
  unreadTaskKeys: ReadonlySet<string>
  unreadCount: number
  hasRunningTasks: boolean
  preferences: AppPreferences
  markRuntimeTaskRead: (address: RuntimeTaskAddress) => void
  items: RuntimeTaskReminderItem[]
}

export const EMPTY_RUNTIME_TASK_REMINDERS: RuntimeTaskReminderState = {
  unreadTaskKeys: new Set<string>(),
  unreadCount: 0,
  hasRunningTasks: false,
  preferences: defaultAppPreferences,
  markRuntimeTaskRead: () => {},
  items: [],
}

interface RuntimeTaskReminderSnapshot {
  unreadTaskKeys: Set<string>
  runningTaskKeys: Set<string>
  completedUnreadItems: RuntimeTaskReminderItem[]
  items: RuntimeTaskReminderItem[]
}

const REMINDER_STORAGE_VERSION = 1
const TERMINAL_RUNTIME_TASK_STATUSES = new Set([
  'done',
  'complete',
  'completed',
  'failed',
  'error',
  'cancelled',
  'canceled',
])

function getReminderStoragePrefix(userId: number | string | null | undefined): string {
  return `wework.runtimeTaskReminders.${userId ?? 'anonymous'}.${REMINDER_STORAGE_VERSION}`
}

function getReminderStorageKey(
  userId: number | string | null | undefined,
  key: 'runningTaskKeys' | 'unreadTaskKeys'
): string {
  return `${getReminderStoragePrefix(userId)}.${key}`
}

function readStoredStringSet(key: string): Set<string> {
  if (typeof window === 'undefined') return new Set()
  try {
    const parsed = JSON.parse(window.localStorage.getItem(key) ?? '[]')
    return new Set(Array.isArray(parsed) ? parsed.filter(item => typeof item === 'string') : [])
  } catch {
    return new Set()
  }
}

function writeStoredStringSet(key: string, values: ReadonlySet<string>) {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(key, JSON.stringify([...values]))
}

function debugReminderKey(key: string): string {
  return key.replace(/\0/g, '::')
}

function debugReminderKeys(values: ReadonlySet<string>): string[] {
  return [...values].map(debugReminderKey)
}

function sameStringSet(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  if (left.size !== right.size) return false
  for (const value of left) {
    if (!right.has(value)) return false
  }
  return true
}

function logRuntimeTaskReminderState(event: string, payload: Record<string, unknown>) {
  console.info(`[Wework] Runtime task reminder ${event}`, payload)
}

export function getRuntimeTaskReminderKey(address: RuntimeTaskAddress): string {
  return `${address.deviceId}\0${address.taskId}`
}

export function getRuntimeTaskReminderItemKey(
  workspace: RuntimeDeviceWorkspace,
  task: RuntimeTaskSummary
): string {
  return getRuntimeTaskReminderKey(getRuntimeTaskAddress(workspace, task))
}

function normalizeTaskStatus(status: string | null | undefined): string | null {
  const normalized = status?.replace(/[_-]/g, '').trim().toLowerCase()
  return normalized || null
}

function isRuntimeTaskTerminal(task: RuntimeTaskSummary): boolean {
  const status = normalizeTaskStatus(task.status)
  return status ? TERMINAL_RUNTIME_TASK_STATUSES.has(status) : !task.running
}

function isRuntimeTaskActive(task: RuntimeTaskSummary): boolean {
  if (task.running) return true
  return !isRuntimeTaskTerminal(task)
}

function collectRuntimeTaskReminderItems(
  runtimeWork: RuntimeWorkListResponse | null | undefined
): RuntimeTaskReminderItem[] {
  if (!runtimeWork) return []

  const items: RuntimeTaskReminderItem[] = []
  for (const projectWork of runtimeWork.projects) {
    for (const workspace of projectWork.deviceWorkspaces) {
      for (const task of workspace.tasks) {
        const address = getRuntimeTaskAddress(workspace, task)
        items.push({
          key: getRuntimeTaskReminderKey(address),
          address,
          task,
          workspace,
          projectName: projectWork.project.name || getRuntimeTaskWorkspaceTitle(workspace),
        })
      }
    }
  }
  for (const workspace of runtimeWork.chats) {
    for (const task of workspace.tasks) {
      const address = getRuntimeTaskAddress(workspace, task)
      items.push({
        key: getRuntimeTaskReminderKey(address),
        address,
        task,
        workspace,
        projectName: workspace.label || getRuntimeTaskWorkspaceTitle(workspace),
      })
    }
  }

  const seen = new Set<string>()
  return items.filter(item => {
    if (seen.has(item.key)) return false
    seen.add(item.key)
    return true
  })
}

export function buildRuntimeTaskReminderSnapshot({
  runtimeWork,
  currentRuntimeTask,
  previousRunningTaskKeys,
  storedUnreadTaskKeys,
  currentRuntimeTaskVisible = false,
}: {
  runtimeWork: RuntimeWorkListResponse | null | undefined
  currentRuntimeTask: RuntimeTaskAddress | null | undefined
  previousRunningTaskKeys: ReadonlySet<string>
  storedUnreadTaskKeys: ReadonlySet<string>
  currentRuntimeTaskVisible?: boolean
}): RuntimeTaskReminderSnapshot {
  const items = collectRuntimeTaskReminderItems(runtimeWork)
  const currentRuntimeTaskKey = currentRuntimeTask
    ? getRuntimeTaskReminderKey(currentRuntimeTask)
    : null
  const runningTaskKeys = new Set(
    items.filter(item => isRuntimeTaskActive(item.task)).map(item => item.key)
  )
  const unreadTaskKeys = new Set(storedUnreadTaskKeys)
  const completedUnreadItems: RuntimeTaskReminderItem[] = []
  if (currentRuntimeTaskVisible && currentRuntimeTaskKey) {
    unreadTaskKeys.delete(currentRuntimeTaskKey)
  }

  for (const item of items) {
    if (!isRuntimeTaskTerminal(item.task) || !previousRunningTaskKeys.has(item.key)) {
      continue
    }
    if (currentRuntimeTaskVisible && item.key === currentRuntimeTaskKey) {
      continue
    }
    if (!unreadTaskKeys.has(item.key)) {
      completedUnreadItems.push(item)
    }
    unreadTaskKeys.add(item.key)
  }

  return { unreadTaskKeys, runningTaskKeys, completedUnreadItems, items }
}

function getWindowFocused(): boolean {
  if (typeof document === 'undefined') return false
  return document.visibilityState === 'visible' && document.hasFocus()
}

export function useRuntimeTaskReminders({
  userId,
  runtimeWork,
  currentRuntimeTask,
}: {
  userId: number | string | null | undefined
  runtimeWork: RuntimeWorkListResponse | null | undefined
  currentRuntimeTask: RuntimeTaskAddress | null | undefined
}): RuntimeTaskReminderState {
  const [preferences, setPreferences] = useState<AppPreferences>(defaultAppPreferences)
  const [storageVersion, setStorageVersion] = useState(0)
  const [windowFocused, setWindowFocused] = useState(getWindowFocused)
  const notifiedTaskKeysRef = useRef<Set<string>>(new Set())
  const runningTaskKeysStorageKey = getReminderStorageKey(userId, 'runningTaskKeys')
  const unreadTaskKeysStorageKey = getReminderStorageKey(userId, 'unreadTaskKeys')

  useEffect(() => {
    let cancelled = false
    const refreshPreferences = () => {
      void getAppPreferences()
        .then(nextPreferences => {
          if (!cancelled) setPreferences(nextPreferences)
        })
        .catch(error => {
          console.error('[Wework] Failed to load task reminder preferences', error)
        })
    }

    refreshPreferences()
    window.addEventListener(APP_PREFERENCES_CHANGED_EVENT, refreshPreferences)
    return () => {
      cancelled = true
      window.removeEventListener(APP_PREFERENCES_CHANGED_EVENT, refreshPreferences)
    }
  }, [])

  useEffect(() => {
    const refreshFocused = () => setWindowFocused(getWindowFocused())
    window.addEventListener('focus', refreshFocused)
    window.addEventListener('blur', refreshFocused)
    document.addEventListener('visibilitychange', refreshFocused)
    refreshFocused()
    return () => {
      window.removeEventListener('focus', refreshFocused)
      window.removeEventListener('blur', refreshFocused)
      document.removeEventListener('visibilitychange', refreshFocused)
    }
  }, [])

  const storedUnreadTaskKeys = useMemo(() => {
    void storageVersion
    return readStoredStringSet(unreadTaskKeysStorageKey)
  }, [storageVersion, unreadTaskKeysStorageKey])
  const snapshot = useMemo(
    () =>
      buildRuntimeTaskReminderSnapshot({
        runtimeWork,
        currentRuntimeTask,
        previousRunningTaskKeys: readStoredStringSet(runningTaskKeysStorageKey),
        storedUnreadTaskKeys,
        currentRuntimeTaskVisible: windowFocused,
      }),
    [
      currentRuntimeTask,
      runningTaskKeysStorageKey,
      runtimeWork,
      storedUnreadTaskKeys,
      windowFocused,
    ]
  )

  useEffect(() => {
    if (!runtimeWork) return

    const previousUnreadTaskKeys = readStoredStringSet(unreadTaskKeysStorageKey)
    const previousRunningTaskKeys = readStoredStringSet(runningTaskKeysStorageKey)
    const unreadChanged = !sameStringSet(previousUnreadTaskKeys, snapshot.unreadTaskKeys)
    const runningChanged = !sameStringSet(previousRunningTaskKeys, snapshot.runningTaskKeys)
    if (unreadChanged || runningChanged || snapshot.completedUnreadItems.length > 0) {
      logRuntimeTaskReminderState('persist', {
        userId,
        currentRuntimeTask: currentRuntimeTask
          ? {
              deviceId: currentRuntimeTask.deviceId,
              taskId: currentRuntimeTask.taskId,
              workspacePath: currentRuntimeTask.workspacePath ?? null,
            }
          : null,
        currentRuntimeTaskVisible: windowFocused,
        taskCompletionNotificationsEnabled: preferences.taskCompletionNotificationsEnabled,
        previousUnreadTaskKeys: debugReminderKeys(previousUnreadTaskKeys),
        nextUnreadTaskKeys: debugReminderKeys(snapshot.unreadTaskKeys),
        previousRunningTaskKeys: debugReminderKeys(previousRunningTaskKeys),
        nextRunningTaskKeys: debugReminderKeys(snapshot.runningTaskKeys),
        completedUnreadItems: snapshot.completedUnreadItems.map(item => ({
          key: debugReminderKey(item.key),
          taskId: item.task.taskId,
          title: item.task.title,
          status: item.task.status ?? null,
          running: Boolean(item.task.running),
          deviceId: item.workspace.deviceId,
          workspacePath: item.workspace.workspacePath,
          projectName: item.projectName,
        })),
      })
    }

    writeStoredStringSet(unreadTaskKeysStorageKey, snapshot.unreadTaskKeys)
    writeStoredStringSet(runningTaskKeysStorageKey, snapshot.runningTaskKeys)

    if (!preferences.taskCompletionNotificationsEnabled) return
    for (const item of snapshot.completedUnreadItems) {
      if (notifiedTaskKeysRef.current.has(item.key)) continue
      notifiedTaskKeysRef.current.add(item.key)
      logRuntimeTaskReminderState('system-notification-send', {
        userId,
        key: debugReminderKey(item.key),
        taskId: item.task.taskId,
        title: item.task.title,
      })
      void getRuntimeTaskNotificationText(item).then(sendRuntimeTaskCompletionNotification)
    }
  }, [
    preferences.taskCompletionNotificationsEnabled,
    currentRuntimeTask,
    runtimeWork,
    runningTaskKeysStorageKey,
    snapshot,
    unreadTaskKeysStorageKey,
    windowFocused,
    userId,
  ])

  return useMemo(
    () => ({
      unreadTaskKeys: snapshot.unreadTaskKeys,
      unreadCount: snapshot.unreadTaskKeys.size,
      hasRunningTasks: snapshot.runningTaskKeys.size > 0,
      preferences,
      items: snapshot.items,
      markRuntimeTaskRead: (address: RuntimeTaskAddress) => {
        const nextKeys = readStoredStringSet(unreadTaskKeysStorageKey)
        const key = getRuntimeTaskReminderKey(address)
        const hadUnread = nextKeys.delete(key)
        logRuntimeTaskReminderState('mark-read', {
          userId,
          key: debugReminderKey(key),
          hadUnread,
          previousUnreadTaskKeys: debugReminderKeys(readStoredStringSet(unreadTaskKeysStorageKey)),
          nextUnreadTaskKeys: debugReminderKeys(nextKeys),
          address,
        })
        writeStoredStringSet(unreadTaskKeysStorageKey, nextKeys)
        setStorageVersion(version => version + 1)
      },
    }),
    [preferences, snapshot, unreadTaskKeysStorageKey, userId]
  )
}
