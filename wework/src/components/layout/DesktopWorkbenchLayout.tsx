import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PointerEventHandler } from 'react'
import type { ProjectCreateMode } from '@/components/chat/ChatInput'
import { useWorkbench } from '@/features/workbench/useWorkbench'
import { useAuth } from '@/features/auth/useAuth'
import type {
  CloneGitRepositoryInput,
  GitCloneProjectOperation,
  IMPrivateSession,
  ProjectWithTasks,
  RuntimeTaskAddress,
  RuntimeIMNotificationSettingsResponse,
} from '@/types/api'
import { stripAppBasePath } from '@/config/runtime'
import { isSettingsRoute, navigateTo } from '@/lib/navigation'
import { shouldUseNativeProjectDirectoryPicker } from '@/e2e/automation'
import { cn } from '@/lib/utils'
import { DesktopSidebar } from './DesktopSidebar'
import type { DesktopSidebarAccountSettingsOptions } from './DesktopSidebarAccount'
import { ProjectCreateDialog } from '@/components/projects/ProjectCreateDialog'
import {
  StandaloneBlankProjectDialog,
  StandaloneFolderProjectDialog,
  type StandaloneRemoteDialogIntent,
  type StandaloneWorkspaceDialogMode,
} from '@/components/projects/StandaloneProjectDialogs'
import { ContinueInImDialog } from '@/components/chat/ContinueInImDialog'
import { TransientNotice } from '@/components/common/TransientNotice'
import { DesktopWorkbenchMain } from './DesktopWorkbenchMain'
import { WorkbenchSearchDialog } from './WorkbenchSearchDialog'
import {
  useDesktopSidebarCollapsed,
  useDesktopSidebarToggleRequest,
} from './useDesktopSidebarCollapsed'
import { ConnectionsSettingsPage } from '@/components/settings/ConnectionsSettingsPage'
import { useTranslation } from '@/hooks/useTranslation'
import { useWorkbenchShellEventHandlers } from './workbenchShellEvents'
import { EMPTY_RUNTIME_TASK_REMINDERS } from '@/features/workbench/runtimeTaskReminders'
import { useRuntimeTaskLifecycleStoreSnapshot } from '@/features/workbench/runtimeTaskLifecycle'
import { CloudTodoWorkspace } from '@/features/todo/CloudTodoWorkspace'
import { resolveLocalTodoProjects } from '@/features/todo/localTodoProjects'
import { projectSpaceApis, projectSpaceRef } from '@/features/todo/projectSpaceSelection'
import {
  defaultProjectSpaceContentRoute,
  projectSpaceContentRoute,
  projectSpaceRefFromRoute,
  projectSpaceRouteParam,
  projectSpaceRouteRequestsDefaultProject,
} from '@/features/todo/projectSpaceRoute'
import { WorkbenchBackground } from '@/features/appearance'
import { useResizableSidebar } from './useResizableSidebar'
import { useOptionalWorkspaceTabs } from '@/features/workspace-tabs/workspaceTabsContextValue'
import { getRuntimeTaskChatScopeKey } from '@/features/workbench/workbenchProviderHelpers'
import { requestWorkbenchComposerFocus } from '@/lib/workbenchComposerFocus'
import {
  archiveLocalHarnessSession,
  closeLocalTerminal,
  isLocalHarnessAvailable,
  listLocalHarnessSessions,
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

type ImNotificationDialogMode = { type: 'global' } | { type: 'task'; address: RuntimeTaskAddress }

const SIDEBAR_AUTO_COLLAPSE_WINDOW_WIDTH = 960

function getPermanentWorktreeError(error: unknown, fallback: string) {
  if (error instanceof Error && error.message.trim()) return error.message
  if (error && typeof error === 'object' && 'message' in error) {
    const message = String(error.message).trim()
    if (message) return message
  }
  return fallback
}

function isSameRuntimeTask(
  current: RuntimeTaskAddress | null | undefined,
  next: RuntimeTaskAddress
): boolean {
  const currentPath = current?.workspacePath?.trim()
  const nextPath = next.workspacePath?.trim()
  return (
    current?.deviceId === next.deviceId &&
    current.taskId === next.taskId &&
    (!currentPath || !nextPath || currentPath === nextPath)
  )
}

interface DesktopWorkbenchLayoutProps {
  routeActive?: boolean
  surfaceKind?: 'task' | 'board'
}

function routePathname(route: string): string {
  const searchIndex = route.indexOf('?')
  return searchIndex >= 0 ? route.slice(0, searchIndex) : route
}

const SETTINGS_RETURN_PATH_KEY = 'wework.settingsReturnPath'

function readSettingsReturnPath(): string | null {
  try {
    return window.sessionStorage.getItem(SETTINGS_RETURN_PATH_KEY)
  } catch {
    return null
  }
}

function writeSettingsReturnPath(path: string): void {
  try {
    window.sessionStorage.setItem(SETTINGS_RETURN_PATH_KEY, path)
  } catch {
    // The in-memory ref remains the fallback when session storage is unavailable.
  }
}

export function DesktopWorkbenchLayout({
  routeActive = true,
  surfaceKind,
}: DesktopWorkbenchLayoutProps) {
  const { t } = useTranslation('common')
  const { logout: onLogout } = useAuth()
  const runtimeTaskLifecycle = useRuntimeTaskLifecycleStoreSnapshot()
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
    searchRuntimeWork: onSearchRuntimeWork = async () => ({ items: [] }),
    renameRuntimeTask: onRenameRuntimeTask,
    archiveRuntimeTask: onArchiveRuntimeTask,
    archiveProjectConversations: onArchiveProjectConversations,
    archiveProjectsConversations: onArchiveProjectsConversations,
    archiveChatConversations: onArchiveChatConversations,
    refreshDevices: onRefreshDevices,
    getRemoteDeviceStartupCommand: onGetRemoteDeviceStartupCommand,
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
    updateGlobalImNotification: onUpdateGlobalImNotification,
    subscribeRuntimeTaskNotifications: onSubscribeRuntimeTaskNotifications,
    unsubscribeRuntimeTaskNotifications: onUnsubscribeRuntimeTaskNotifications,
    runtimeTaskReminders,
    projectChat,
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
  const { activatePane: activateSplitPane } = splitGroups
  const initialPath = stripAppBasePath(window.location.pathname)
  const [currentPath, setCurrentPath] = useState(initialPath)
  const routeWorkItemsOpen =
    surfaceKind === 'board' || (surfaceKind === undefined && currentPath === '/todo')
  const todoOpen = routeWorkItemsOpen
  const [localHarnessSessions, setLocalHarnessSessions] = useState<LocalHarnessWorkbenchSession[]>(
    []
  )
  const [activeLocalHarnessSessionId, setActiveLocalHarnessSessionId] = useState<string | null>(
    null
  )
  const [gitCloneOperations, setGitCloneOperations] = useState<GitCloneProjectOperation[]>([])
  const runGitCloneOperation = useCallback(
    (
      operation: GitCloneProjectOperation,
      options: {
        refreshDevice?: boolean
      } = {}
    ) => {
      const resumeOpening = operation.failureStage === 'open'
      setGitCloneOperations(current =>
        current.map(item =>
          item.id === operation.id
            ? {
                ...item,
                status: resumeOpening ? 'opening' : 'cloning',
                failureStage: undefined,
                failureReason: undefined,
                error: undefined,
              }
            : item
        )
      )
      void (async () => {
        let stage: 'clone' | 'open' = resumeOpening ? 'open' : 'clone'
        try {
          if (options.refreshDevice) {
            await onRefreshDevices?.()
          }
          if (!resumeOpening) {
            await onCloneGitRepository(operation.deviceId, {
              url: operation.url,
              ...(operation.branch ? { branch: operation.branch } : {}),
              targetPath: operation.targetPath,
            })
            stage = 'open'
            setGitCloneOperations(current =>
              current.map(item =>
                item.id === operation.id ? { ...item, status: 'opening' } : item
              )
            )
          }
          await onOpenStandaloneWorkspace(operation.deviceId, operation.targetPath, operation.name)
          setGitCloneOperations(current => current.filter(item => item.id !== operation.id))
        } catch (error) {
          console.error('[Wework project] Git project operation failed', {
            stage,
            deviceId: operation.deviceId,
            targetPath: operation.targetPath,
            error:
              error instanceof Error ? { name: error.name, message: error.message } : String(error),
          })
          setGitCloneOperations(current =>
            current.map(item =>
              item.id === operation.id
                ? {
                    ...item,
                    status: 'failed',
                    failureStage: stage,
                    failureReason:
                      error instanceof Error && error.message.includes('executor-offline:')
                        ? 'executor-offline'
                        : stage === 'clone'
                          ? 'clone-failed'
                          : 'open-failed',
                    error:
                      error instanceof Error
                        ? error.message
                        : stage === 'clone'
                          ? 'Failed to clone repository'
                          : 'Failed to add project',
                  }
                : item
            )
          )
        }
      })()
    },
    [onCloneGitRepository, onOpenStandaloneWorkspace, onRefreshDevices]
  )
  const retryGitCloneOperation = useCallback(
    (operation: GitCloneProjectOperation) => {
      runGitCloneOperation(operation, {
        refreshDevice: operation.failureReason === 'executor-offline',
      })
    },
    [runGitCloneOperation]
  )
  const startGitCloneProject = useCallback(
    (deviceId: string, input: CloneGitRepositoryInput) => {
      const name = input.targetPath.split(/[\\/]/).filter(Boolean).at(-1) || 'repository'
      const operation: GitCloneProjectOperation = {
        ...input,
        id: crypto.randomUUID(),
        deviceId,
        name,
        status: 'cloning',
      }
      setGitCloneOperations(current => [operation, ...current])
      runGitCloneOperation(operation)
    },
    [runGitCloneOperation]
  )
  const dismissGitCloneOperation = useCallback((operationId: string) => {
    setGitCloneOperations(current => current.filter(item => item.id !== operationId))
  }, [])
  const loadLocalHarnessSessions = useCallback(async () => {
    const sessions = await listLocalHarnessSessions()
    return sessions.map(session => ({
      sessionId: session.session_id,
      harnessId: session.harness_id,
      title: session.title,
      cwd: session.cwd,
      createdAt: session.created_at,
      isPrimary: session.is_primary,
      projectId: session.project_id,
      active: session.active,
      modelKey: session.model_key,
      pluginRoots: session.plugin_roots?.length ? session.plugin_roots : undefined,
      proxyToken: session.proxy_token,
    }))
  }, [])

  useEffect(() => {
    if (todoOpen || !isLocalHarnessAvailable()) return

    let cancelled = false
    void loadLocalHarnessSessions()
      .then(restored => {
        if (cancelled) return
        setLocalHarnessSessions(restored)
      })
      .catch(error => {
        console.error('Failed to restore local harness sessions:', error)
      })
    const handleSessionsChanged = (event: Event) => {
      const openSessionId = (event as CustomEvent<{ openSessionId?: string | null }>).detail
        ?.openSessionId
      void loadLocalHarnessSessions()
        .then(restored => {
          setLocalHarnessSessions(restored)
          if (!openSessionId || !restored.some(session => session.sessionId === openSessionId))
            return
          setActiveLocalHarnessSessionId(openSessionId)
          navigateTo('/')
        })
        .catch(error => {
          console.error('Failed to refresh local Harness sessions:', error)
        })
    }
    window.addEventListener(WEWORK_LOCAL_HARNESS_SESSIONS_CHANGED_EVENT, handleSessionsChanged)

    return () => {
      cancelled = true
      window.removeEventListener(WEWORK_LOCAL_HARNESS_SESSIONS_CHANGED_EVENT, handleSessionsChanged)
    }
  }, [loadLocalHarnessSessions, todoOpen])
  const activeItem = 'chat'
  const taskReminders = runtimeTaskReminders ?? EMPTY_RUNTIME_TASK_REMINDERS
  const startNewChatOutsideHarness = useCallback(() => {
    setActiveLocalHarnessSessionId(null)
    activateSplitPane(blankPaneKey)
    onNewChat()
  }, [activateSplitPane, blankPaneKey, onNewChat])
  const startStandaloneChatOutsideHarness = useCallback(() => {
    setActiveLocalHarnessSessionId(null)
    activateSplitPane(blankPaneKey)
    onStartStandaloneChat()
  }, [activateSplitPane, blankPaneKey, onStartStandaloneChat])
  const selectProjectOutsideHarness = useCallback(
    (projectId: number) => {
      setActiveLocalHarnessSessionId(null)
      activateSplitPane(blankPaneKey)
      onSelectProject(projectId)
    },
    [activateSplitPane, blankPaneKey, onSelectProject]
  )
  const startNewProjectChatOutsideHarness = useCallback(
    (projectId: number) => {
      setActiveLocalHarnessSessionId(null)
      activateSplitPane(blankPaneKey)
      onStartNewProjectChat(projectId)
    },
    [activateSplitPane, blankPaneKey, onStartNewProjectChat]
  )
  const openRuntimeTaskOutsideHarness = useCallback(
    async (address: RuntimeTaskAddress) => {
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
    [activateSplitPane, currentPath, onOpenRuntimeTask, state.currentRuntimeTask]
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
    []
  )
  const openLocalHarnessSession = useCallback((sessionId: string) => {
    setActiveLocalHarnessSessionId(sessionId)
    navigateTo('/')
  }, [])
  const removeLocalHarnessSession = useCallback(
    (sessionId: string) => {
      const proxyToken = localHarnessSessions.find(
        session => session.sessionId === sessionId
      )?.proxyToken
      if (proxyToken) {
        void services?.localHarnessModelApi?.unregisterProxy(proxyToken)
      }
      setLocalHarnessSessions(current => current.filter(session => session.sessionId !== sessionId))
      setActiveLocalHarnessSessionId(current => (current === sessionId ? null : current))
    },
    [localHarnessSessions, services?.localHarnessModelApi]
  )
  const markLocalHarnessSessionInactive = useCallback(
    (sessionId: string) => {
      const proxyToken = localHarnessSessions.find(
        session => session.sessionId === sessionId
      )?.proxyToken
      if (proxyToken) {
        void services?.localHarnessModelApi?.unregisterProxy(proxyToken)
      }
      setLocalHarnessSessions(current =>
        current.map(session =>
          session.sessionId === sessionId
            ? { ...session, active: false, proxyToken: undefined }
            : session
        )
      )
    },
    [localHarnessSessions, services?.localHarnessModelApi]
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
  const createPermanentWorktree = useCallback(
    async ({
      deviceId,
      sourcePath,
      name,
    }: {
      deviceId: string
      sourcePath: string
      name: string
    }) => {
      const runtimeWorkApi = services?.runtimeWorkApi
      if (!runtimeWorkApi) {
        throw new Error(t('workbench.create_permanent_worktree_unavailable'))
      }
      const worktreeId = `permanent-${crypto.randomUUID()}`
      let prepared
      try {
        prepared = await runtimeWorkApi.prepareWorktree({
          deviceId,
          sourcePath,
          worktreeId,
          permanent: true,
        })
      } catch (error) {
        throw new Error(
          getPermanentWorktreeError(error, t('workbench.create_permanent_worktree_failed')),
          { cause: error }
        )
      }
      const workspacePath = prepared.path ?? prepared.worktree.path
      try {
        await onOpenStandaloneWorkspace(deviceId, workspacePath, name)
      } catch (error) {
        await runtimeWorkApi
          .deleteWorktree({ deviceId, path: workspacePath, preserveSnapshot: false })
          .catch(() => undefined)
        throw error
      }
    },
    [onOpenStandaloneWorkspace, services?.runtimeWorkApi, t]
  )
  const { sidebarCollapsed, setSidebarCollapsed } = useDesktopSidebarCollapsed()
  const [sidebarAutoCollapsed, setSidebarAutoCollapsed] = useState(false)
  const [sidebarPreviewOpen, setSidebarPreviewOpen] = useState(false)
  const [sidebarResizing, setSidebarResizing] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(() => isSettingsRoute(initialPath))
  const settingsReturnPathRef = useRef(initialPath === '/todo' ? '/todo' : '/')
  const activeTabRouteRef = useRef(
    workspaceTabs?.activeTab?.contentRoute ??
      `${stripAppBasePath(window.location.pathname)}${window.location.search}`
  )
  const [autoOpenAddCloudDeviceDialog, setAutoOpenAddCloudDeviceDialog] = useState(false)
  const [blankProjectDialogOpen, setBlankProjectDialogOpen] = useState(false)
  const [standaloneWorkspaceDialogMode, setStandaloneWorkspaceDialogMode] =
    useState<StandaloneWorkspaceDialogMode | null>(null)
  const [standaloneRemoteDialogIntent, setStandaloneRemoteDialogIntent] =
    useState<StandaloneRemoteDialogIntent>('project')
  const [standalonePreferNativeLocalPicker, setStandalonePreferNativeLocalPicker] = useState(true)
  const [projectWorkEditProject, setProjectWorkEditProject] = useState<ProjectWithTasks | null>(
    null
  )
  const openProjectSpaceRuntimeTask = useCallback(
    async (address: RuntimeTaskAddress) => {
      await openProjectSpaceRuntimeTaskInTab(address, workspaceTabs, openRuntimeTaskOutsideHarness)
    },
    [openRuntimeTaskOutsideHarness, workspaceTabs]
  )
  const [searchOpen, setSearchOpen] = useState(false)
  const [imNotificationDialogMode, setImNotificationDialogMode] =
    useState<ImNotificationDialogMode | null>(null)
  const [imNotificationSettings, setImNotificationSettings] =
    useState<RuntimeIMNotificationSettingsResponse | null>(null)
  const [imSessions, setImSessions] = useState<IMPrivateSession[]>([])
  const [imSessionsLoading, setImSessionsLoading] = useState(false)
  const [imSessionsSubmitting, setImSessionsSubmitting] = useState(false)
  const [notice, setNotice] = useState<{
    message: string
    tone: 'success' | 'error'
  } | null>(null)
  const imSessionsRequestSequence = useRef(0)
  const effectiveSidebarCollapsed = sidebarCollapsed || sidebarAutoCollapsed

  useEffect(() => {
    if (!workspaceTabs?.activeTab) return
    activeTabRouteRef.current = workspaceTabs.activeTab.contentRoute
  }, [workspaceTabs?.activeTab])

  useEffect(() => {
    let previousPath = stripAppBasePath(window.location.pathname)
    const handlePopState = () => {
      const path = stripAppBasePath(window.location.pathname)
      const enteringSettings = isSettingsRoute(path) && !isSettingsRoute(previousPath)
      if (enteringSettings) {
        settingsReturnPathRef.current = activeTabRouteRef.current
        writeSettingsReturnPath(activeTabRouteRef.current)
      }
      previousPath = path
      setCurrentPath(path)
      setSettingsOpen(isSettingsRoute(path))
    }
    window.addEventListener('popstate', handlePopState)
    return () => window.removeEventListener('popstate', handlePopState)
  }, [])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (todoOpen) return
      if (event.key.toLowerCase() !== 'k') return
      if (!event.metaKey && !event.ctrlKey) return
      event.preventDefault()
      setSearchOpen(true)
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [todoOpen])

  useEffect(() => {
    const syncAutoCollapse = () => {
      setSidebarAutoCollapsed(window.innerWidth <= SIDEBAR_AUTO_COLLAPSE_WINDOW_WIDTH)
    }

    syncAutoCollapse()
    window.addEventListener('resize', syncAutoCollapse)
    return () => window.removeEventListener('resize', syncAutoCollapse)
  }, [])

  useEffect(() => {
    if (effectiveSidebarCollapsed || !sidebarPreviewOpen) return
    const timer = window.setTimeout(() => {
      setSidebarPreviewOpen(false)
    }, 0)
    return () => window.clearTimeout(timer)
  }, [effectiveSidebarCollapsed, sidebarPreviewOpen])

  const openStandaloneFolderProject = useCallback(
    async (
      mode: StandaloneWorkspaceDialogMode,
      intent: StandaloneRemoteDialogIntent = 'project'
    ) => {
      setBlankProjectDialogOpen(false)
      setProjectWorkEditProject(null)
      setStandaloneRemoteDialogIntent(intent)

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
    [onRefreshDevices]
  )

  const closeStandaloneFolderProject = useCallback(() => {
    setStandaloneWorkspaceDialogMode(null)
    setStandaloneRemoteDialogIntent('project')
    setStandalonePreferNativeLocalPicker(true)
  }, [])

  const openProjectFromWorkMenu = useCallback(
    (mode: ProjectCreateMode) => {
      if (mode === 'scratch') {
        setBlankProjectDialogOpen(true)
        setStandaloneWorkspaceDialogMode(null)
        void onRefreshDevices?.().catch(() => undefined)
      } else if (mode === 'existing') {
        void openStandaloneFolderProject('existing')
      } else if (mode === 'git') {
        void openStandaloneFolderProject('remote', 'project')
      }
      setProjectWorkEditProject(null)
    },
    [onRefreshDevices, openStandaloneFolderProject]
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
    [onRefreshDevices, state.projects]
  )

  const openCloudDeviceSettings = useCallback(() => {
    setAutoOpenAddCloudDeviceDialog(true)
    setSettingsOpen(true)
    navigateTo('/settings/connections')
  }, [])

  const openSettings = useCallback((options: DesktopSidebarAccountSettingsOptions | undefined) => {
    settingsReturnPathRef.current = activeTabRouteRef.current
    writeSettingsReturnPath(activeTabRouteRef.current)
    setAutoOpenAddCloudDeviceDialog(Boolean(options?.autoOpenAddCloudDeviceDialog))
    setSettingsOpen(true)
    navigateTo(
      options?.autoOpenAddCloudDeviceDialog
        ? '/settings/connections'
        : options?.settingsPage
          ? `/settings/${options.settingsPage}`
          : '/settings'
    )
  }, [])

  const openSidebarPreview = useCallback(() => {
    if (!effectiveSidebarCollapsed) return
    setSidebarPreviewOpen(true)
  }, [effectiveSidebarCollapsed])

  const closeSidebarPreview = useCallback(() => {
    setSidebarPreviewOpen(false)
  }, [])

  const updateSidebarCollapsed = useCallback(
    (collapsed: boolean) => {
      setSidebarPreviewOpen(false)
      if (!collapsed) {
        setSidebarAutoCollapsed(false)
      }
      setSidebarCollapsed(collapsed)
    },
    [setSidebarCollapsed]
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
    onCreateProjectMode: openProjectFromWorkMenu,
    onBindProjectWorkspace: openProjectWorkspaceBinding,
    onOpenCloudDeviceSettings: openCloudDeviceSettings,
  })

  const loadImSessionsForDialog = useCallback(() => {
    const requestId = imSessionsRequestSequence.current + 1
    imSessionsRequestSequence.current = requestId
    setImSessionsLoading(true)
    setImSessions([])
    void (onListImPrivateSessions?.() ?? Promise.resolve({ total: 0, items: [] }))
      .then(response => {
        if (imSessionsRequestSequence.current === requestId) {
          setImSessions(response.items)
        }
      })
      .catch(() => {
        if (imSessionsRequestSequence.current === requestId) {
          setImSessions([])
          setNotice({ message: t('workbench.continue_im_failed'), tone: 'error' })
        }
      })
      .finally(() => {
        if (imSessionsRequestSequence.current === requestId) {
          setImSessionsLoading(false)
        }
      })
  }, [onListImPrivateSessions, t])

  const refreshImNotificationSettings = useCallback(async () => {
    if (!onGetImNotificationSettings) {
      setImNotificationSettings(null)
      return null
    }

    const settings = await onGetImNotificationSettings()
    setImNotificationSettings(settings)
    return settings
  }, [onGetImNotificationSettings])

  useEffect(() => {
    if (todoOpen) return
    void refreshImNotificationSettings().catch(() => undefined)
  }, [refreshImNotificationSettings, todoOpen])

  const openImNotificationTargetDialog = useCallback(
    (mode: ImNotificationDialogMode) => {
      setImNotificationDialogMode(mode)
      loadImSessionsForDialog()
    },
    [loadImSessionsForDialog]
  )

  const closeImNotificationDialog = useCallback(() => {
    imSessionsRequestSequence.current += 1
    setImNotificationDialogMode(null)
    setImSessionsLoading(false)
  }, [])

  const toggleGlobalImNotification = useCallback(async () => {
    if (!onUpdateGlobalImNotification) return

    const currentSettings = imNotificationSettings
    if (currentSettings?.global.enabled) {
      try {
        const settings = await onUpdateGlobalImNotification({
          enabled: false,
          sessionKey: currentSettings.global.sessionKey ?? undefined,
        })
        setImNotificationSettings(settings)
      } catch {
        setNotice({
          message: t('workbench.im_notification_update_failed', 'IM 通知设置失败'),
          tone: 'error',
        })
      }
      return
    }

    if (currentSettings?.global.sessionKey) {
      try {
        const settings = await onUpdateGlobalImNotification({
          enabled: true,
          sessionKey: currentSettings.global.sessionKey,
        })
        setImNotificationSettings(settings)
      } catch {
        setNotice({
          message: t('workbench.im_notification_update_failed', 'IM 通知设置失败'),
          tone: 'error',
        })
      }
      return
    }

    openImNotificationTargetDialog({ type: 'global' })
  }, [imNotificationSettings, onUpdateGlobalImNotification, openImNotificationTargetDialog, t])

  const toggleRuntimeTaskNotification = useCallback(
    async (address: RuntimeTaskAddress, subscribed: boolean) => {
      if (subscribed) {
        if (!onUnsubscribeRuntimeTaskNotifications) return
        try {
          await onUnsubscribeRuntimeTaskNotifications(address)
          await refreshImNotificationSettings()
        } catch {
          setNotice({
            message: t('workbench.im_notification_update_failed', 'IM 通知设置失败'),
            tone: 'error',
          })
        }
        return
      }

      openImNotificationTargetDialog({ type: 'task', address })
    },
    [
      onUnsubscribeRuntimeTaskNotifications,
      openImNotificationTargetDialog,
      refreshImNotificationSettings,
      t,
    ]
  )

  const notificationDefaultSessionKeys = useMemo(() => {
    if (!imNotificationDialogMode || !imNotificationSettings) return []
    if (imNotificationDialogMode.type === 'global') {
      return imNotificationSettings.global.sessionKey
        ? [imNotificationSettings.global.sessionKey]
        : []
    }

    const taskKey = `${imNotificationDialogMode.address.deviceId}\0${imNotificationDialogMode.address.taskId}`
    const subscription = imNotificationSettings.runtimeTaskSubscriptions.find(
      item => `${item.address.deviceId}\0${item.address.taskId}` === taskKey
    )
    if (subscription?.sessionKeys.length) {
      return subscription.sessionKeys
    }
    return imNotificationSettings.global.sessionKey
      ? [imNotificationSettings.global.sessionKey]
      : []
  }, [imNotificationDialogMode, imNotificationSettings])

  const submitImNotificationTarget = useCallback(
    async (sessionKeys: string[]) => {
      if (!imNotificationDialogMode || sessionKeys.length === 0) return

      setImSessionsSubmitting(true)
      try {
        if (imNotificationDialogMode.type === 'global') {
          if (!onUpdateGlobalImNotification) {
            throw new Error('Global IM notification handler is not available')
          }
          const settings = await onUpdateGlobalImNotification({
            enabled: true,
            sessionKey: sessionKeys[0],
          })
          setImNotificationSettings(settings)
        } else {
          if (!onSubscribeRuntimeTaskNotifications) {
            throw new Error('Runtime task IM notification handler is not available')
          }
          await onSubscribeRuntimeTaskNotifications({
            address: imNotificationDialogMode.address,
            sessionKeys,
          })
          await refreshImNotificationSettings()
        }
        setImNotificationDialogMode(null)
        setNotice({
          message: t('workbench.im_notification_update_success', 'IM 通知已更新'),
          tone: 'success',
        })
      } catch {
        setNotice({
          message: t('workbench.im_notification_update_failed', 'IM 通知设置失败'),
          tone: 'error',
        })
      } finally {
        setImSessionsSubmitting(false)
      }
    },
    [
      imNotificationDialogMode,
      onSubscribeRuntimeTaskNotifications,
      onUpdateGlobalImNotification,
      refreshImNotificationSettings,
      t,
    ]
  )

  const renderDesktopSidebar = ({
    collapsed,
    containerTestId,
    hideResizeHandle = false,
    onPointerEnter,
    onPointerLeave,
    onToggleSidebar,
  }: {
    collapsed: boolean
    containerTestId?: string
    hideResizeHandle?: boolean
    onPointerEnter?: PointerEventHandler<HTMLElement>
    onPointerLeave?: PointerEventHandler<HTMLElement>
    onToggleSidebar?: () => void
  }) => (
    <DesktopSidebar
      user={state.user}
      projects={state.projects}
      devices={state.devices}
      cloudWorkStatus={cloudWorkStatus}
      runtimeWork={state.runtimeWork}
      gitCloneOperations={gitCloneOperations}
      currentRuntimeTask={activeLocalHarnessSessionId ? null : state.currentRuntimeTask}
      splitGroupMemberships={splitGroups.memberships}
      standaloneDeviceId={state.standaloneDeviceId}
      standaloneWorkspacePath={state.standaloneWorkspacePath}
      imNotificationSettings={imNotificationSettings}
      unreadRuntimeTaskKeys={taskReminders.unreadTaskKeys}
      preferredDeviceId={
        state.standaloneDeviceId ?? state.user?.preferences?.default_execution_target
      }
      activeItem={activeItem}
      localHarnessSessions={localHarnessSessions}
      activeLocalHarnessSessionId={activeLocalHarnessSessionId}
      collapsed={collapsed}
      containerTestId={containerTestId}
      hideResizeHandle={hideResizeHandle}
      sidebarWidth={sidebarWidth}
      resizing={sidebarResizing}
      onResizeStart={handleSidebarResizeStart}
      onResizeCollapse={collapseSidebar}
      onResizeStateChange={setSidebarResizing}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      onToggleSidebar={onToggleSidebar ?? (() => updateSidebarCollapsed(!collapsed))}
      onNewChat={startNewChatOutsideHarness}
      onStartStandaloneChat={startStandaloneChatOutsideHarness}
      onOpenLocalHarnessSession={openLocalHarnessSession}
      onCloseLocalHarnessSession={closeLocalHarnessSession}
      onOpenSearch={() => setSearchOpen(true)}
      onSelectProject={selectProjectOutsideHarness}
      onStartNewProjectChat={startNewProjectChatOutsideHarness}
      onOpenRuntimeTask={openRuntimeTaskOutsideHarness}
      onMarkRuntimeTaskRead={taskReminders.markRuntimeTaskRead}
      onRenameRuntimeTask={onRenameRuntimeTask}
      onArchiveRuntimeTask={onArchiveRuntimeTask}
      onArchiveProjectConversations={onArchiveProjectConversations}
      onArchiveProjectsConversations={onArchiveProjectsConversations}
      onArchiveChatConversations={onArchiveChatConversations}
      onToggleRuntimeTaskNotification={toggleRuntimeTaskNotification}
      onToggleGlobalImNotification={toggleGlobalImNotification}
      onOpenGlobalImNotificationSettings={() => openImNotificationTargetDialog({ type: 'global' })}
      onOpenStandaloneWorkspace={onOpenStandaloneWorkspace}
      onCreatePermanentWorktree={createPermanentWorktree}
      onSelectStandaloneDevice={selectStandaloneDevice}
      onGetRemoteDeviceStartupCommand={onGetRemoteDeviceStartupCommand}
      onRefreshDevices={onRefreshDevices}
      onOpenStandaloneFolderProject={(mode, intent = 'project') => {
        void openStandaloneFolderProject(mode, intent)
      }}
      onUpdateProjectName={onUpdateProjectName}
      onUpdateLocalRuntimeProject={onUpdateLocalRuntimeProject}
      onRemoveProject={onRemoveProject}
      onReorderRuntimeProjects={onReorderRuntimeProjects}
      onSetRuntimeProjectPinned={onSetRuntimeProjectPinned}
      onSetRuntimeProjectAppearance={onSetRuntimeProjectAppearance}
      onReorderRuntimeProjectTasks={onReorderRuntimeProjectTasks}
      onSetRuntimeTaskPinned={onSetRuntimeTaskPinned}
      onGetDeviceHomeDirectory={onGetDeviceHomeDirectory}
      onListDeviceDirectories={onListDeviceDirectories}
      onCreateDeviceDirectory={onCreateDeviceDirectory}
      onCloneGitRepository={onCloneGitRepository}
      onStartGitCloneProject={startGitCloneProject}
      onRetryGitCloneOperation={retryGitCloneOperation}
      onDismissGitCloneOperation={dismissGitCloneOperation}
      projectSpaceApis={availableProjectSpaceApis}
      models={projectChat.models}
      onOpenSettings={options => openSettings(options)}
      onLogout={onLogout}
    />
  )

  return (
    <div className="relative flex h-full overflow-hidden bg-transparent text-text-primary">
      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        {!routeWorkItemsOpen && <WorkbenchBackground />}
        {routeActive &&
          !settingsOpen &&
          !routeWorkItemsOpen &&
          renderDesktopSidebar({ collapsed: effectiveSidebarCollapsed })}
        {routeActive && !settingsOpen && !routeWorkItemsOpen && effectiveSidebarCollapsed && (
          <>
            <div
              data-testid="desktop-sidebar-hover-edge"
              aria-hidden="true"
              onPointerEnter={openSidebarPreview}
              className="absolute left-0 top-0 z-popover h-full w-4"
            />
            <div
              data-testid="desktop-sidebar-preview"
              aria-hidden={!sidebarPreviewOpen}
              onPointerEnter={openSidebarPreview}
              onPointerLeave={closeSidebarPreview}
              className={cn(
                'absolute left-0 top-0 z-popover h-full overflow-hidden rounded-tl-xl transition-transform duration-[180ms] ease-out motion-reduce:transition-none will-change-transform',
                sidebarPreviewOpen
                  ? 'pointer-events-auto translate-x-0 opacity-100'
                  : 'pointer-events-none -translate-x-full opacity-100'
              )}
            >
              {renderDesktopSidebar({
                collapsed: false,
                containerTestId: 'desktop-sidebar-preview-panel',
                hideResizeHandle: true,
                onPointerEnter: openSidebarPreview,
                onPointerLeave: closeSidebarPreview,
                onToggleSidebar: () => updateSidebarCollapsed(false),
              })}
            </div>
          </>
        )}
        {settingsOpen && (
          <ConnectionsSettingsPage
            autoOpenAddCloudDeviceDialog={autoOpenAddCloudDeviceDialog}
            services={services}
            devices={state.devices}
            onOpenRuntimeTask={onOpenRuntimeTask}
            onRefreshWorkLists={refreshWorkLists}
            onBack={() => {
              const returnPath = readSettingsReturnPath() ?? settingsReturnPathRef.current
              setSettingsOpen(false)
              setAutoOpenAddCloudDeviceDialog(false)
              setCurrentPath(routePathname(returnPath))
              navigateTo(returnPath)
            }}
          />
        )}
        <div style={{ display: settingsOpen ? 'none' : 'contents' }} aria-hidden={settingsOpen}>
          {todoOpen &&
            (state.user && services.deliveryApi ? (
              <CloudTodoWorkspace
                user={state.user}
                localProjects={localTodoProjects}
                runtimeWork={state.runtimeWork}
                runtimeTaskLifecycle={runtimeTaskLifecycle}
                services={services}
                startupActive={routeActive && todoOpen}
                onCreateLocalCodeProject={onCreateLocalRuntimeProject}
                onGetDeviceHomeDirectory={onGetDeviceHomeDirectory}
                onListDeviceDirectories={onListDeviceDirectories}
                onCreateDeviceDirectory={onCreateDeviceDirectory}
                onCloneGitRepository={onCloneGitRepository}
                onOpenRuntimeTask={openProjectSpaceRuntimeTask}
                onArchiveRuntimeTask={onArchiveRuntimeTask}
                onOpenSettings={options => openSettings(options)}
                onLogout={onLogout}
                activeProjectRef={
                  workspaceTabs?.activeTab.kind === 'board'
                    ? projectSpaceRefFromRoute(workspaceTabs.activeTab.contentRoute)
                    : undefined
                }
                defaultProjectRequested={
                  workspaceTabs?.activeTab.kind === 'board' &&
                  projectSpaceRouteRequestsDefaultProject(workspaceTabs.activeTab.contentRoute)
                }
                focusedItemId={
                  workspaceTabs?.activeTab.kind === 'board'
                    ? projectSpaceRouteParam(workspaceTabs.activeTab.contentRoute, 'itemId')
                    : undefined
                }
                onFocusedItemHandled={() => {
                  if (!workspaceTabs || workspaceTabs.activeTab.kind !== 'board') return
                  const projectRef = projectSpaceRefFromRoute(workspaceTabs.activeTab.contentRoute)
                  const defaultProjectRequested = projectSpaceRouteRequestsDefaultProject(
                    workspaceTabs.activeTab.contentRoute
                  )
                  workspaceTabs.updateActiveTab({
                    contentRoute: projectRef
                      ? projectSpaceContentRoute(projectRef)
                      : defaultProjectRequested
                        ? defaultProjectSpaceContentRoute()
                        : '/todo',
                  })
                }}
                onActiveProjectChange={project => {
                  if (!workspaceTabs || workspaceTabs.activeTab.kind !== 'board') return
                  if (!project) {
                    workspaceTabs.updateActiveTab({
                      title: t('workbench.workspace_tab_board', '项目空间'),
                      contentRoute: '/todo',
                    })
                    return
                  }
                  workspaceTabs.updateActiveTab({
                    title: project.name,
                    contentRoute: projectSpaceContentRoute(projectSpaceRef(project)),
                  })
                }}
              />
            ) : (
              <div
                data-testid="cloud-board-loading"
                className="flex h-full flex-1 items-center justify-center text-sm text-text-muted"
              >
                {t('workbench.cloud_board_loading', '正在加载云端看板…')}
              </div>
            ))}
          {!todoOpen ? (
            <DesktopWorkbenchMain
              visible={routeActive && !settingsOpen && !todoOpen}
              sidebarCollapsed={effectiveSidebarCollapsed}
              sidebarResizing={sidebarResizing}
              onSidebarCollapsedChange={updateSidebarCollapsed}
              activePane={activePane}
              splitGroups={splitGroups}
              localHarnessSessions={localHarnessSessions}
              activeLocalHarnessSessionId={activeLocalHarnessSessionId}
              onLocalHarnessSessionStarted={registerLocalHarnessSession}
              onLocalHarnessSessionClose={closeLocalHarnessSession}
              onLocalHarnessSessionExit={markLocalHarnessSessionInactive}
            />
          ) : null}
        </div>
      </div>
      <StandaloneBlankProjectDialog
        open={blankProjectDialogOpen}
        devices={state.devices}
        preferredDeviceId={
          state.standaloneDeviceId ?? state.user?.preferences?.default_execution_target
        }
        onClose={() => setBlankProjectDialogOpen(false)}
        onGetDeviceHomeDirectory={onGetDeviceHomeDirectory}
        onListDeviceDirectories={onListDeviceDirectories}
        onCreateDeviceDirectory={onCreateDeviceDirectory}
        onOpenStandaloneWorkspace={onOpenStandaloneWorkspace}
      />
      <StandaloneFolderProjectDialog
        key={standaloneWorkspaceDialogMode ?? 'standalone-folder-closed'}
        open={standaloneWorkspaceDialogMode !== null}
        mode={standaloneWorkspaceDialogMode ?? 'existing'}
        remoteIntent={standaloneRemoteDialogIntent}
        preferNativeLocalPicker={standalonePreferNativeLocalPicker}
        devices={state.devices}
        preferredDeviceId={
          state.standaloneDeviceId ?? state.user?.preferences?.default_execution_target
        }
        onClose={closeStandaloneFolderProject}
        onGetDeviceHomeDirectory={onGetDeviceHomeDirectory}
        onListDeviceDirectories={onListDeviceDirectories}
        onCreateDeviceDirectory={onCreateDeviceDirectory}
        onCloneGitRepository={onCloneGitRepository}
        onStartGitCloneProject={startGitCloneProject}
        onOpenStandaloneWorkspace={onOpenStandaloneWorkspace}
        onGetRemoteDeviceStartupCommand={onGetRemoteDeviceStartupCommand}
        onRefreshDevices={onRefreshDevices}
      />
      <ProjectCreateDialog
        open={projectWorkEditProject !== null}
        mode="existing"
        project={projectWorkEditProject}
        devices={state.devices}
        onClose={() => {
          setProjectWorkEditProject(null)
        }}
        onOpenCloudDeviceSettings={() => {
          setProjectWorkEditProject(null)
          openCloudDeviceSettings()
        }}
        onCreateProject={onCreateProject}
        onCreateGitWorkspaceProject={onCreateGitWorkspaceProject}
        onPrepareDeviceWorkspace={onPrepareDeviceWorkspace}
        onDeleteDeviceWorkspace={onDeleteDeviceWorkspace}
        preferredDeviceId={
          state.standaloneDeviceId ?? state.user?.preferences?.default_execution_target
        }
        upgradingDevices={upgradingDevices}
        onUpgradeDevice={onUpgradeDevice}
        onGetDeviceHomeDirectory={onGetDeviceHomeDirectory}
        onGetProjectWorkspaceRoot={onGetProjectWorkspaceRoot}
        onListDeviceDirectories={onListDeviceDirectories}
        onCreateDeviceDirectory={onCreateDeviceDirectory}
        onListGitRepositories={onListGitRepositories}
        onListGitBranches={onListGitBranches}
      />
      <ContinueInImDialog
        key={
          imNotificationDialogMode
            ? `im-notification-${imNotificationDialogMode.type}`
            : 'im-notification-closed'
        }
        open={imNotificationDialogMode !== null}
        loading={imSessionsLoading}
        submitting={imSessionsSubmitting}
        sessions={imSessions}
        title={
          imNotificationDialogMode?.type === 'global'
            ? t('workbench.global_im_notifications_title', '全局 IM 通知')
            : t('workbench.runtime_task_im_notifications_title', '订阅任务通知')
        }
        emptyGuide={t(
          'workbench.im_notifications_empty_guide',
          '还没有可用的 IM 会话，请先从 IM 给 Wegent 发送一条消息。'
        )}
        submitLabel={t('workbench.save', '保存')}
        allowMultiple={imNotificationDialogMode?.type !== 'global'}
        defaultSelectedSessionKeys={notificationDefaultSessionKeys}
        onClose={closeImNotificationDialog}
        onSubmit={submitImNotificationTarget}
      />
      <TransientNotice
        message={notice?.message ?? null}
        tone={notice?.tone}
        onClear={() => setNotice(null)}
      />
      <WorkbenchSearchDialog
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
        onSearchRuntimeWork={onSearchRuntimeWork}
        onOpenRuntimeTask={async address => {
          await openRuntimeTaskOutsideHarness(address)
        }}
      />
    </div>
  )
}
