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
  ongoingTaskKeys: Set<string>
  taskKeys: Set<string>
  currentTaskKey: string | null
  settledUnreadItems: RuntimeTaskReminderItem[]
  items: RuntimeTaskReminderItem[]
}

const REMINDER_STORAGE_VERSION = 3
const MAX_STORED_REMINDER_KEYS = 200
const EMPTY_STORAGE_SNAPSHOT = '[]'
const reminderStorageListeners = new Map<string, Set<() => void>>()

function getReminderStoragePrefix(userId: number | string | null | undefined): string {
  return `wework.runtimeTaskReminders.${userId ?? 'anonymous'}.${REMINDER_STORAGE_VERSION}`
}

function getReminderStorageKey(
  userId: number | string | null | undefined,
  key: 'ongoingTaskKeys' | 'unreadTaskKeys'
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
  if (globalThis.localStorage?.getItem('wework:debug-runtime') !== '1') return

  console.info(`[Wework] Runtime task reminder ${event}`, payload)
}

function debugRuntimeTaskAddress(address: RuntimeTaskAddress): Record<string, unknown> {
  return {
    deviceId: address.deviceId,
    taskId: address.taskId,
    workspacePath: address.workspacePath ?? null,
    hasRuntimeHandle: Boolean(address.runtimeHandle),
    runtimeHandleKeys: address.runtimeHandle ? Object.keys(address.runtimeHandle).sort() : [],
  }
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
  previousOngoingTaskKeys,
  currentRuntimeTask,
}: {
  runtimeWork: RuntimeWorkListResponse | null | undefined
  previousOngoingTaskKeys: ReadonlySet<string>
  currentRuntimeTask?: RuntimeTaskAddress | null | undefined
}): RuntimeTaskReminderSnapshot {
  const items = collectRuntimeTaskReminderItems(runtimeWork)
  const taskKeys = new Set(items.map(item => item.key))
  const runningTaskKeys = new Set(
    items.filter(item => item.task.running === true).map(item => item.key)
  )
  const ongoingTaskKeys = new Set(
    items
      .filter(item => item.task.running === true || item.task.goalStatus === 'active')
      .map(item => item.key)
  )
  const currentTaskKey = currentRuntimeTask ? getRuntimeTaskReminderKey(currentRuntimeTask) : null
  const settledUnreadItems = items.filter(item => {
    return (
      previousOngoingTaskKeys.has(item.key) &&
      !ongoingTaskKeys.has(item.key) &&
      item.key !== currentTaskKey
    )
  })

  return {
    runningTaskKeys,
    ongoingTaskKeys,
    taskKeys,
    currentTaskKey,
    settledUnreadItems,
    items,
  }
}

export function reconcileRuntimeTaskUnreadKeys({
  previousUnreadTaskKeys,
  visibleTaskKeys,
  ongoingTaskKeys,
  currentTaskKey,
  settledUnreadItems,
}: {
  previousUnreadTaskKeys: ReadonlySet<string>
  visibleTaskKeys: ReadonlySet<string>
  ongoingTaskKeys: ReadonlySet<string>
  currentTaskKey: string | null
  settledUnreadItems: RuntimeTaskReminderItem[]
}): Set<string> {
  const nextUnreadTaskKeys = new Set(
    [...previousUnreadTaskKeys].filter(
      key => visibleTaskKeys.has(key) && !ongoingTaskKeys.has(key) && key !== currentTaskKey
    )
  )
  for (const item of settledUnreadItems) {
    nextUnreadTaskKeys.add(item.key)
  }
  return nextUnreadTaskKeys
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
  const ongoingTaskKeysStorageKey = getReminderStorageKey(userId, 'ongoingTaskKeys')
  const unreadTaskKeysStorageKey = getReminderStorageKey(userId, 'unreadTaskKeys')
  const [preferences, setPreferences] = useState<AppPreferences>(defaultAppPreferences)
  const ongoingTaskKeys = useStoredStringSet(ongoingTaskKeysStorageKey)
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
        previousOngoingTaskKeys: ongoingTaskKeys,
        currentRuntimeTask,
      }),
    [currentRuntimeTask, ongoingTaskKeys, runtimeWork]
  )
  const visibleUnreadTaskKeys = useMemo(
    () =>
      new Set(
        [...unreadTaskKeys].filter(
          key =>
            snapshot.taskKeys.has(key) &&
            !snapshot.ongoingTaskKeys.has(key) &&
            key !== snapshot.currentTaskKey
        )
      ),
    [snapshot.currentTaskKey, snapshot.ongoingTaskKeys, snapshot.taskKeys, unreadTaskKeys]
  )

  useEffect(() => {
    if (!runtimeWork) return

    const previousUnreadTaskKeys = readStoredStringSet(unreadTaskKeysStorageKey)
    const previousOngoingTaskKeys = readStoredStringSet(ongoingTaskKeysStorageKey)
    const nextUnreadTaskKeys = reconcileRuntimeTaskUnreadKeys({
      previousUnreadTaskKeys,
      visibleTaskKeys: snapshot.taskKeys,
      ongoingTaskKeys: snapshot.ongoingTaskKeys,
      currentTaskKey: snapshot.currentTaskKey,
      settledUnreadItems: snapshot.settledUnreadItems,
    })
    const newlySettledUnreadItems = snapshot.settledUnreadItems.filter(item => {
      return !previousUnreadTaskKeys.has(item.key)
    })
    const unreadChanged = !sameStringSet(previousUnreadTaskKeys, nextUnreadTaskKeys)
    const ongoingChanged = !sameStringSet(previousOngoingTaskKeys, snapshot.ongoingTaskKeys)
    if (unreadChanged || ongoingChanged) {
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
        previousOngoingTaskKeys: debugReminderKeys(previousOngoingTaskKeys),
        nextOngoingTaskKeys: debugReminderKeys(snapshot.ongoingTaskKeys),
        settledUnreadItems: newlySettledUnreadItems.map(item => ({
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
    if (ongoingChanged) {
      const nextOngoingTaskKeys = limitStringSet(snapshot.ongoingTaskKeys)
      writeStoredStringSet(ongoingTaskKeysStorageKey, nextOngoingTaskKeys)
      emitStoredStringSetChange(ongoingTaskKeysStorageKey)
    }

    for (const key of snapshot.ongoingTaskKeys) {
      notifiedTaskKeysRef.current.delete(key)
    }
    if (!preferences.taskCompletionNotificationsEnabled) return
    for (const item of newlySettledUnreadItems) {
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
    ongoingTaskKeysStorageKey,
    snapshot,
    unreadTaskKeysStorageKey,
    userId,
  ])

  return useMemo(
    () => ({
      unreadTaskKeys: visibleUnreadTaskKeys,
      unreadCount: visibleUnreadTaskKeys.size,
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
          address: debugRuntimeTaskAddress(address),
        })
        writeLimitedStoredStringSet(unreadTaskKeysStorageKey, nextKeys)
        emitStoredStringSetChange(unreadTaskKeysStorageKey)
      },
    }),
    [preferences, snapshot, unreadTaskKeysStorageKey, userId, visibleUnreadTaskKeys]
  )
}
