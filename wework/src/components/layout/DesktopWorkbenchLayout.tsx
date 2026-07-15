import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PointerEventHandler } from 'react'
import type { ProjectCreateMode } from '@/components/chat/ChatInput'
import { useWorkbench } from '@/features/workbench/useWorkbench'
import { useAuth } from '@/features/auth/useAuth'
import type {
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
import { TodoWorkspace } from '@/features/todo/TodoWorkspace'

type ImNotificationDialogMode = { type: 'global' } | { type: 'task'; address: RuntimeTaskAddress }

const SIDEBAR_AUTO_COLLAPSE_WINDOW_WIDTH = 960

export function DesktopWorkbenchLayout() {
  const { t } = useTranslation('common')
  const { logout: onLogout } = useAuth()
  const {
    state,
    projectChat,
    cloudWorkStatus,
    upgradingDevices,
    selectProject: onSelectProject,
    selectStandaloneDevice,
    openStandaloneWorkspace: onOpenStandaloneWorkspace,
    startNewChat: onNewChat,
    startNewProjectChat: onStartNewProjectChat,
    createProjectRuntimeTask: onCreateProjectRuntimeTask,
    openRuntimeTask: onOpenRuntimeTask,
    searchRuntimeWork: onSearchRuntimeWork = async () => ({ items: [] }),
    renameRuntimeTask: onRenameRuntimeTask,
    archiveRuntimeTask: onArchiveRuntimeTask,
    archiveProjectConversations: onArchiveProjectConversations,
    archiveProjectsConversations: onArchiveProjectsConversations,
    archiveChatConversations: onArchiveChatConversations,
    rememberExecutionDevice: onRememberExecutionDevice,
    refreshDevices: onRefreshDevices,
    getRemoteDeviceStartupCommand: onGetRemoteDeviceStartupCommand,
    upgradeDevice: onUpgradeDevice = async () => {},
    createProject: onCreateProject,
    createGitWorkspaceProject: onCreateGitWorkspaceProject,
    prepareDeviceWorkspace: onPrepareDeviceWorkspace,
    deleteDeviceWorkspace: onDeleteDeviceWorkspace,
    listGitRepositories: onListGitRepositories,
    listGitBranches: onListGitBranches,
    updateProjectName: onUpdateProjectName,
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
    listImPrivateSessions: onListImPrivateSessions,
    getImNotificationSettings: onGetImNotificationSettings,
    updateGlobalImNotification: onUpdateGlobalImNotification,
    subscribeRuntimeTaskNotifications: onSubscribeRuntimeTaskNotifications,
    unsubscribeRuntimeTaskNotifications: onUnsubscribeRuntimeTaskNotifications,
    runtimeTaskReminders,
    services,
    refreshWorkLists,
  } = useWorkbench()
  const initialPath = stripAppBasePath(window.location.pathname)
  const [currentPath, setCurrentPath] = useState(initialPath)
  const todoOpen = currentPath === '/todo'
  const activeItem = todoOpen ? 'todo' : 'chat'
  const taskReminders = runtimeTaskReminders ?? EMPTY_RUNTIME_TASK_REMINDERS
  const { sidebarCollapsed, setSidebarCollapsed } = useDesktopSidebarCollapsed()
  const [sidebarAutoCollapsed, setSidebarAutoCollapsed] = useState(false)
  const [sidebarPreviewOpen, setSidebarPreviewOpen] = useState(false)
  const [sidebarResizing, setSidebarResizing] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(() => isSettingsRoute(initialPath))
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
    const handlePopState = () => {
      const path = stripAppBasePath(window.location.pathname)
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

  /* eslint-disable react-hooks/set-state-in-effect -- Initial IM notification settings are hydrated from the connected workbench service. */
  useEffect(() => {
    void refreshImNotificationSettings().catch(() => undefined)
  }, [refreshImNotificationSettings])
  /* eslint-enable react-hooks/set-state-in-effect */

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
  }: {
    collapsed: boolean
    containerTestId?: string
    hideResizeHandle?: boolean
    onPointerEnter?: PointerEventHandler<HTMLElement>
    onPointerLeave?: PointerEventHandler<HTMLElement>
  }) => (
    <DesktopSidebar
      user={state.user}
      projects={state.projects}
      devices={state.devices}
      cloudWorkStatus={cloudWorkStatus}
      runtimeWork={state.runtimeWork}
      currentRuntimeTask={state.currentRuntimeTask}
      standaloneDeviceId={state.standaloneDeviceId}
      standaloneWorkspacePath={state.standaloneWorkspacePath}
      imNotificationSettings={imNotificationSettings}
      unreadRuntimeTaskKeys={taskReminders.unreadTaskKeys}
      preferredDeviceId={
        state.standaloneDeviceId ?? state.user?.preferences?.default_execution_target
      }
      activeItem={activeItem}
      collapsed={collapsed}
      containerTestId={containerTestId}
      hideResizeHandle={hideResizeHandle}
      onResizeCollapse={collapseSidebar}
      onResizeStateChange={setSidebarResizing}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      onToggleSidebar={() => updateSidebarCollapsed(!collapsed)}
      onOpenWorkbench={() => navigateTo('/')}
      onOpenTodo={() => navigateTo('/todo')}
      onOpenApps={() => navigateTo('/apps')}
      onNewChat={onNewChat}
      onOpenSearch={() => setSearchOpen(true)}
      onSelectProject={onSelectProject}
      onStartNewProjectChat={onStartNewProjectChat}
      onOpenRuntimeTask={onOpenRuntimeTask}
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
      onSelectStandaloneDevice={selectStandaloneDevice}
      onGetRemoteDeviceStartupCommand={onGetRemoteDeviceStartupCommand}
      onOpenPlugins={() => navigateTo('/plugins')}
      onRefreshDevices={onRefreshDevices}
      onOpenBlankStandaloneProject={() => {
        setBlankProjectDialogOpen(true)
        setStandaloneWorkspaceDialogMode(null)
      }}
      onOpenStandaloneFolderProject={(mode, intent = 'project') => {
        void openStandaloneFolderProject(mode, intent)
      }}
      onUpdateProjectName={onUpdateProjectName}
      onRemoveProject={onRemoveProject}
      onReorderRuntimeProjects={onReorderRuntimeProjects}
      onSetRuntimeProjectPinned={onSetRuntimeProjectPinned}
      onSetRuntimeProjectAppearance={onSetRuntimeProjectAppearance}
      onReorderRuntimeProjectTasks={onReorderRuntimeProjectTasks}
      onSetRuntimeTaskPinned={onSetRuntimeTaskPinned}
      onGetDeviceHomeDirectory={onGetDeviceHomeDirectory}
      onListDeviceDirectories={onListDeviceDirectories}
      onCreateDeviceDirectory={onCreateDeviceDirectory}
      onOpenSettings={options => {
        setAutoOpenAddCloudDeviceDialog(Boolean(options?.autoOpenAddCloudDeviceDialog))
        setSettingsOpen(true)
        navigateTo(
          options?.autoOpenAddCloudDeviceDialog || options?.settingsPage === 'connections'
            ? '/settings/connections'
            : '/settings'
        )
      }}
      onLogout={onLogout}
    />
  )

  return (
    <div className="relative flex h-full overflow-hidden bg-transparent text-text-primary">
      {!settingsOpen && !todoOpen && renderDesktopSidebar({ collapsed: effectiveSidebarCollapsed })}
      {!settingsOpen && !todoOpen && effectiveSidebarCollapsed && (
        <>
          <div
            data-testid="desktop-sidebar-hover-edge"
            aria-hidden="true"
            onPointerEnter={openSidebarPreview}
            className="absolute left-0 top-0 z-popover h-full w-4 after:absolute after:left-0 after:top-0 after:h-full after:w-px after:bg-border/70 after:transition-colors after:duration-150 hover:after:bg-primary/50"
          />
          <div
            data-testid="desktop-sidebar-preview"
            aria-hidden={!sidebarPreviewOpen}
            onPointerEnter={openSidebarPreview}
            onPointerLeave={closeSidebarPreview}
            className={cn(
              'absolute left-0 top-0 z-popover h-full bg-background transition-transform duration-[180ms] ease-out motion-reduce:transition-none will-change-transform',
              sidebarPreviewOpen
                ? 'pointer-events-auto translate-x-0 opacity-100 shadow-[6px_0_24px_rgba(15,23,42,0.10)]'
                : 'pointer-events-none -translate-x-full opacity-100'
            )}
          >
            {renderDesktopSidebar({
              collapsed: false,
              containerTestId: 'desktop-sidebar-preview-panel',
              hideResizeHandle: true,
              onPointerEnter: openSidebarPreview,
              onPointerLeave: closeSidebarPreview,
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
            setSettingsOpen(false)
            setAutoOpenAddCloudDeviceDialog(false)
            navigateTo('/')
          }}
        />
      )}
      <div style={{ display: settingsOpen ? 'none' : 'contents' }} aria-hidden={settingsOpen}>
        {todoOpen && (
          <TodoWorkspace
            user={state.user}
            projects={state.projects}
            runtimeWork={state.runtimeWork}
            currentProjectId={state.currentProject?.id}
            services={services}
            modelName={projectChat.selectedModel?.displayName ?? projectChat.selectedModel?.name}
            onRunTodo={({ project, message, goal, attachments }) =>
              onCreateProjectRuntimeTask(message, {
                project,
                attachments,
                initialGoal: goal ? { objective: goal } : null,
              })
            }
            onOpenRuntimeTask={async address => {
              navigateTo('/')
              await onOpenRuntimeTask?.(address)
            }}
          />
        )}
        <div style={{ display: todoOpen ? 'none' : 'contents' }} aria-hidden={todoOpen}>
          <DesktopWorkbenchMain
            visible={!settingsOpen && !todoOpen}
            sidebarCollapsed={effectiveSidebarCollapsed}
            sidebarResizing={sidebarResizing}
            onSidebarCollapsedChange={updateSidebarCollapsed}
            activePane={{
              currentRuntimeTask: state.currentRuntimeTask,
              currentProject: state.currentProject,
              standaloneChatKey: state.standaloneChatKey,
            }}
          />
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
        onSelectDevicePreference={onRememberExecutionDevice}
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
          if (!onOpenRuntimeTask) return
          await onOpenRuntimeTask(address)
        }}
      />
    </div>
  )
}
