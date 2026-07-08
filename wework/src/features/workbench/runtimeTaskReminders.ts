import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
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
  runningTaskKeys: Set<string>
  completedUnreadItems: RuntimeTaskReminderItem[]
  items: RuntimeTaskReminderItem[]
}

const REMINDER_STORAGE_VERSION = 1
const MAX_STORED_REMINDER_KEYS = 200
const EMPTY_STORAGE_SNAPSHOT = '[]'
const reminderStorageListeners = new Map<string, Set<() => void>>()
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
  return parseStoredStringSetSnapshot(readStoredStringSetSnapshot(key))
}

function readStoredStringSetSnapshot(key: string): string {
  if (typeof window === 'undefined') return EMPTY_STORAGE_SNAPSHOT
  try {
    const parsed = JSON.parse(window.localStorage.getItem(key) ?? '[]')
    const values = Array.isArray(parsed) ? parsed.filter(item => typeof item === 'string') : []
    return JSON.stringify(values.slice(Math.max(0, values.length - MAX_STORED_REMINDER_KEYS)))
  } catch {
    return EMPTY_STORAGE_SNAPSHOT
  }
}

function parseStoredStringSetSnapshot(snapshot: string): Set<string> {
  try {
    const parsed = JSON.parse(snapshot)
    const values = Array.isArray(parsed) ? parsed.filter(item => typeof item === 'string') : []
    return new Set(values)
  } catch {
    return new Set()
  }
}

function writeStoredStringSet(key: string, values: ReadonlySet<string>) {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(key, JSON.stringify([...values]))
}

function limitStringSet(
  values: ReadonlySet<string>,
  limit = MAX_STORED_REMINDER_KEYS
): Set<string> {
  const entries = [...values]
  return new Set(entries.slice(Math.max(0, entries.length - limit)))
}

function writeLimitedStoredStringSet(key: string, values: ReadonlySet<string>) {
  writeStoredStringSet(key, limitStringSet(values))
}

function subscribeStoredStringSet(key: string, listener: () => void): () => void {
  const listeners = reminderStorageListeners.get(key) ?? new Set<() => void>()
  listeners.add(listener)
  reminderStorageListeners.set(key, listeners)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) {
      reminderStorageListeners.delete(key)
    }
  }
}

function emitStoredStringSetChange(key: string) {
  reminderStorageListeners.get(key)?.forEach(listener => listener())
}

function useStoredStringSet(key: string): Set<string> {
  const subscribe = useCallback(
    (listener: () => void) => subscribeStoredStringSet(key, listener),
    [key]
  )
  const getSnapshot = useCallback(() => readStoredStringSetSnapshot(key), [key])
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, () => EMPTY_STORAGE_SNAPSHOT)
  return useMemo(() => parseStoredStringSetSnapshot(snapshot), [snapshot])
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
  previousRunningTaskKeys,
  currentRuntimeTask,
}: {
  runtimeWork: RuntimeWorkListResponse | null | undefined
  previousRunningTaskKeys: ReadonlySet<string>
  currentRuntimeTask?: RuntimeTaskAddress | null | undefined
}): RuntimeTaskReminderSnapshot {
  const items = collectRuntimeTaskReminderItems(runtimeWork)
  const runningTaskKeys = new Set(
    items.filter(item => isRuntimeTaskActive(item.task)).map(item => item.key)
  )
  const currentRuntimeTaskKey = currentRuntimeTask
    ? getRuntimeTaskReminderKey(currentRuntimeTask)
    : null
  const completedUnreadItems: RuntimeTaskReminderItem[] = []

  for (const item of items) {
    if (!isRuntimeTaskTerminal(item.task) || !previousRunningTaskKeys.has(item.key)) {
      continue
    }
    if (item.key === currentRuntimeTaskKey) {
      continue
    }
    completedUnreadItems.push(item)
  }

  return { runningTaskKeys, completedUnreadItems, items }
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
  const runningTaskKeysStorageKey = getReminderStorageKey(userId, 'runningTaskKeys')
  const unreadTaskKeysStorageKey = getReminderStorageKey(userId, 'unreadTaskKeys')
  const [preferences, setPreferences] = useState<AppPreferences>(defaultAppPreferences)
  const runningTaskKeys = useStoredStringSet(runningTaskKeysStorageKey)
  const unreadTaskKeys = useStoredStringSet(unreadTaskKeysStorageKey)
  const notifiedTaskKeysRef = useRef<Set<string>>(new Set())

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

  const snapshot = useMemo(
    () =>
      buildRuntimeTaskReminderSnapshot({
        runtimeWork,
        previousRunningTaskKeys: runningTaskKeys,
        currentRuntimeTask,
      }),
    [currentRuntimeTask, runningTaskKeys, runtimeWork]
  )

  useEffect(() => {
    if (!runtimeWork) return

    const previousUnreadTaskKeys = readStoredStringSet(unreadTaskKeysStorageKey)
    const previousRunningTaskKeys = readStoredStringSet(runningTaskKeysStorageKey)
    const nextUnreadTaskKeys = new Set(previousUnreadTaskKeys)
    const completedUnreadItems = snapshot.completedUnreadItems.filter(item => {
      if (nextUnreadTaskKeys.has(item.key)) return false
      nextUnreadTaskKeys.add(item.key)
      return true
    })
    const unreadChanged = !sameStringSet(previousUnreadTaskKeys, nextUnreadTaskKeys)
    const runningChanged = !sameStringSet(previousRunningTaskKeys, snapshot.runningTaskKeys)
    if (unreadChanged || runningChanged) {
      logRuntimeTaskReminderState('persist', {
        userId,
        currentRuntimeTask: currentRuntimeTask
          ? {
              deviceId: currentRuntimeTask.deviceId,
              taskId: currentRuntimeTask.taskId,
              workspacePath: currentRuntimeTask.workspacePath ?? null,
            }
          : null,
        taskCompletionNotificationsEnabled: preferences.taskCompletionNotificationsEnabled,
        previousUnreadTaskKeys: debugReminderKeys(previousUnreadTaskKeys),
        nextUnreadTaskKeys: debugReminderKeys(nextUnreadTaskKeys),
        previousRunningTaskKeys: debugReminderKeys(previousRunningTaskKeys),
        nextRunningTaskKeys: debugReminderKeys(snapshot.runningTaskKeys),
        completedUnreadItems: completedUnreadItems.map(item => ({
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

    if (unreadChanged) {
      writeLimitedStoredStringSet(unreadTaskKeysStorageKey, nextUnreadTaskKeys)
      emitStoredStringSetChange(unreadTaskKeysStorageKey)
    }
    if (runningChanged) {
      const nextRunningTaskKeys = limitStringSet(snapshot.runningTaskKeys)
      writeStoredStringSet(runningTaskKeysStorageKey, nextRunningTaskKeys)
      emitStoredStringSetChange(runningTaskKeysStorageKey)
    }

    if (!preferences.taskCompletionNotificationsEnabled) return
    for (const item of completedUnreadItems) {
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
    userId,
  ])

  return useMemo(
    () => ({
      unreadTaskKeys,
      unreadCount: unreadTaskKeys.size,
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
        writeLimitedStoredStringSet(unreadTaskKeysStorageKey, nextKeys)
        emitStoredStringSetChange(unreadTaskKeysStorageKey)
      },
    }),
    [preferences, snapshot, unreadTaskKeys, unreadTaskKeysStorageKey, userId]
  )
}
