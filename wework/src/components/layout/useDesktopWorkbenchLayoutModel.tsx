import { useDOMEvent } from '@wegent/collaboration/dom-events'
import { WorkspaceTabsSessionContext } from '@/features/workspace-tabs/workspaceTabsContextValue'
import { useOptionalCloudConnection } from '@/features/cloud-connection/useCloudConnection'
import { resolveWorkbenchOwnership } from '@/features/workbench/workbenchOwnership'
import { createDesktopLayoutState } from './desktopLayoutState'
import { createDesktopLayoutSession } from './desktopLayoutSession'
import { useCallback, useContext, useMemo, useState, useSyncExternalStore } from 'react'
import type { ProjectCreateMode } from '@/components/chat/ChatInput'
import { useWorkbench } from '@/features/workbench/useWorkbench'
import { useAuth } from '@/features/auth/useAuth'
import type { RuntimeTaskAddress } from '@/types/api'
import { stripAppBasePath } from '@/config/runtime'
import { navigateTo } from '@/lib/navigation'
import { shouldUseNativeProjectDirectoryPicker } from '@/e2e/automation'
import type { DesktopSidebarAccountSettingsOptions } from './DesktopSidebarAccount'
import {
  type StandaloneRemoteDialogIntent,
  type StandaloneWorkspaceDialogMode,
} from '@/components/projects/StandaloneProjectDialogs'
import {
  useDesktopSidebarCollapsed,
  useDesktopSidebarToggleRequest,
} from './useDesktopSidebarCollapsed'
import { useTranslation } from '@/hooks/useTranslation'
import {
  useWorkbenchShellEventHandlers,
  type ProjectCreateRequestOptions,
} from './workbenchShellEvents'
import { useWorkbenchSidebarReminders } from '@/features/workbench/runtimeTaskReminders'
import { useRuntimeTaskLifecycleStoreSnapshot } from '@/features/workbench/runtimeTaskLifecycle'
import { LOCAL_USER } from '@/api/local/localSession'
import { resolveLocalTodoProjects } from '@/features/todo/localTodoProjects'
import { projectSpaceApis } from '@/features/todo/projectSpaceSelection'
import {
  defaultProjectSpaceContentRoute,
  projectSpaceRouteTargetsDefaultWorkItems,
} from '@/features/todo/projectSpaceRoute'
import { useResizableSidebar } from './useResizableSidebar'
import { useOptionalWorkspaceTabs } from '@/features/workspace-tabs/workspaceTabsContextValue'
import { getRuntimeTaskChatScopeKey } from '@/features/workbench/workbenchProviderHelpers'
import {
  requestWorkbenchComposerFocus,
  WORKBENCH_NEW_CHAT_FOCUS_EVENT,
} from '@/lib/workbenchComposerFocus'
import {
  archiveLocalHarnessSession,
  closeLocalTerminal,
  isLocalHarnessAvailable,
  WEWORK_LOCAL_HARNESS_SESSIONS_CHANGED_EVENT,
} from '@/lib/local-terminal'
import type {
  LocalHarnessSessionRegistrationOptions,
  LocalHarnessWorkbenchSession,
} from './localHarnessWorkbench'
import {
  getRuntimeWorkbenchPaneKeys,
  getWorkbenchPaneKey,
  type WorkbenchPaneIdentity,
} from './workbenchPaneIdentity'
import { openProjectSpaceRuntimeTaskInTab } from './projectSpaceRuntimeTaskNavigation'
import { useWorkbenchSplitGroups, workbenchSplitStorageKeys } from './useWorkbenchSplitGroups'
import { useCreatePermanentWorktree } from './useCreatePermanentWorktree'
import {
  isSameRuntimeTask,
  type DesktopWorkbenchLayoutProps,
} from './desktopWorkbenchLayoutHelpers'
export function useDesktopWorkbenchLayoutModel({
  routeActive = true,
  surfaceKind,
}: DesktopWorkbenchLayoutProps) {
  const { t } = useTranslation('common')

  const { logout: onLogout } = useAuth()
  const {
    state,
    cloudWorkStatus,
    upgradingDevices,
    selectProject: onSelectProject,
    selectStandaloneDevice,
    openStandaloneWorkspace: onOpenStandaloneWorkspace,
    startNewChat: onNewChat,
    startStandaloneChat: onStartStandaloneChat,
    startNewProjectChat: onStartNewProjectChat,
    openRuntimeTask: onOpenRuntimeTask,
    loadRuntimeTranscriptForPane: onLoadRuntimeTranscriptForPane,
    searchRuntimeWork: onSearchRuntimeWork = async () => ({ items: [] }),
    renameRuntimeTask: onRenameRuntimeTask,
    archiveRuntimeTask: onArchiveRuntimeTask,
    archiveProjectConversations: onArchiveProjectConversations,
    archiveProjectsConversations: onArchiveProjectsConversations,
    archiveChatConversations: onArchiveChatConversations,
    cancelRuntimeTask: onCancelRuntimeTask,
    refreshDevices: onRefreshDevices,
    upgradeDevice: onUpgradeDevice = async () => {},
    createProject: onCreateProject,
    createLocalRuntimeProject: onCreateLocalRuntimeProject,
    createGitWorkspaceProject: onCreateGitWorkspaceProject,
    prepareDeviceWorkspace: onPrepareDeviceWorkspace,
    deleteDeviceWorkspace: onDeleteDeviceWorkspace,
    listGitRepositories: onListGitRepositories,
    listGitBranches: onListGitBranches,
    updateProjectName: onUpdateProjectName,
    updateLocalRuntimeProject: onUpdateLocalRuntimeProject,
    removeProject: onRemoveProject,
    reorderRuntimeProjects: onReorderRuntimeProjects,
    setRuntimeProjectPinned: onSetRuntimeProjectPinned,
    setRuntimeProjectAppearance: onSetRuntimeProjectAppearance,
    reorderRuntimeProjectTasks: onReorderRuntimeProjectTasks,
    setRuntimeTaskPinned: onSetRuntimeTaskPinned,
    getDeviceHomeDirectory: onGetDeviceHomeDirectory,
    getProjectWorkspaceRoot: onGetProjectWorkspaceRoot,
    listDeviceDirectories: onListDeviceDirectories,
    createDeviceDirectory: onCreateDeviceDirectory,
    cloneGitRepository: onCloneGitRepository,
    listImPrivateSessions: onListImPrivateSessions,
    getImNotificationSettings: onGetImNotificationSettings,
    subscribeRuntimeTaskNotifications: onSubscribeRuntimeTaskNotifications,
    unsubscribeRuntimeTaskNotifications: onUnsubscribeRuntimeTaskNotifications,
    projectChat,
    sendRuntimePaneMessage,
    services,
    refreshWorkLists,
    workspaceTabId,
  } = useWorkbench()
  const localTodoProjects = useMemo(
    () => resolveLocalTodoProjects(state.projects, state.runtimeWork),
    [state.projects, state.runtimeWork]
  )
  const availableProjectSpaceApis = useMemo(() => projectSpaceApis(services), [services])
  const workspaceTabs = useOptionalWorkspaceTabs()
  const ownedWorkspaceTab = workspaceTabs
    ? workspaceTabId
      ? (workspaceTabs.tabs.find(tab => tab.id === workspaceTabId) ?? null)
      : workspaceTabs.activeTab
    : null
  const activePane = useMemo<WorkbenchPaneIdentity>(
    () => ({
      currentRuntimeTask: state.currentRuntimeTask,
      currentProject: state.currentProject,
      standaloneChatKey: state.standaloneChatKey,
    }),
    [state.currentProject, state.currentRuntimeTask, state.standaloneChatKey]
  )
  const activePaneKey = getWorkbenchPaneKey(activePane)
  const blankPaneKey = getWorkbenchPaneKey({
    currentRuntimeTask: null,
    currentProject: null,
    standaloneChatKey: state.standaloneChatKey,
  })
  const runtimePaneKeys = useMemo(
    () => getRuntimeWorkbenchPaneKeys(state.runtimeWork),
    [state.runtimeWork]
  )
  const splitGroups = useWorkbenchSplitGroups({
    ...workbenchSplitStorageKeys(workspaceTabId ?? 'main'),
    activePaneKey,
    validRuntimeKeys: runtimePaneKeys,
    runtimeKeysReady: state.runtimeWork !== null,
  })
  const tabsSession = useContext(WorkspaceTabsSessionContext)
  const connection = useOptionalCloudConnection()
  const ownershipKey = resolveWorkbenchOwnership(connection, state.user).key
  const [layoutState] = useState(() =>
    createDesktopLayoutState(stripAppBasePath(window.location.pathname))
  )
  const layoutSession = useMemo(
    () => createDesktopLayoutSession(layoutState, ownershipKey, tabsSession, workspaceTabId),
    [layoutState, ownershipKey, tabsSession, workspaceTabId]
  )
  const layoutObservation = layoutSession.observe({
    routeActive,
    surfaceKind,
    ownedRoute:
      ownedWorkspaceTab?.contentRoute ??
      `${stripAppBasePath(window.location.pathname)}${window.location.search}`,
    runtimeWork: state.runtimeWork,
    loadTranscript: onLoadRuntimeTranscriptForPane,
    services,
    blankPaneKey,
    get workItemSurfaceOpen() {
      return workItemSurfaceOpen
    },
    get sidebarCollapsed() {
      return sidebarCollapsed
    },
    activatePane: splitGroups.activatePane,
    get getImSettings() {
      return onGetImNotificationSettings
    },
  })
  const layoutSnapshot = useSyncExternalStore(
    layoutObservation.subscribe,
    layoutState.getSnapshot,
    layoutState.getSnapshot
  )
  const {
    archivedCleanupError,
    currentPath,
    taskView,
    localHarnessSessions,
    activeLocalHarnessSessionId,
    sidebarAutoCollapsed,
    sidebarPreviewOpen,
    sidebarResizing,
    settingsOpen,
    autoOpenAddCloudDeviceDialog,
    blankProjectDialogOpen,
    standaloneWorkspaceDialogMode,
    standaloneRemoteDialogIntent,
    standalonePreferNativeLocalPicker,
    projectWorkEditProject,
    searchOpen,
    imNotificationSettings,
    notice,
    projectCreateRequest,
  } = layoutSnapshot
  const {
    setArchivedCleanupError,
    setCurrentPath,
    setTaskView,
    setLocalHarnessSessions,
    setActiveLocalHarnessSessionId,
    setSidebarAutoCollapsed,
    setSidebarPreviewOpen,
    setSidebarResizing,
    setSettingsOpen,
    setAutoOpenAddCloudDeviceDialog,
    setBlankProjectDialogOpen,
    setStandaloneWorkspaceDialogMode,
    setStandaloneRemoteDialogIntent,
    setStandalonePreferNativeLocalPicker,
    setProjectWorkEditProject,
    setSearchOpen,
    setNotice,
  } = layoutState

  const { activatePane: activateSplitPane } = splitGroups
  const routeWorkItemsOpen =
    surfaceKind === 'board' || (surfaceKind === undefined && currentPath === '/todo')
  const activeProjectSpaceContentRoute =
    ownedWorkspaceTab?.kind === 'board'
      ? ownedWorkspaceTab.contentRoute
      : `${currentPath}${window.location.search}`
  const standInContentRoute =
    ownedWorkspaceTab?.contentRoute ?? `${currentPath}${window.location.search}`
  const standInOpen = !routeWorkItemsOpen && standInContentRoute.split('?')[0] === '/stand-in'
  const [standInRetention, setStandInRetention] = useState({
    open: standInOpen,
    visited: standInOpen,
    contentRoute: standInContentRoute,
    entryKey: 0,
  })
  if (
    standInRetention.open !== standInOpen ||
    (standInOpen && standInRetention.contentRoute !== standInContentRoute)
  ) {
    setStandInRetention({
      open: standInOpen,
      visited: standInRetention.visited || standInOpen,
      contentRoute: standInOpen ? standInContentRoute : standInRetention.contentRoute,
      entryKey: standInRetention.entryKey + (standInOpen ? 1 : 0),
    })
  }
  const taskBoardOpen = !standInOpen && taskView === 'default-work-items'
  const routedDefaultWorkItemsOpen =
    routeWorkItemsOpen && projectSpaceRouteTargetsDefaultWorkItems(activeProjectSpaceContentRoute)
  const workItemSurfaceOpen = routeWorkItemsOpen || taskBoardOpen
  const runtimeTaskLifecycle = useRuntimeTaskLifecycleStoreSnapshot(
    undefined,
    routeActive && workItemSurfaceOpen
  )
  useDOMEvent('window', 'popstate', layoutSession.onLocation)
  useDOMEvent('window', 'resize', layoutSession.onResize)
  useDOMEvent('window', WORKBENCH_NEW_CHAT_FOCUS_EVENT, layoutSession.consumeComposer)
  useDOMEvent(
    'window',
    WEWORK_LOCAL_HARNESS_SESSIONS_CHANGED_EVENT,
    layoutSession.onHarnessSessionsChanged,
    { enabled: !workItemSurfaceOpen && isLocalHarnessAvailable() }
  )
  useDOMEvent(
    'window',
    'keydown',
    (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== 'k' || (!event.metaKey && !event.ctrlKey)) return
      event.preventDefault()
      setSearchOpen(true)
    },
    { enabled: routeActive && !workItemSurfaceOpen }
  )
  const workItemUser = state.user ?? (routedDefaultWorkItemsOpen ? LOCAL_USER : null)
  const workItemServicesReady = routedDefaultWorkItemsOpen
    ? availableProjectSpaceApis.length > 0
    : Boolean(services.deliveryApi)
  const activeItem: 'stand-in' | 'chat' = standInOpen ? 'stand-in' : 'chat'
  const taskReminders = useWorkbenchSidebarReminders()
  const toggleMyWork = useCallback(() => {
    if (standInOpen) {
      navigateTo(defaultProjectSpaceContentRoute())
      return
    }
    setTaskView(currentView =>
      currentView === 'default-work-items' ? 'workbench' : 'default-work-items'
    )
  }, [setTaskView, standInOpen])
  const activateBlankComposer = layoutSession.activateBlankComposer
  const startNewChatOutsideHarness = useCallback(() => {
    activateBlankComposer()
    onNewChat()
  }, [activateBlankComposer, onNewChat])
  const startStandaloneChatOutsideHarness = useCallback(() => {
    activateBlankComposer()
    onStartStandaloneChat()
  }, [activateBlankComposer, onStartStandaloneChat])
  const selectProjectOutsideHarness = useCallback(
    (projectId: number) => {
      activateBlankComposer()
      onSelectProject(projectId)
    },
    [activateBlankComposer, onSelectProject]
  )
  const startNewProjectChatOutsideHarness = useCallback(
    (projectId: number) => {
      activateBlankComposer()
      onStartNewProjectChat(projectId)
    },
    [activateBlankComposer, onStartNewProjectChat]
  )
  const openRuntimeTaskOutsideHarness = useCallback(
    async (address: RuntimeTaskAddress) => {
      setTaskView('workbench')
      setActiveLocalHarnessSessionId(null)
      activateSplitPane(
        getWorkbenchPaneKey({
          currentRuntimeTask: address,
          currentProject: null,
        })
      )
      if (!(currentPath === '/' && isSameRuntimeTask(state.currentRuntimeTask, address))) {
        await onOpenRuntimeTask(address)
      }
      requestWorkbenchComposerFocus(getRuntimeTaskChatScopeKey(address))
    },
    [
      activateSplitPane,
      currentPath,
      onOpenRuntimeTask,
      setActiveLocalHarnessSessionId,
      setTaskView,
      state.currentRuntimeTask,
    ]
  )
  const registerLocalHarnessSession = useCallback(
    (session: LocalHarnessWorkbenchSession, options?: LocalHarnessSessionRegistrationOptions) => {
      setLocalHarnessSessions(current => [
        session,
        ...current.filter(candidate => candidate.sessionId !== session.sessionId),
      ])
      if (options?.activate !== false) {
        setActiveLocalHarnessSessionId(session.sessionId)
      }
    },
    [setActiveLocalHarnessSessionId, setLocalHarnessSessions]
  )
  const openLocalHarnessSession = useCallback(
    (sessionId: string) => {
      setActiveLocalHarnessSessionId(sessionId)
      navigateTo('/')
    },
    [setActiveLocalHarnessSessionId]
  )
  const localHarnessModelApi = services?.localHarnessModelApi
  const removeLocalHarnessSession = useCallback(
    (sessionId: string) => {
      const proxyToken = localHarnessSessions.find(
        session => session.sessionId === sessionId
      )?.proxyToken
      if (proxyToken) {
        void localHarnessModelApi?.unregisterProxy(proxyToken)
      }
      setLocalHarnessSessions(current => current.filter(session => session.sessionId !== sessionId))
      setActiveLocalHarnessSessionId(current => (current === sessionId ? null : current))
    },
    [
      localHarnessSessions,
      setLocalHarnessSessions,
      setActiveLocalHarnessSessionId,
      localHarnessModelApi,
    ]
  )
  const handleLocalHarnessSessionExit = useCallback(
    (sessionId: string) => {
      const proxyToken = localHarnessSessions.find(
        session => session.sessionId === sessionId
      )?.proxyToken
      if (proxyToken) {
        void localHarnessModelApi?.unregisterProxy(proxyToken)
      }
      // DSH retains exited terminal snapshots until the user closes the session.
      setLocalHarnessSessions(current =>
        current.map(session =>
          session.sessionId === sessionId ? { ...session, proxyToken: undefined } : session
        )
      )
    },
    [localHarnessSessions, setLocalHarnessSessions, localHarnessModelApi]
  )
  const closeLocalHarnessSession = useCallback(
    async (sessionId: string) => {
      const session = localHarnessSessions.find(candidate => candidate.sessionId === sessionId)
      if (!session || (session.isPrimary && session.harnessId !== 'opencode')) return
      if (session.harnessId === 'opencode') {
        await archiveLocalHarnessSession(sessionId)
      } else {
        await closeLocalTerminal(sessionId)
      }
      removeLocalHarnessSession(sessionId)
    },
    [localHarnessSessions, removeLocalHarnessSession]
  )
  const createPermanentWorktree = useCreatePermanentWorktree(
    services?.runtimeWorkApi,
    onOpenStandaloneWorkspace,
    layoutSession.captureOwner
  )
  const { sidebarCollapsed, setSidebarCollapsed } = useDesktopSidebarCollapsed()
  const openProjectSpaceRuntimeTask = useCallback(
    async (address: RuntimeTaskAddress) => {
      await openProjectSpaceRuntimeTaskInTab(address, workspaceTabs, openRuntimeTaskOutsideHarness)
    },
    [openRuntimeTaskOutsideHarness, workspaceTabs]
  )
  const effectiveSidebarCollapsed = sidebarCollapsed || sidebarAutoCollapsed
  const openStandaloneFolderProject = useCallback(
    async (
      mode: StandaloneWorkspaceDialogMode,
      intent: StandaloneRemoteDialogIntent = 'project',
      options: ProjectCreateRequestOptions | null = null
    ) => {
      setBlankProjectDialogOpen(false)
      setProjectWorkEditProject(null)
      setStandaloneRemoteDialogIntent(intent)
      layoutState.setProjectCreateRequest(options)

      if (mode === 'existing') {
        // Mount the dialog before opening the native picker so the triggering menu and
        // pointer event are fully dismissed before macOS starts its modal event loop.
        // Desktop automation uses the equivalent in-app picker by default because native OS
        // dialogs cannot be driven through the isolated WebView controller. An explicit E2E
        // override keeps the controller active for real native-picker verification.
        setStandalonePreferNativeLocalPicker(shouldUseNativeProjectDirectoryPicker())
        setStandaloneWorkspaceDialogMode('existing')
        void onRefreshDevices?.().catch(() => undefined)
        return
      }

      setStandalonePreferNativeLocalPicker(true)
      setStandaloneWorkspaceDialogMode(mode)
      void onRefreshDevices?.().catch(() => undefined)
    },
    [
      layoutState,
      onRefreshDevices,
      setBlankProjectDialogOpen,
      setProjectWorkEditProject,
      setStandalonePreferNativeLocalPicker,
      setStandaloneRemoteDialogIntent,
      setStandaloneWorkspaceDialogMode,
    ]
  )
  const closeStandaloneFolderProject = useCallback(() => {
    layoutState.setProjectCreateRequest(null)
    setStandaloneWorkspaceDialogMode(null)
    setStandaloneRemoteDialogIntent('project')
    setStandalonePreferNativeLocalPicker(true)
  }, [
    layoutState,
    setStandalonePreferNativeLocalPicker,
    setStandaloneRemoteDialogIntent,
    setStandaloneWorkspaceDialogMode,
  ])
  const openProjectFromWorkMenu = useCallback(
    (mode: ProjectCreateMode, options?: ProjectCreateRequestOptions) => {
      if (mode === 'scratch') {
        layoutState.setProjectCreateRequest(null)
        setBlankProjectDialogOpen(true)
        setStandaloneWorkspaceDialogMode(null)
        void onRefreshDevices?.().catch(() => undefined)
      } else if (mode === 'existing') {
        void openStandaloneFolderProject('existing', 'project', options ?? null)
      } else if (mode === 'git') {
        void openStandaloneFolderProject('remote', 'project', options ?? null)
      }
      setProjectWorkEditProject(null)
    },
    [
      layoutState,
      onRefreshDevices,
      openStandaloneFolderProject,
      setBlankProjectDialogOpen,
      setProjectWorkEditProject,
      setStandaloneWorkspaceDialogMode,
    ]
  )
  const openProjectWorkspaceBinding = useCallback(
    (projectId: number) => {
      const project = state.projects.find(item => item.id === projectId)
      if (!project) return
      setProjectWorkEditProject(project)
      setBlankProjectDialogOpen(false)
      setStandaloneWorkspaceDialogMode(null)
      void onRefreshDevices?.().catch(() => undefined)
    },
    [
      onRefreshDevices,
      setBlankProjectDialogOpen,
      setProjectWorkEditProject,
      setStandaloneWorkspaceDialogMode,
      state.projects,
    ]
  )
  const openCloudDeviceSettings = useCallback(() => {
    setAutoOpenAddCloudDeviceDialog(true)
    setSettingsOpen(true)
    navigateTo('/settings/connections')
  }, [setAutoOpenAddCloudDeviceDialog, setSettingsOpen])
  const openSettings = useCallback(
    (options: DesktopSidebarAccountSettingsOptions | undefined) => {
      layoutSession.rememberSettingsReturnPath()
      setAutoOpenAddCloudDeviceDialog(Boolean(options?.autoOpenAddCloudDeviceDialog))
      setSettingsOpen(true)
      navigateTo(
        options?.autoOpenAddCloudDeviceDialog
          ? '/settings/connections'
          : options?.settingsPage
            ? `/settings/${options.settingsPage}`
            : '/settings'
      )
    },
    [layoutSession, setAutoOpenAddCloudDeviceDialog, setSettingsOpen]
  )
  const openSidebarPreview = useCallback(() => {
    if (!effectiveSidebarCollapsed) return
    setSidebarPreviewOpen(true)
  }, [effectiveSidebarCollapsed, setSidebarPreviewOpen])
  const closeSidebarPreview = useCallback(() => {
    setSidebarPreviewOpen(false)
  }, [setSidebarPreviewOpen])
  const updateSidebarCollapsed = useCallback(
    (collapsed: boolean) => {
      setSidebarPreviewOpen(false)
      if (!collapsed) {
        setSidebarAutoCollapsed(false)
      }
      setSidebarCollapsed(collapsed)
    },
    [setSidebarAutoCollapsed, setSidebarCollapsed, setSidebarPreviewOpen]
  )
  const collapseSidebar = useCallback(() => {
    updateSidebarCollapsed(true)
  }, [updateSidebarCollapsed])
  const { sidebarWidth, handleResizeStart: handleSidebarResizeStart } = useResizableSidebar({
    onCollapse: collapseSidebar,
    onResizeStateChange: setSidebarResizing,
  })
  useDesktopSidebarToggleRequest(() => {
    updateSidebarCollapsed(!effectiveSidebarCollapsed)
  })
  useWorkbenchShellEventHandlers({
    enabled: routeActive,
    onCreateProjectMode: openProjectFromWorkMenu,
    onBindProjectWorkspace: openProjectWorkspaceBinding,
    onOpenCloudDeviceSettings: openCloudDeviceSettings,
    onOpenTaskSearch: () => setSearchOpen(true),
  })
  const refreshImNotificationSettings = layoutSession.refreshImSettings
  const toggleRuntimeTaskNotification = useCallback(
    async (address: RuntimeTaskAddress, subscribed: boolean) => {
      const scope = layoutSession.captureOwner()
      if (subscribed) {
        if (!onUnsubscribeRuntimeTaskNotifications) return
        try {
          await onUnsubscribeRuntimeTaskNotifications(address)
          if (!scope.isCurrent()) return
          await refreshImNotificationSettings()
        } catch {
          if (!scope.isCurrent()) return
          setNotice({
            message: t('workbench.global_im_notifications_unavailable'),
            tone: 'error',
          })
        }
        return
      }

      try {
        if (!onSubscribeRuntimeTaskNotifications || !onListImPrivateSessions) return
        const { items } = await onListImPrivateSessions()
        if (!scope.isCurrent()) return
        if (!items.length) {
          setNotice({ message: t('workbench.im_connections_required'), tone: 'error' })
          return
        }
        await onSubscribeRuntimeTaskNotifications({
          address,
          sessionKeys: items.map(session => session.session_key),
        })
        if (!scope.isCurrent()) return
        await refreshImNotificationSettings()
      } catch {
        if (!scope.isCurrent()) return
        setNotice({ message: t('workbench.global_im_notifications_unavailable'), tone: 'error' })
      }
    },
    [
      layoutSession,
      onUnsubscribeRuntimeTaskNotifications,
      refreshImNotificationSettings,
      setNotice,
      t,
      onSubscribeRuntimeTaskNotifications,
      onListImPrivateSessions,
    ]
  )
  return {
    routeActive,
    t,
    archivedCleanupError,
    setArchivedCleanupError,
    onLogout,
    runtimeTaskLifecycle,
    state,
    cloudWorkStatus,
    upgradingDevices,
    selectStandaloneDevice,
    onOpenStandaloneWorkspace,
    onOpenRuntimeTask,
    onSearchRuntimeWork,
    onRenameRuntimeTask,
    onArchiveRuntimeTask,
    onArchiveProjectConversations,
    onArchiveProjectsConversations,
    onArchiveChatConversations,
    onCancelRuntimeTask,
    onRefreshDevices,
    onUpgradeDevice,
    onCreateProject,
    onCreateLocalRuntimeProject,
    onCreateGitWorkspaceProject,
    onPrepareDeviceWorkspace,
    onDeleteDeviceWorkspace,
    onListGitRepositories,
    onListGitBranches,
    onUpdateProjectName,
    onUpdateLocalRuntimeProject,
    onRemoveProject,
    onReorderRuntimeProjects,
    onSetRuntimeProjectPinned,
    onSetRuntimeProjectAppearance,
    onReorderRuntimeProjectTasks,
    onSetRuntimeTaskPinned,
    onGetDeviceHomeDirectory,
    onGetProjectWorkspaceRoot,
    onListDeviceDirectories,
    onCreateDeviceDirectory,
    onCloneGitRepository,
    projectChat,
    sendRuntimePaneMessage,
    services,
    refreshWorkLists,
    localTodoProjects,
    availableProjectSpaceApis,
    workspaceTabs,
    ownedWorkspaceTab,
    activePane,
    splitGroups,
    layoutSession,
    localHarnessSessions,
    activeLocalHarnessSessionId,
    sidebarPreviewOpen,
    sidebarResizing,
    settingsOpen,
    autoOpenAddCloudDeviceDialog,
    blankProjectDialogOpen,
    standaloneWorkspaceDialogMode,
    standaloneRemoteDialogIntent,
    standalonePreferNativeLocalPicker,
    projectWorkEditProject,
    searchOpen,
    imNotificationSettings,
    notice,
    projectCreateRequest,
    setCurrentPath,
    setSidebarResizing,
    setSettingsOpen,
    setAutoOpenAddCloudDeviceDialog,
    setBlankProjectDialogOpen,
    setProjectWorkEditProject,
    setSearchOpen,
    setNotice,
    routeWorkItemsOpen,
    standInOpen,
    standInRetention,
    taskBoardOpen,
    routedDefaultWorkItemsOpen,
    workItemUser,
    workItemServicesReady,
    activeItem,
    taskReminders,
    toggleMyWork,
    startNewChatOutsideHarness,
    startStandaloneChatOutsideHarness,
    selectProjectOutsideHarness,
    startNewProjectChatOutsideHarness,
    openRuntimeTaskOutsideHarness,
    registerLocalHarnessSession,
    openLocalHarnessSession,
    handleLocalHarnessSessionExit,
    closeLocalHarnessSession,
    createPermanentWorktree,
    openProjectSpaceRuntimeTask,
    effectiveSidebarCollapsed,
    openStandaloneFolderProject,
    closeStandaloneFolderProject,
    openCloudDeviceSettings,
    openSettings,
    openSidebarPreview,
    closeSidebarPreview,
    updateSidebarCollapsed,
    collapseSidebar,
    sidebarWidth,
    handleSidebarResizeStart,
    toggleRuntimeTaskNotification,
  }
}
