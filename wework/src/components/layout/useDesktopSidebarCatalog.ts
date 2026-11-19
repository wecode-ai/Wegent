import {
  createRuntimeTaskPinSource,
  getRuntimeTaskPinOverrideKey,
  getRuntimeTaskPinnedValue,
} from './runtimeTaskPinSource'

import { useCallback, useMemo, useSyncExternalStore } from 'react'

import {
  getRuntimeTaskReminderItemKey,
  getRuntimeTaskReminderKey,
} from '@/features/workbench/runtimeTaskReminders'
import { getRuntimeTaskThreadId } from '@/features/workbench/workbenchRuntimeHelpers'
import {
  getRuntimeTaskLifecycleKey,
  useRuntimeTaskLifecycleStoreSnapshot,
} from '@/features/workbench/runtimeTaskLifecycle'

import { runtimeProjectToProject, runtimeProjectUiId } from '@/lib/runtime-project'
import { getLocalRuntimeStateDeviceId } from '@/lib/runtime-project-state'

import { useCollapsedReadConversations } from './useCollapsedReadConversations'

import {
  getRuntimeChatSidebarTaskItems,
  getRuntimeTaskAddress,
  getRuntimeSidebarTaskItems,
} from './runtimeTaskSidebarHelpers'

import type { LocalHarnessWorkbenchSession } from './localHarnessWorkbench'
import type { DesktopSidebarProps } from './desktopSidebarTypes'
import {
  standaloneRuntimeProjectWork,
  pruneProjectIdSet,
  getProjectDeviceId,
  getSidebarDeviceState,
  isRuntimeWorkspaceOffline,
  filterOfflineRuntimeProjectWorkspaces,
  isRuntimeTaskWaiting,
} from './desktopSidebarHelpers'

type SidebarCatalogInput = Pick<
  DesktopSidebarProps,
  | 'devices'
  | 'standaloneDeviceId'
  | 'standaloneWorkspacePath'
  | 'runtimeWork'
  | 'projects'
  | 'currentRuntimeTask'
