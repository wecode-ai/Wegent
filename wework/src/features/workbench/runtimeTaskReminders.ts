import {
  createRuntimeTaskReminderSource,
  EMPTY_RUNTIME_TASK_REMINDERS,
  projectRuntimeTaskReminders,
} from './runtimeTaskReminderSource'
import { createAppPreferencesStore } from '@/features/app-preferences/appPreferencesStore'
import { useCallback, useContext, useMemo, useState, useSyncExternalStore } from 'react'
import type { AppPreferences } from '@/desktop/appPreferences'
import { createActiveNotificationPreferencesStore } from '@/features/notifications/notificationPreferences'
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
import { useStandInMessageReminders } from './useStandInMessageReminders'
import { useUnlistedStandInTasks } from '@/features/notifications/useUnlistedStandInTasks'
import type { StandInExecutorApi } from '@/api/standIn'
import type { WorkbenchServices } from './workbenchServices'
import { RuntimeTaskRemindersContext, WorkbenchSidebarRemindersContext } from './workbenchContexts'
import type {
  RuntimeTaskLifecycleStore,
  RuntimeTaskLifecycleStoreSnapshot,
  RuntimeTaskLifecycleSnapshot,
} from './runtimeTaskLifecycle'

export interface RuntimeTaskReminderItem {
  key: string
  address: RuntimeTaskAddress
  task: RuntimeTaskSummary
  workspace: RuntimeDeviceWorkspace
  projectName: string
  lifecycle?: RuntimeTaskLifecycleSnapshot
}

export interface RuntimeTaskReminderState {
  unreadMessageCounts?: ReadonlyMap<string, number>
  unreadTaskKeys: ReadonlySet<string>
  unreadCount: number
  hasRunningTasks: boolean
  preferences: AppPreferences
  markRuntimeTaskRead: (address: RuntimeTaskAddress) => void
  items: RuntimeTaskReminderItem[]
}

export { EMPTY_RUNTIME_TASK_REMINDERS }

export function useWorkbenchTaskReminders(): RuntimeTaskReminderState {
  return useContext(RuntimeTaskRemindersContext) ?? EMPTY_RUNTIME_TASK_REMINDERS
}

export function useWorkbenchSidebarReminders() {
  return useContext(WorkbenchSidebarRemindersContext) ?? EMPTY_RUNTIME_TASK_REMINDERS
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

export function collectRuntimeTaskReminderItems(
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
  standInApi,
  runtimeApi,
  publish,
}: {
  runtimeWork: RuntimeWorkListResponse | null | undefined
  lifecycleStore: RuntimeTaskLifecycleStore
  lifecycleSnapshot: RuntimeTaskLifecycleStoreSnapshot
  standInApi?: StandInExecutorApi
  runtimeApi?: WorkbenchServices['runtimeWorkApi']
  publish?: (reminders: RuntimeTaskReminderState) => void
}): RuntimeTaskReminderState {
  const [appPreferences] = useState(createAppPreferencesStore)
  const [notificationPreferencesStore] = useState(createActiveNotificationPreferencesStore)
  const { preferences } = useSyncExternalStore(appPreferences.subscribe, appPreferences.getSnapshot)
  const notificationPreferences = useSyncExternalStore(
    notificationPreferencesStore.subscribe,
    notificationPreferencesStore.getSnapshot
  )

  const sidebarItems = useMemo(() => collectRuntimeTaskReminderItems(runtimeWork), [runtimeWork])
  const listedItems = useUnlistedStandInTasks(sidebarItems, lifecycleSnapshot, standInApi)
  const items = useMemo(() => {
    const visible = new Set(listedItems.map(item => item.key))
    const unlisted = [...lifecycleSnapshot.tasks.values()].flatMap(snapshot => {
      if (visible.has(snapshot.key) || !snapshot.interactionStatus || !snapshot.task) return []
      return [
        {
          key: snapshot.key,
          address: snapshot.address,
          task: snapshot.task,
          lifecycle: snapshot,
          workspace: {
            deviceId: snapshot.address.deviceId,
            available: true,
            workspacePath: snapshot.task.workspacePath,
            tasks: [snapshot.task],
          },
          projectName: '',
        },
      ]
    })
    return unlisted.length ? [...listedItems, ...unlisted] : listedItems
  }, [listedItems, lifecycleSnapshot.tasks])
  const unreadMessageCounts = useStandInMessageReminders(
    items,
    lifecycleStore,
    notificationPreferences,
    runtimeApi
  )
  const source = useMemo(() => createRuntimeTaskReminderSource(lifecycleStore), [lifecycleStore])
  const subscribe = useCallback(
    (listener: () => void) =>
      source.subscribe(listener, {
        items,
        listedItems,
        notificationPreferences,
        unreadMessageCounts,
        preferences,
        publish,
      }),
    [source, items, listedItems, notificationPreferences, unreadMessageCounts, preferences, publish]
  )
  const unreadTaskKeys = useSyncExternalStore(subscribe, source.getSnapshot)
  const hasRunningTasks = lifecycleSnapshot.runningTaskKeys.size > 0
  return useMemo(
    () =>
      projectRuntimeTaskReminders({
        unreadTaskKeys,
        unreadMessageCounts,
        hasRunningTasks,
        preferences,
        items,
        markRuntimeTaskRead: source.markRuntimeTaskRead,
      }),
    [unreadTaskKeys, unreadMessageCounts, hasRunningTasks, preferences, items, source]
  )
}
