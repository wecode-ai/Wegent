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
import { isMainWindowFocused, subscribeMainWindowFocus } from '@/tauri/windowFocus'
import type {
  RuntimeTaskLifecycleStore,
  RuntimeTaskLifecycleStoreSnapshot,
} from './runtimeTaskLifecycle'

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

function debugReminderKey(key: string): string {
  return key.replace(/\0/g, '::')
}

function logRuntimeTaskReminderState(event: string, payload: Record<string, unknown>) {
  if (globalThis.localStorage?.getItem('wework:debug-runtime') !== '1') return

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

export function useRuntimeTaskReminders({
  runtimeWork,
  lifecycleStore,
  lifecycleSnapshot,
}: {
  runtimeWork: RuntimeWorkListResponse | null | undefined
  lifecycleStore: RuntimeTaskLifecycleStore
  lifecycleSnapshot: RuntimeTaskLifecycleStoreSnapshot
}): RuntimeTaskReminderState {
  const [preferences, setPreferences] = useState<AppPreferences>(defaultAppPreferences)
  const notifiedTaskKeysRef = useRef<Set<string>>(new Set())
  const previousUnreadTaskKeysRef = useRef<ReadonlySet<string>>(new Set())
  const windowFocusedRef = useRef(isMainWindowFocused())

  useEffect(() => {
    return subscribeMainWindowFocus(focused => {
      windowFocusedRef.current = focused
    })
  }, [])

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

  const items = useMemo(() => collectRuntimeTaskReminderItems(runtimeWork), [runtimeWork])
  const itemsByKey = useMemo(() => new Map(items.map(item => [item.key, item])), [items])

  useEffect(() => {
    const previousUnreadTaskKeys = previousUnreadTaskKeysRef.current
    const nextUnreadTaskKeys = lifecycleSnapshot.unreadTaskKeys
    const newlyUnreadItems = [...nextUnreadTaskKeys]
      .filter(key => !previousUnreadTaskKeys.has(key))
      .map(key => itemsByKey.get(key))
      .filter((item): item is RuntimeTaskReminderItem => Boolean(item))
    previousUnreadTaskKeysRef.current = new Set(nextUnreadTaskKeys)

    for (const key of lifecycleSnapshot.runningTaskKeys) {
      notifiedTaskKeysRef.current.delete(key)
    }
    if (!preferences.taskCompletionNotificationsEnabled) return
    if (windowFocusedRef.current) return
    for (const item of newlyUnreadItems) {
      if (notifiedTaskKeysRef.current.has(item.key)) continue
      notifiedTaskKeysRef.current.add(item.key)
      logRuntimeTaskReminderState('system-notification-send', {
        key: debugReminderKey(item.key),
        taskId: item.task.taskId,
        title: item.task.title,
      })
      void getRuntimeTaskNotificationText(item).then(sendRuntimeTaskCompletionNotification)
    }
  }, [
    itemsByKey,
    lifecycleSnapshot.runningTaskKeys,
    lifecycleSnapshot.unreadTaskKeys,
    preferences.taskCompletionNotificationsEnabled,
  ])

  return useMemo(
    () => ({
      unreadTaskKeys: lifecycleSnapshot.unreadTaskKeys,
      unreadCount: lifecycleSnapshot.unreadTaskKeys.size,
      hasRunningTasks: lifecycleSnapshot.runningTaskKeys.size > 0,
      preferences,
      items,
      markRuntimeTaskRead: (address: RuntimeTaskAddress) => lifecycleStore.markRead(address),
    }),
    [items, lifecycleSnapshot, lifecycleStore, preferences]
  )
}
