import { useDesktopSidebarSectionArchives } from './useDesktopSidebarSectionArchives'
import { useDesktopSidebarProjectEditor } from './useDesktopSidebarProjectEditor'
import { useDesktopSidebarCatalog } from './useDesktopSidebarCatalog'
import { createRuntimeTaskPinSource } from './runtimeTaskPinSource'
import { useScrollRequest, useWindowEvent } from '@wegent/collaboration/dom-events'
import { createDesktopSidebarPreferences } from './desktopSidebarPreferences'

import { useCallback, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'

import { useDialogKeyboard } from '@/hooks/useDialogKeyboard'

import { useOptionalAppUpdate } from '@/features/app-update/app-update-context'
import type { WeworkDshSidebarNavigationItem } from '@/features/dsh-runtime/dshSidebarNavigation'

import { WEWORK_DSH_SLOTS } from '@/features/dsh-runtime/dshUiSlots'
import { useDshSlotEntries } from '@/features/dsh-runtime/useDshSlotEntries'
import {
  getRuntimeTaskReminderItemKey,
  getRuntimeTaskReminderKey,
} from '@/features/workbench/runtimeTaskReminders'
import { getRuntimeTaskThreadId } from '@/features/workbench/workbenchRuntimeHelpers'
import {
  useRuntimeTaskLifecycleStore,
  useRuntimeTaskLifecycleStoreSnapshot,
} from '@/features/workbench/runtimeTaskLifecycle'

import { useExperimentalFeaturesEnabled } from '@/features/experimental-features/useExperimentalFeaturesEnabled'
import {
  type StandaloneRemoteDialogIntent,
  type StandaloneWorkspaceDialogMode,
} from '@/components/projects/StandaloneProjectDialogs'
import { useConfiguredKeybinding } from '@/hooks/useConfiguredKeybinding'
import { useTranslation } from '@/hooks/useTranslation'

import { isElectronRuntime } from '@/lib/runtime-environment'
import { getPlatform } from '@/lib/platform'
import {
  shouldIgnoreWorkbenchShortcut,
  keybindingFromKeyboardEvent,
  TOGGLE_PRIORITY_FILTER_COMMAND,
  COLLAPSE_READ_CONVERSATIONS_COMMAND,
} from '@/lib/keybindings'
import { runtimeProjectUiId } from '@/lib/runtime-project'

import {
  defaultAppearance,
  getWorkbenchBackground,
  useOptionalAppearance,
} from '@/features/appearance'
import type { RuntimeTaskPinRequest } from '@/types/api'
import { RuntimeWorkLoadStatus } from './RuntimeWorkLoadStatus'
import type { ArchiveRuntimeTaskOptions } from '@/features/workbench/workbenchContextTypes'

import { type DesktopSidebarTaskViewAction } from './DesktopSidebarTaskViewControl'
import {
  createDesktopSidebarPrioritySession,
  reconcileDesktopSidebarPrioritySession,
  selectDesktopSidebarPriorityView,
  type DesktopSidebarPrioritySession,
  type DesktopSidebarPrioritySource,
} from './desktopSidebarPriorityView'
import { useSidebarPaneDragScrollLock } from './useSidebarPaneDragScrollLock'
import {
  getRuntimeTaskAddress,
  getRuntimeSidebarTaskItems,
  isRuntimeTaskSelected,
} from './runtimeTaskSidebarHelpers'
import {
  debugRuntimeSidebarState,
  runtimeSidebarScrollMetrics,
  RuntimeSidebarScrollDiagnostics,
} from '@/features/workbench/runtimeSidebarDiagnostics'
import { useSidebarRelativeTimeRefresh } from './runtimeSidebarTime'
import { useResizableSidebar } from './useResizableSidebar'
import type { DesktopSidebarProps, RuntimePriorityTaskItem } from './desktopSidebarTypes'
import {
  EMPTY_RUNTIME_TASK_KEYS,
  EMPTY_SPLIT_GROUP_MEMBERSHIPS,
  normalizeSidebarWorkspacePath,
  getDesktopSidebarStorageScope,
  getRuntimeTaskPriorityReason,
  getRuntimeTaskPriorityRank,
  getRuntimeTaskPriorityTime,
  getRuntimeTaskSortableId,
  getRuntimeNotificationKey,
} from './desktopSidebarHelpers'

export function useDesktopSidebarModel({
  user,
  projects,
  devices,
  cloudWorkStatus,
  runtimeWork,
  runtimeWorkLoad,
  onRetryRuntimeWork,
  currentRuntimeTask,
  splitGroupMemberships = EMPTY_SPLIT_GROUP_MEMBERSHIPS,
  standaloneDeviceId,
  standaloneWorkspacePath,
  imNotificationSettings,
  unreadRuntimeTaskKeys,
  standInUnreadCount = 0,
  preferredDeviceId,
  activeItem = 'chat',
  taskView = 'workbench',
  localHarnessSessions = [],
  activeLocalHarnessSessionId = null,
  onNewChat,
  onOpenStandIn,
  onStartStandaloneChat,
  onOpenLocalHarnessSession,
  onCloseLocalHarnessSession,
  onOpenSearch,
  onToggleMyWork,
  onStartNewProjectChat,
  onOpenRuntimeTask,
  onMarkRuntimeTaskRead,
  onRenameRuntimeTask,
  onArchiveRuntimeTask,
  onArchiveProjectConversations,
  onArchiveProjectsConversations,
  onArchiveChatConversations,
  onToggleRuntimeTaskNotification,
  onRefreshDevices,
  onOpenStandaloneFolderProject,
  onOpenStandaloneWorkspace,
  onCreatePermanentWorktree,
  onSelectStandaloneDevice,
  onUpdateProjectName,
  onUpdateLocalRuntimeProject,
  onRemoveProject,
  onReorderRuntimeProjects,
  onSetRuntimeProjectPinned,
  onSetRuntimeProjectAppearance,
  onReorderRuntimeProjectTasks,
  onSetRuntimeTaskPinned,
  onGetDeviceHomeDirectory,
  onListDeviceDirectories,
  onCreateDeviceDirectory,
  onCloneGitRepository,
  projectSpaceApis,
  projectDevicePluginApi,
  models = [],
  onOpenSettings,
  onLogout,
  collapsed = false,
  containerTestId = 'desktop-sidebar',
  hideResizeHandle = false,
  sidebarWidth: sidebarWidthProp,
  resizing: resizingProp,
  onResizeStart: onResizeStartProp,
  onResizeCollapse,
  onResizeStateChange,
  onPointerEnter,
  onPointerLeave,
  onToggleSidebar,
}: DesktopSidebarProps) {
  const appearanceContext = useOptionalAppearance()
  const appearance = appearanceContext?.appearance ?? defaultAppearance
  const background = getWorkbenchBackground(appearance, appearanceContext?.resolvedMode ?? 'light')
  const nowMs = useSidebarRelativeTimeRefresh()
  const { t } = useTranslation('common')
  const internalResizable = useResizableSidebar({
    onCollapse: onResizeCollapse,
    onResizeStateChange,
  })
  const sidebarWidth = sidebarWidthProp ?? internalResizable.sidebarWidth
  const resizing = resizingProp ?? internalResizable.resizing
  const handleResizeStart = onResizeStartProp ?? internalResizable.handleResizeStart
  const platform = getPlatform()
  const usesOverlayTitlebar = false
  const isWindowsDesktop = isElectronRuntime() && platform === 'win'
  const appUpdate = useOptionalAppUpdate()
  const installedReleaseNotes = appUpdate?.installedReleaseNotes ?? null
  const experimentalFeaturesEnabled = useExperimentalFeaturesEnabled()
  const registeredSidebarNavigation = useDshSlotEntries<WeworkDshSidebarNavigationItem>(
    WEWORK_DSH_SLOTS.sidebarNavigation
  )
  const sidebarNavigation = useMemo(
    () =>
      [...registeredSidebarNavigation]
        .filter(item => !item.experimental || experimentalFeaturesEnabled)
        .sort((left, right) => (left.order ?? 100) - (right.order ?? 100)),
    [experimentalFeaturesEnabled, registeredSidebarNavigation]
  )

  const storageScope = getDesktopSidebarStorageScope(user)
  const sidebarPreferences = useMemo(
    () => createDesktopSidebarPreferences(storageScope),
    [storageScope]
  )
  const {
    projectsExpanded,
    chatsExpanded,
    priorityShowPinned,
    showOfflineDeviceItems,
    expandedProjectIds,
  } = useSyncExternalStore(sidebarPreferences.subscribe, sidebarPreferences.getSnapshot)
  const {
    setProjectsExpanded,
    setChatsExpanded,
    setPriorityShowPinned,
    setShowOfflineDeviceItems,
    setExpandedProjectIds,
  } = sidebarPreferences
  const [releaseNotesDialogOpen, setReleaseNotesDialogOpen] = useState(false)
  const settingsMenuRef = useRef<HTMLDivElement>(null)

  const [priorityArchiveItems, setPriorityArchiveItems] = useState<
    RuntimePriorityTaskItem[] | null
  >(null)
  const [priorityForceArchiveItems, setPriorityForceArchiveItems] = useState<
    RuntimePriorityTaskItem[] | null
  >(null)

  const [isArchivingPriority, setIsArchivingPriority] = useState(false)
  const [projectCreateDialogOpen, setProjectCreateDialogOpen] = useState(false)
  const projectCreateDialogRef = useDialogKeyboard<HTMLDivElement>(
    () => setProjectCreateDialogOpen(false),
    projectCreateDialogOpen,
    '[data-testid="project-create-local-option"]'
  )
  const [standaloneWorkspaceDialogMode, setStandaloneWorkspaceDialogMode] =
    useState<StandaloneWorkspaceDialogMode | null>(null)
  const [standaloneRemoteDialogIntent, setStandaloneRemoteDialogIntent] =
    useState<StandaloneRemoteDialogIntent>('project')
  const {
    renamingProject,
    setRenamingProject,
    editingLocalProject,
    setEditingLocalProject,
    editingProjectWork,
    editingProjectPluginApi,
    openProjectEditor,
  } = useDesktopSidebarProjectEditor({
    runtimeWork,
    projectDevicePluginApi,
    onUpdateLocalRuntimeProject,
  })
  const [priorityFilterActive, setPriorityFilterActive] = useState(false)
  const [taskViewAction, setTaskViewAction] = useState<DesktopSidebarTaskViewAction>(() =>
    onToggleMyWork ? 'board' : 'priority'
  )
  const [prioritySession, setPrioritySession] = useState<DesktopSidebarPrioritySession | null>(null)
  const priorityFilterShortcut = useConfiguredKeybinding(TOGGLE_PRIORITY_FILTER_COMMAND)
  const collapseReadShortcut = useConfiguredKeybinding(COLLAPSE_READ_CONVERSATIONS_COMMAND)
  const [priorityScope, setPriorityScope] = useState(storageScope)
  if (priorityScope !== storageScope) {
    setPriorityScope(storageScope)
    setPriorityFilterActive(false)
    setPrioritySession(null)
  }
  const pinScope = useRuntimeTaskLifecycleStore().notificationScope
  const [pinOwner, setPinOwner] = useState(() => ({
    scope: pinScope,
    source: createRuntimeTaskPinSource(),
  }))
  if (pinOwner.scope !== pinScope) {
    setPinOwner({ scope: pinScope, source: createRuntimeTaskPinSource() })
  }
  const pinSource = pinOwner.source
  const [sidebarScrolled, setSidebarScrolled] = useState(false)
  const sidebarScrollDiagnosticsRef = useRef(new RuntimeSidebarScrollDiagnostics())
  const {
    scrollContainerRef: sidebarWorklistsScrollRef,
    dragOutsideSidebar: paneDragOutsideSidebar,
    preserveLockedScrollPosition,
  } = useSidebarPaneDragScrollLock()
  const visibleUnreadRuntimeTaskKeys = unreadRuntimeTaskKeys ?? EMPTY_RUNTIME_TASK_KEYS
  const lifecycleSnapshot = useRuntimeTaskLifecycleStoreSnapshot()
  const waitingTaskKeys = useMemo(
    () =>
      new Set(
        [...lifecycleSnapshot.tasks.entries()]
          .filter(([, lifecycle]) => lifecycle.derived.shouldShowSidebarWaiting)
          .map(([key]) => key)
      ),
    [lifecycleSnapshot.tasks]
  )
  const {
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
  } = useDesktopSidebarCatalog({
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
  })
  const allPriorityViewTaskItems = useMemo<RuntimePriorityTaskItem[]>(() => {
    const projectTasks = sidebarRuntimeProjects.flatMap(projectWork =>
      getRuntimeSidebarTaskItems(projectWork.deviceWorkspaces).map(({ workspace, task }) => ({
        workspace,
        task,
        projectName: projectWork.project.name,
        projectStateDeviceId: projectWork.project.stateDeviceId ?? workspace.deviceId,
        isStandaloneChat: false,
        reason: getRuntimeTaskPriorityReason(
          workspace,
          task,
          visibleUnreadRuntimeTaskKeys,
          lifecycleSnapshot.runningTaskKeys,
          waitingTaskKeys
        ),
      }))
    )
    const standaloneChatTasks = chatTaskItemsWithPinState.map(({ workspace, task }) => ({
      workspace,
      task,
      projectName: null,
      projectStateDeviceId: workspace.deviceId,
      isStandaloneChat: true,
      reason: getRuntimeTaskPriorityReason(
        workspace,
        task,
        visibleUnreadRuntimeTaskKeys,
        lifecycleSnapshot.runningTaskKeys,
        waitingTaskKeys
      ),
    }))

    return [...projectTasks, ...standaloneChatTasks]
  }, [
    chatTaskItemsWithPinState,
    lifecycleSnapshot.runningTaskKeys,
    sidebarRuntimeProjects,
    visibleUnreadRuntimeTaskKeys,
    waitingTaskKeys,
  ])
  const priorityViewSources = useMemo<DesktopSidebarPrioritySource<RuntimePriorityTaskItem>[]>(
    () =>
      allPriorityViewTaskItems.map(item => ({
        key: getRuntimeTaskSortableId(item.workspace, item.task),
        item,
        pinned: Boolean(item.task.pinned),
        pinnedOrder: item.task.pinnedOrder ?? Number.MAX_SAFE_INTEGER,
        priorityRank: item.reason === null ? null : getRuntimeTaskPriorityRank(item.reason),
        recencyAt: getRuntimeTaskPriorityTime(item.task),
      })),
    [allPriorityViewTaskItems]
  )
  const livePriorityTaskItems = useMemo(
    () =>
      allPriorityViewTaskItems
        .filter(item => item.reason !== null)
        .sort(
          (left, right) =>
            getRuntimeTaskPriorityRank(left.reason!) - getRuntimeTaskPriorityRank(right.reason!) ||
            getRuntimeTaskPriorityTime(right.task) - getRuntimeTaskPriorityTime(left.task)
        ),
    [allPriorityViewTaskItems]
  )
  const priorityNeedsAttention = livePriorityTaskItems.length > 0
  let currentPrioritySession = prioritySession
  if (priorityFilterActive && currentPrioritySession) {
    const reconciledSession = reconcileDesktopSidebarPrioritySession(
      currentPrioritySession,
      priorityViewSources,
      priorityShowPinned
    )
    if (reconciledSession !== currentPrioritySession) {
      currentPrioritySession = reconciledSession
      setPrioritySession(reconciledSession)
    }
  }
  const priorityView = currentPrioritySession
    ? selectDesktopSidebarPriorityView(
        currentPrioritySession,
        priorityViewSources,
        priorityShowPinned
      )
    : {
        pinnedItems: [],
        priorityItems: livePriorityTaskItems,
        recentGroups: [],
      }
  const setPriorityFilterEnabled = useCallback(
    (enabled: boolean) => {
      if (!enabled) {
        setPriorityFilterActive(false)
        setPrioritySession(null)
        return
      }
      setPrioritySession(
        createDesktopSidebarPrioritySession(priorityViewSources, priorityShowPinned)
      )
      setPriorityFilterActive(true)
    },
    [priorityShowPinned, priorityViewSources, setPriorityFilterActive, setPrioritySession]
  )
  const selectedTaskViewAction =
    taskViewAction === 'board' && !onToggleMyWork ? 'priority' : taskViewAction
  const collapseReadTaskView = useCallback(() => {
    setTaskViewAction('collapse-read')
    if (taskView === 'default-work-items') onToggleMyWork?.()
    setPriorityFilterEnabled(false)
    collapseReadConversations()
  }, [collapseReadConversations, onToggleMyWork, setPriorityFilterEnabled, taskView])
  const expandReadTaskView = useCallback(() => {
    setTaskViewAction('collapse-read')
    if (taskView === 'default-work-items') onToggleMyWork?.()
    setPriorityFilterEnabled(false)
    expandReadConversations()
  }, [expandReadConversations, onToggleMyWork, setPriorityFilterEnabled, taskView])
  const selectTaskViewAction = useCallback(
    (action: DesktopSidebarTaskViewAction) => {
      if (action === 'collapse-read') {
        collapseReadTaskView()
        return
      }
      setTaskViewAction(action)
      if (action === 'board') {
        setPriorityFilterEnabled(false)
        if (taskView !== 'default-work-items') onToggleMyWork?.()
        return
      }
      if (taskView === 'default-work-items') onToggleMyWork?.()
      setPriorityFilterEnabled(true)
    },
    [collapseReadTaskView, onToggleMyWork, setPriorityFilterEnabled, setTaskViewAction, taskView]
  )
  const togglePriorityTaskView = useCallback(() => {
    setTaskViewAction('priority')
    if (taskView === 'default-work-items') onToggleMyWork?.()
    setPriorityFilterEnabled(taskView === 'default-work-items' || !priorityFilterActive)
  }, [onToggleMyWork, priorityFilterActive, setPriorityFilterEnabled, setTaskViewAction, taskView])

  const unreadPriorityTaskItems = useMemo(
    () =>
      priorityView.priorityItems.filter(item =>
        visibleUnreadRuntimeTaskKeys.has(getRuntimeTaskReminderItemKey(item.workspace, item.task))
      ),
    [priorityView.priorityItems, visibleUnreadRuntimeTaskKeys]
  )
  const markAllPriorityTasksRead = () => {
    if (!onMarkRuntimeTaskRead) return
    for (const item of unreadPriorityTaskItems) {
      onMarkRuntimeTaskRead(getRuntimeTaskAddress(item.workspace, item.task))
    }
  }
  const openPriorityArchiveDialog = () => {
    if (isArchivingPriority || !onArchiveRuntimeTask || priorityView.priorityItems.length === 0)
      return
    setPriorityArchiveItems(priorityView.priorityItems)
  }
  const runPriorityArchive = async (
    items: RuntimePriorityTaskItem[],
    options?: ArchiveRuntimeTaskOptions
  ) => {
    if (isArchivingPriority || !onArchiveRuntimeTask || items.length === 0) return
    setPriorityArchiveItems(null)
    setPriorityForceArchiveItems(null)
    setIsArchivingPriority(true)
    const dirtyItems: RuntimePriorityTaskItem[] = []
    try {
      for (const item of items) {
        try {
          const result = await onArchiveRuntimeTask(
            getRuntimeTaskAddress(item.workspace, item.task),
            options
          )
          if (!options?.force && result?.status === 'dirty_worktree') {
            dirtyItems.push(item)
          }
        } catch (error) {
          console.error('Failed to archive priority task', error)
        }
      }
      setPriorityForceArchiveItems(dirtyItems.length > 0 ? dirtyItems : null)
    } finally {
      setIsArchivingPriority(false)
    }
  }
  const closePriorityArchiveDialog = () => {
    setPriorityArchiveItems(null)
  }
  const closePriorityForceArchiveDialog = () => {
    setPriorityForceArchiveItems(null)
  }

  const setRuntimeTaskPinnedOptimistically = async (data: RuntimeTaskPinRequest) => {
    if (!onSetRuntimeTaskPinned) return
    const projectTask = sidebarRuntimeProjectSource
      .flatMap(projectWork =>
        getRuntimeSidebarTaskItems(projectWork.deviceWorkspaces).map(item => ({
          ...item,
          stateDeviceId: projectWork.project.stateDeviceId ?? item.workspace.deviceId,
        }))
      )
      .find(
        ({ stateDeviceId, task }) =>
          stateDeviceId === data.deviceId && getRuntimeTaskThreadId(task) === data.threadId
      )
    const runtimeTask =
      projectTask ??
      chatTaskItems.find(
        ({ workspace, task }) =>
          workspace.deviceId === data.deviceId && getRuntimeTaskThreadId(task) === data.threadId
      )
    if (!runtimeTask) {
      await onSetRuntimeTaskPinned(data)
      return
    }

    await pinSource.pin(data, onSetRuntimeTaskPinned)
  }
  const projectSectionArchiveItems = useMemo(() => {
    return allSidebarRuntimeProjects
      .map(projectWork => ({
        key: projectWork.project.key,
        count: getRuntimeSidebarTaskItems(projectWork.deviceWorkspaces).length,
      }))
      .filter(item => item.count > 0)
  }, [allSidebarRuntimeProjects])
  const projectSectionArchiveKeys = useMemo(
    () => projectSectionArchiveItems.map(item => item.key),
    [projectSectionArchiveItems]
  )
  const projectSectionArchiveCount = useMemo(
    () => projectSectionArchiveItems.reduce((total, item) => total + item.count, 0),
    [projectSectionArchiveItems]
  )
  const chatSectionArchiveAddresses = useMemo(
    () => chatTaskItems.map(({ workspace, task }) => getRuntimeTaskAddress(workspace, task)),
    [chatTaskItems]
  )
  const chatSectionArchiveCount = chatSectionArchiveAddresses.length
  const selectedRuntimeProject = useMemo(() => {
    const activeHarnessProjectId = localHarnessSessions.find(
      session => session.sessionId === activeLocalHarnessSessionId
    )?.projectId
    if (activeHarnessProjectId) {
      return {
        autoExpandKey: `harness:${activeLocalHarnessSessionId}`,
        id: activeHarnessProjectId,
      }
    }

    if (currentRuntimeTask) {
      const projectWork = sidebarRuntimeProjects.find(item =>
        item.deviceWorkspaces.some(workspace =>
          workspace.tasks.some(task => isRuntimeTaskSelected(currentRuntimeTask, workspace, task))
        )
      )
      return projectWork
        ? {
            autoExpandKey: `task:${getRuntimeNotificationKey(currentRuntimeTask)}`,
            id: runtimeProjectUiId(projectWork.project),
          }
        : null
    }

    const normalizedDeviceId = standaloneDeviceId?.trim()
    const normalizedWorkspacePath = standaloneWorkspacePath
      ? normalizeSidebarWorkspacePath(standaloneWorkspacePath)
      : ''
    if (!normalizedDeviceId || !normalizedWorkspacePath) return null

    const projectWork = sidebarRuntimeProjects.find(item =>
      item.deviceWorkspaces.some(
        workspace =>
          workspace.deviceId === normalizedDeviceId &&
          normalizeSidebarWorkspacePath(workspace.workspacePath) === normalizedWorkspacePath
      )
    )
    return projectWork
      ? {
          autoExpandKey: `workspace:${normalizedDeviceId}:${normalizedWorkspacePath}`,
          id: runtimeProjectUiId(projectWork.project),
        }
      : null
  }, [
    activeLocalHarnessSessionId,
    currentRuntimeTask,
    localHarnessSessions,
    sidebarRuntimeProjects,
    standaloneDeviceId,
    standaloneWorkspacePath,
  ])
  const currentRuntimeTaskPinned = useMemo(
    () =>
      Boolean(
        currentRuntimeTask &&
        visiblePinnedTaskItems.some(({ workspace, task }) =>
          isRuntimeTaskSelected(currentRuntimeTask, workspace, task)
        )
      ),
    [currentRuntimeTask, visiblePinnedTaskItems]
  )
  const selectedRuntimeProjectPinned = Boolean(
    selectedRuntimeProject && runtimeWorkByProjectId.get(selectedRuntimeProject.id)?.project.pinned
  )
  const subscribeSelectedProject = useCallback(
    (listener: () => void) =>
      sidebarPreferences.subscribeSelection(
        listener,
        selectedRuntimeProject?.id ?? null,
        selectedRuntimeProject?.autoExpandKey ?? null,
        { taskPinned: currentRuntimeTaskPinned, projectPinned: selectedRuntimeProjectPinned }
      ),
    [
      sidebarPreferences,
      selectedRuntimeProject?.id,
      selectedRuntimeProject?.autoExpandKey,
      currentRuntimeTaskPinned,
      selectedRuntimeProjectPinned,
    ]
  )
  const { projectId: selectedRuntimeProjectId } = useSyncExternalStore(
    subscribeSelectedProject,
    sidebarPreferences.getSelectionSnapshot
  )
  const selectedRuntimeChatVisible = useMemo(() => {
    if (!currentRuntimeTask) return false
    return regularChatTaskItems.some(({ workspace, task }) =>
      isRuntimeTaskSelected(currentRuntimeTask, workspace, task)
    )
  }, [currentRuntimeTask, regularChatTaskItems])
  const displayedProjectsExpanded = projectsExpanded
  const runtimeWorkCheck = cloudWorkStatus?.checks.runtimeWork
  const showEmptyProjectCreateAction =
    runtimeWork != null &&
    runtimeWorkCheck !== null &&
    runtimeWorkCheck !== undefined &&
    runtimeWorkCheck !== 'syncing' &&
    sidebarProjects.length === 0
  const displayedChatsExpanded =
    chatsExpanded ||
    selectedRuntimeChatVisible ||
    standaloneLocalHarnessSessions.some(
      session => session.sessionId === activeLocalHarnessSessionId
    )
  const {
    archiveSectionMode,
    setArchiveSectionMode,
    forceArchiveSectionMode,
    isArchivingProjectSection,
    isArchivingChatSection,
    archiveSectionDialogTestId,
    archiveSectionDialogCount,
    closeArchiveSectionDialog,
    forceArchiveSectionDialogTestId,
    confirmArchiveSectionConversations,
    closeForceArchiveSectionDialog,
    confirmForceArchiveSectionConversations,
  } = useDesktopSidebarSectionArchives({
    onArchiveProjectsConversations,
    onArchiveChatConversations,
    projectSectionArchiveKeys,
    chatSectionArchiveAddresses,
    projectSectionArchiveCount,
    chatSectionArchiveCount,
  })
  const displayedExpandedProjectIds = visibleExpandedProjectIds
  const currentRuntimeTaskKey = currentRuntimeTask
    ? getRuntimeNotificationKey(currentRuntimeTask)
    : null
  const currentRuntimeTaskRowVisible = Boolean(
    currentRuntimeTask &&
    !collapsedReadTaskKeys.has(getRuntimeTaskReminderKey(currentRuntimeTask)) &&
    (currentRuntimeTaskPinned ||
      (selectedRuntimeProjectId !== null &&
        (selectedRuntimeProjectPinned || displayedProjectsExpanded) &&
        displayedExpandedProjectIds.has(selectedRuntimeProjectId)) ||
      (selectedRuntimeChatVisible && displayedChatsExpanded))
  )

  const handleToggleProject = (projectId: number) => {
    const projectWork = runtimeWorkByProjectId.get(projectId)
    const projectTaskKeys = new Set(
      getRuntimeSidebarTaskItems(projectWork?.deviceWorkspaces).map(({ workspace, task }) =>
        getRuntimeTaskReminderItemKey(workspace, task)
      )
    )
    const hasCollapsedReadTasks = [...projectTaskKeys].some(key => collapsedReadTaskKeys.has(key))
    if (hasCollapsedReadTasks) expandReadConversations(projectTaskKeys)
    setExpandedProjectIds(previous => {
      const next = new Set(previous)
      if (next.has(projectId) && !hasCollapsedReadTasks) {
        next.delete(projectId)
      } else {
        next.add(projectId)
      }
      return next
    })
  }

  const handleToggleChats = () => {
    const chatTaskKeys = new Set(
      chatTaskItemsWithPinState.map(({ workspace, task }) =>
        getRuntimeTaskReminderItemKey(workspace, task)
      )
    )
    const hasCollapsedReadTasks = [...chatTaskKeys].some(key => collapsedReadTaskKeys.has(key))
    if (hasCollapsedReadTasks) expandReadConversations(chatTaskKeys)
    setChatsExpanded(expanded => hasCollapsedReadTasks || !expanded)
  }

  const openProjectCreateDialog = (event: ReactMouseEvent<HTMLButtonElement>) => {
    // Pointer activation should not restore keyboard focus to the icon on dismissal.
    if (event.detail > 0) event.currentTarget.blur()
    setProjectCreateDialogOpen(true)
    void onRefreshDevices?.().catch(() => undefined)
  }

  useWindowEvent(
    'keydown',
    event => {
      if (event.defaultPrevented || shouldIgnoreWorkbenchShortcut(event) || event.repeat) return
      const shortcut = keybindingFromKeyboardEvent(event)
      const action =
        collapseReadShortcut && shortcut === collapseReadShortcut
          ? collapseReadTaskView
          : priorityFilterShortcut && shortcut === priorityFilterShortcut
            ? togglePriorityTaskView
            : null
      if (!action) return
      event.preventDefault()
      event.stopPropagation()
      action()
    },
    { capture: true }
  )

  type ScrollDependencies = { taskId: string | null; taskKey: string | null; rowVisible: boolean }
  const scrollObservation = useRef<{
    dependencies: ScrollDependencies
    previousDependencies: ScrollDependencies | null
    changedDependencies: (keyof ScrollDependencies)[]
  } | null>(null)
  const scrollRequest = JSON.stringify([
    currentRuntimeTask?.taskId ?? null,
    currentRuntimeTaskKey,
    currentRuntimeTaskRowVisible,
  ])
  useScrollRequest(
    sidebarWorklistsScrollRef,
    `[data-testid="runtime-local-task-row-${currentRuntimeTask?.taskId}"]`,
    scrollRequest,
    {
      enabled: Boolean(currentRuntimeTaskKey && currentRuntimeTaskRowVisible),
      onScroll: (phase, taskRow) => {
        if (phase === 'before') {
          const dependencies: ScrollDependencies = {
            taskId: currentRuntimeTask?.taskId ?? null,
            taskKey: currentRuntimeTaskKey,
            rowVisible: currentRuntimeTaskRowVisible,
          }
          const previousDependencies = scrollObservation.current?.dependencies ?? null
          scrollObservation.current = {
            dependencies,
            previousDependencies,
            changedDependencies: (['taskId', 'taskKey', 'rowVisible'] as const).filter(
              key => previousDependencies?.[key] !== dependencies[key]
            ),
          }
        }
        debugRuntimeSidebarState('active-task-auto-scroll', () => ({
          phase,
          ...scrollObservation.current,
          willScroll: Boolean(currentRuntimeTaskKey && currentRuntimeTaskRowVisible && taskRow),
          metrics: runtimeSidebarScrollMetrics(sidebarWorklistsScrollRef.current, taskRow),
        }))
      },
    }
  )

  const runtimeWorkLoadStatus = (
    <RuntimeWorkLoadStatus
      load={runtimeWorkLoad}
      hasSnapshot={runtimeWork != null}
      onRetry={onRetryRuntimeWork}
    />
  )

  return {
    nowMs,
    containerTestId,
    isWindowsDesktop,
    background,
    collapsed,
    onPointerEnter,
    onPointerLeave,
    resizing,
    sidebarWidth,
    usesOverlayTitlebar,
    onToggleSidebar,
    onOpenSearch,
    t,
    selectedTaskViewAction,
    onToggleMyWork,
    taskView,
    priorityFilterActive,
    priorityNeedsAttention,
    priorityFilterShortcut,
    collapseReadShortcut,
    collapsedReadTaskKeys,
    selectTaskViewAction,
    collapseReadTaskView,
    togglePriorityTaskView,
    expandReadTaskView,
    onNewChat,
    onOpenStandIn,
    standInUnreadCount,
    activeItem,
    sidebarWorklistsScrollRef,
    sidebarScrolled,
    paneDragOutsideSidebar,
    preserveLockedScrollPosition,
    sidebarScrollDiagnosticsRef,
    currentRuntimeTask,
    currentRuntimeTaskKey,
    currentRuntimeTaskRowVisible,
    runtimeWorkLoad,
    setSidebarScrolled,
    sidebarNavigation,
    devices,
    cloudWorkStatus,
    onOpenSettings,
    onSelectStandaloneDevice,
    onOpenStandaloneFolderProject,
    setStandaloneRemoteDialogIntent,
    setStandaloneWorkspaceDialogMode,
    runtimeWorkLoadStatus,
    priorityView,
    priorityShowPinned,
    setPriorityShowPinned,
    onMarkRuntimeTaskRead,
    unreadPriorityTaskItems,
    onArchiveRuntimeTask,
    markAllPriorityTasksRead,
    openPriorityArchiveDialog,
    isArchivingPriority,
    splitGroupMemberships,
    visibleUnreadRuntimeTaskKeys,
    imNotificationSettings,
    onOpenRuntimeTask,
    onRenameRuntimeTask,
    onSetRuntimeTaskPinned,
    setRuntimeTaskPinnedOptimistically,
    onToggleRuntimeTaskNotification,
    pinnedTaskItems,
    pinnedProjects,
    visiblePinnedTaskItems,
    onSetRuntimeProjectPinned,
    sidebarStateDeviceId,
    displayedExpandedProjectIds,

    localHarnessSessionsByProjectId,
    activeLocalHarnessSessionId,
    handleToggleProject,
    onStartNewProjectChat,
    onRemoveProject,
    onCreatePermanentWorktree,
    onReorderRuntimeProjects,
    onSetRuntimeProjectAppearance,
    onReorderRuntimeProjectTasks,
    openProjectEditor,
    onArchiveProjectConversations,
    onOpenLocalHarnessSession,
    onCloseLocalHarnessSession,
    displayedProjectsExpanded,
    sidebarProjects,
    setProjectsExpanded,
    onArchiveProjectsConversations,
    projectSectionArchiveCount,
    isArchivingProjectSection,
    setArchiveSectionMode,
    showOfflineDeviceItems,
    setShowOfflineDeviceItems,
    openProjectCreateDialog,
    projectCreateDialogOpen,

    showEmptyProjectCreateAction,
    regularSortableProjects,
    displayedChatsExpanded,
    standaloneLocalHarnessSessions,
    chatTaskItemsWithPinState,
    handleToggleChats,
    onArchiveChatConversations,
    chatSectionArchiveCount,
    isArchivingChatSection,
    onStartStandaloneChat,
    regularChatTaskItems,
    installedReleaseNotes,
    setReleaseNotesDialogOpen,
    appUpdate,
    user,
    onLogout,
    settingsMenuRef,
    hideResizeHandle,
    handleResizeStart,
    releaseNotesDialog: {
      installedReleaseNotes,
      setReleaseNotesDialogOpen,
      releaseNotesDialogOpen,
    },
    standaloneDialog: {
      devices,
      setStandaloneWorkspaceDialogMode,
      standaloneWorkspaceDialogMode,
      standaloneRemoteDialogIntent,
      preferredDeviceId,
      onGetDeviceHomeDirectory,
      onListDeviceDirectories,
      onCreateDeviceDirectory,
      onCloneGitRepository,
      onOpenStandaloneWorkspace,
      onRefreshDevices,
    },
    archiveDialogs: {
      t,
      priorityArchiveItems,
      closePriorityArchiveDialog,
      runPriorityArchive,
      priorityForceArchiveItems,
      closePriorityForceArchiveDialog,
      archiveSectionMode,
      archiveSectionDialogCount,
      archiveSectionDialogTestId,
      closeArchiveSectionDialog,
      confirmArchiveSectionConversations,
      forceArchiveSectionMode,
      forceArchiveSectionDialogTestId,
      closeForceArchiveSectionDialog,
      confirmForceArchiveSectionConversations,
    },
    projectEditDialogs: {
      t,
      devices,
      onRemoveProject,
      onGetDeviceHomeDirectory,
      onListDeviceDirectories,
      onCreateDeviceDirectory,
      renamingProject,
      setRenamingProject,
      onUpdateProjectName,
      editingLocalProject,
      editingProjectWork,
      projectSpaceApis,
      experimentalFeaturesEnabled,
      models,
      editingProjectPluginApi,
      setEditingLocalProject,
      onUpdateLocalRuntimeProject,
    },
    projectCreateMenu: {
      t,
      onOpenStandaloneFolderProject,
      setStandaloneRemoteDialogIntent,
      setStandaloneWorkspaceDialogMode,
      projectCreateDialogOpen,
      setProjectCreateDialogOpen,
      projectCreateDialogRef,
    },
  }
}