> & {
  localHarnessSessions: NonNullable<DesktopSidebarProps['localHarnessSessions']>
  pinSource: ReturnType<typeof createRuntimeTaskPinSource>
  showOfflineDeviceItems: boolean
  expandedProjectIds: Set<number>
  visibleUnreadRuntimeTaskKeys: ReadonlySet<string>
  lifecycleSnapshot: ReturnType<typeof useRuntimeTaskLifecycleStoreSnapshot>
  storageScope: string
}
export function useDesktopSidebarCatalog({
  devices,
  standaloneDeviceId,
  standaloneWorkspacePath,
  runtimeWork,
  projects,
  pinSource,
  showOfflineDeviceItems,
  expandedProjectIds,
  localHarnessSessions,
  visibleUnreadRuntimeTaskKeys,
  currentRuntimeTask,
  lifecycleSnapshot,
  storageScope,
}: SidebarCatalogInput) {
  const sidebarStateDeviceId = getLocalRuntimeStateDeviceId(devices)
  const standaloneProjectWork = useMemo(
    () =>
      standaloneRuntimeProjectWork(
        devices,
        standaloneDeviceId,
        standaloneWorkspacePath,
        runtimeWork
      ),
    [devices, runtimeWork, standaloneDeviceId, standaloneWorkspacePath]
  )
  const sidebarRuntimeProjectSource = useMemo(() => {
    const items = runtimeWork?.projects ?? []
    return standaloneProjectWork ? [standaloneProjectWork, ...items] : items
  }, [runtimeWork?.projects, standaloneProjectWork])
  const runtimeTaskPersistedPinStates = useMemo(() => {
    const states = new Map<string, boolean>()
    for (const projectWork of sidebarRuntimeProjectSource) {
      for (const workspace of projectWork.deviceWorkspaces) {
        for (const task of workspace.tasks) {
          const threadId = getRuntimeTaskThreadId(task)
          if (!threadId) continue
          states.set(
            getRuntimeTaskPinOverrideKey(
              projectWork.project.stateDeviceId ?? workspace.deviceId,
              threadId
            ),
            Boolean(task.pinned)
          )
        }
      }
    }
    for (const workspace of runtimeWork?.chats ?? []) {
      for (const task of workspace.tasks) {
        const threadId = getRuntimeTaskThreadId(task)
        if (!threadId) continue
        states.set(getRuntimeTaskPinOverrideKey(workspace.deviceId, threadId), Boolean(task.pinned))
      }
    }
    return states
  }, [runtimeWork?.chats, sidebarRuntimeProjectSource])
  const subscribePins = useCallback(
    (listener: () => void) => pinSource.subscribe(listener, runtimeTaskPersistedPinStates),
    [pinSource, runtimeTaskPersistedPinStates]
  )
  const runtimeTaskPinOverrides = useSyncExternalStore(subscribePins, pinSource.getSnapshot)
  const allSidebarRuntimeProjects = useMemo(
    () =>
      sidebarRuntimeProjectSource.map(projectWork => ({
        ...projectWork,
        deviceWorkspaces: projectWork.deviceWorkspaces.map(workspace => ({
          ...workspace,
          tasks: workspace.tasks.map(task => {
            const threadId = getRuntimeTaskThreadId(task)
            const persistedPinned = Boolean(task.pinned)
            const override = threadId
              ? runtimeTaskPinOverrides.get(
                  getRuntimeTaskPinOverrideKey(
                    projectWork.project.stateDeviceId ?? workspace.deviceId,
                    threadId
                  )
                )
              : undefined
            const pinned = getRuntimeTaskPinnedValue(persistedPinned, override)
            return pinned === persistedPinned ? task : { ...task, pinned }
          }),
        })),
      })),
    [runtimeTaskPinOverrides, sidebarRuntimeProjectSource]
  )
  const sidebarRuntimeProjects = useMemo(
    () =>
      showOfflineDeviceItems
        ? allSidebarRuntimeProjects
        : filterOfflineRuntimeProjectWorkspaces(allSidebarRuntimeProjects, devices),
    [allSidebarRuntimeProjects, devices, showOfflineDeviceItems]
  )
  const allSidebarProjects = useMemo(() => {
    if (runtimeWork || standaloneProjectWork) {
      return allSidebarRuntimeProjects.map(runtimeProjectToProject)
    }
    return projects
  }, [allSidebarRuntimeProjects, projects, runtimeWork, standaloneProjectWork])
  const sidebarProjects = useMemo(() => {
    if (runtimeWork || standaloneProjectWork) {
      return sidebarRuntimeProjects.map(runtimeProjectToProject)
    }
    if (showOfflineDeviceItems) return projects
    return projects.filter(
      project => getSidebarDeviceState(getProjectDeviceId(project), devices)?.status !== 'offline'
    )
  }, [
    devices,
    projects,
    runtimeWork,
    showOfflineDeviceItems,
    sidebarRuntimeProjects,
    standaloneProjectWork,
  ])
  const visibleExpandedProjectIds = useMemo(
    () => pruneProjectIdSet(expandedProjectIds, sidebarProjects),
    [expandedProjectIds, sidebarProjects]
  )
  const runtimeWorkByProjectId = useMemo(() => {
    return new Map(sidebarRuntimeProjects.map(item => [runtimeProjectUiId(item.project), item]))
  }, [sidebarRuntimeProjects])
  const sortableProjects = useMemo(
    () =>
      sidebarProjects.map(project => ({
        project,
        runtimeProjectWork: runtimeWorkByProjectId.get(project.id),
      })),
    [runtimeWorkByProjectId, sidebarProjects]
  )
  const pinnedProjects = useMemo(
    () =>
      sortableProjects
        .filter(({ runtimeProjectWork }) => runtimeProjectWork?.project.pinned)
        .sort(
          (left, right) =>
            (left.runtimeProjectWork?.project.pinnedOrder ?? Number.MAX_SAFE_INTEGER) -
            (right.runtimeProjectWork?.project.pinnedOrder ?? Number.MAX_SAFE_INTEGER)
        ),
    [sortableProjects]
  )
  const regularSortableProjects = useMemo(
    () => sortableProjects.filter(({ runtimeProjectWork }) => !runtimeProjectWork?.project.pinned),
    [sortableProjects]
  )
  const sidebarProjectIds = useMemo(
    () => new Set(sidebarProjects.map(project => project.id)),
    [sidebarProjects]
  )
  const allSidebarProjectIds = useMemo(
    () => new Set(allSidebarProjects.map(project => project.id)),
    [allSidebarProjects]
  )
  const standaloneLocalHarnessSessions = useMemo(
    () =>
      localHarnessSessions.filter(
        session => session.projectId === null || !allSidebarProjectIds.has(session.projectId)
      ),
    [allSidebarProjectIds, localHarnessSessions]
  )
  const localHarnessSessionsByProjectId = useMemo(() => {
    const sessionsByProjectId = new Map<number, LocalHarnessWorkbenchSession[]>()
    for (const session of localHarnessSessions) {
      if (session.projectId === null || !sidebarProjectIds.has(session.projectId)) continue
      const sessions = sessionsByProjectId.get(session.projectId) ?? []
      sessions.push(session)
      sessionsByProjectId.set(session.projectId, sessions)
    }
    return sessionsByProjectId
  }, [localHarnessSessions, sidebarProjectIds])
  const chatWorkspaces = useMemo(() => runtimeWork?.chats ?? [], [runtimeWork?.chats])
  const chatTaskItems = useMemo(
    () => getRuntimeChatSidebarTaskItems(chatWorkspaces),
    [chatWorkspaces]
  )
  const visibleChatTaskItems = useMemo(
    () =>
      showOfflineDeviceItems
        ? chatTaskItems
        : getRuntimeChatSidebarTaskItems(
            chatWorkspaces.filter(workspace => !isRuntimeWorkspaceOffline(workspace, devices))
          ),
    [chatTaskItems, chatWorkspaces, devices, showOfflineDeviceItems]
  )
  const chatTaskItemsWithPinState = useMemo(
    () =>
      visibleChatTaskItems.map(item => {
        const threadId = getRuntimeTaskThreadId(item.task)
        const persistedPinned = Boolean(item.task.pinned)
        const override = threadId
          ? runtimeTaskPinOverrides.get(
              getRuntimeTaskPinOverrideKey(item.workspace.deviceId, threadId)
            )
          : undefined
        const pinned = getRuntimeTaskPinnedValue(persistedPinned, override)
        return pinned === persistedPinned ? item : { ...item, task: { ...item.task, pinned } }
      }),
    [runtimeTaskPinOverrides, visibleChatTaskItems]
  )
  const { collapsibleTaskKeys, keepVisibleTaskKeys } = useMemo(() => {
    const collapsibleTaskKeys = new Set<string>()
    const keepVisibleTaskKeys = new Set(visibleUnreadRuntimeTaskKeys)
    if (currentRuntimeTask) keepVisibleTaskKeys.add(getRuntimeTaskReminderKey(currentRuntimeTask))
    const items = [
      ...allSidebarRuntimeProjects.flatMap(projectWork =>
        getRuntimeSidebarTaskItems(projectWork.deviceWorkspaces)
      ),
      ...chatTaskItems,
    ]
    for (const { workspace, task } of items) {
      const key = getRuntimeTaskReminderItemKey(workspace, task)
      const lifecycle = lifecycleSnapshot.tasks.get(
        getRuntimeTaskLifecycleKey(getRuntimeTaskAddress(workspace, task))
      )
      collapsibleTaskKeys.add(key)
      if (
        lifecycle?.derived.isBusy ||
        lifecycle?.derived.shouldShowSidebarWaiting ||
        isRuntimeTaskWaiting(task)
      ) {
        keepVisibleTaskKeys.add(key)
      }
    }
    return { collapsibleTaskKeys, keepVisibleTaskKeys }
  }, [
    allSidebarRuntimeProjects,
    chatTaskItems,
    currentRuntimeTask,
    lifecycleSnapshot.tasks,
    visibleUnreadRuntimeTaskKeys,
  ])
  const { collapsedReadTaskKeys, collapseReadConversations, expandReadConversations } =
    useCollapsedReadConversations(storageScope, collapsibleTaskKeys, keepVisibleTaskKeys)
  const regularChatTaskItems = useMemo(
    () =>
      chatTaskItemsWithPinState.filter(
        ({ workspace, task }) =>
          !task.pinned && !collapsedReadTaskKeys.has(getRuntimeTaskReminderItemKey(workspace, task))
      ),
    [chatTaskItemsWithPinState, collapsedReadTaskKeys]
  )
  const pinnedTaskItems = useMemo(() => {
    const projectTasks = sidebarRuntimeProjects.flatMap(projectWork =>
      getRuntimeSidebarTaskItems(projectWork.deviceWorkspaces)
        .filter(({ task }) => task.pinned)
        .map(item => ({ ...item, projectWork }))
    )
    const chatTasks = chatTaskItemsWithPinState
      .filter(({ task }) => task.pinned)
      .map(item => ({ ...item, projectWork: null }))
    return [...projectTasks, ...chatTasks].sort(
      (left, right) =>
        (left.task.pinnedOrder ?? Number.MAX_SAFE_INTEGER) -
        (right.task.pinnedOrder ?? Number.MAX_SAFE_INTEGER)
    )
  }, [chatTaskItemsWithPinState, sidebarRuntimeProjects])
  const visiblePinnedTaskItems = useMemo(
    () =>
      pinnedTaskItems.filter(
        ({ workspace, task }) =>
          !collapsedReadTaskKeys.has(getRuntimeTaskReminderItemKey(workspace, task))
      ),
    [collapsedReadTaskKeys, pinnedTaskItems]
  )

  return {
    sidebarStateDeviceId,
    sidebarRuntimeProjectSource,
    allSidebarRuntimeProjects,
    sidebarRuntimeProjects,
    sidebarProjects,
    visibleExpandedProjectIds,
    runtimeWorkByProjectId,
    pinnedProjects,
    regularSortableProjects,
    standaloneLocalHarnessSessions,
    localHarnessSessionsByProjectId,
    chatTaskItems,
    chatTaskItemsWithPinState,
    collapsedReadTaskKeys,
    collapseReadConversations,
    expandReadConversations,
    regularChatTaskItems,
    pinnedTaskItems,
    visiblePinnedTaskItems,
  }
}
