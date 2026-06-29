import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
import { DesktopSidebar } from './DesktopSidebar'
import { ProjectCreateDialog } from '@/components/projects/ProjectCreateDialog'
import {
  StandaloneBlankProjectDialog,
  StandaloneFolderProjectDialog,
  type StandaloneWorkspaceDialogMode,
} from '@/components/projects/StandaloneProjectDialogs'
import { ContinueInImDialog } from '@/components/chat/ContinueInImDialog'
import { TransientNotice } from '@/components/common/TransientNotice'
import { DesktopWorkbenchMain } from './DesktopWorkbenchMain'
import { WorkbenchSearchDialog } from './WorkbenchSearchDialog'
import { useDesktopSidebarCollapsed } from './useDesktopSidebarCollapsed'
import { ConnectionsSettingsPage } from '@/components/settings/ConnectionsSettingsPage'
import { useTranslation } from '@/hooks/useTranslation'
import { useWorkbenchShellEventHandlers } from './workbenchShellEvents'

type ImNotificationDialogMode = { type: 'global' } | { type: 'task'; address: RuntimeTaskAddress }

export function DesktopWorkbenchLayout() {
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
    startNewProjectChat: onStartNewProjectChat,
    openRuntimeLocalTask: onOpenRuntimeLocalTask,
    searchRuntimeWork: onSearchRuntimeWork = async () => ({ items: [] }),
    renameRuntimeLocalTask: onRenameRuntimeLocalTask,
    archiveRuntimeLocalTask: onArchiveRuntimeLocalTask,
    archiveProjectConversations: onArchiveProjectConversations,
    archiveProjectsConversations: onArchiveProjectsConversations,
    archiveChatConversations: onArchiveChatConversations,
    rememberExecutionDevice: onRememberExecutionDevice,
    refreshDevices: onRefreshDevices,
    getRemoteDeviceStartupCommand: onGetRemoteDeviceStartupCommand,
    refreshWorkLists: onRefreshWorkLists,
    upgradeDevice: onUpgradeDevice = async () => {},
    createProject: onCreateProject,
    createGitWorkspaceProject: onCreateGitWorkspaceProject,
    prepareDeviceWorkspace: onPrepareDeviceWorkspace,
    deleteDeviceWorkspace: onDeleteDeviceWorkspace,
    listGitRepositories: onListGitRepositories,
    listGitBranches: onListGitBranches,
    updateProjectName: onUpdateProjectName,
    removeProject: onRemoveProject,
    getDeviceHomeDirectory: onGetDeviceHomeDirectory,
    getProjectWorkspaceRoot: onGetProjectWorkspaceRoot,
    listDeviceDirectories: onListDeviceDirectories,
    createDeviceDirectory: onCreateDeviceDirectory,
    listImPrivateSessions: onListImPrivateSessions,
    getImNotificationSettings: onGetImNotificationSettings,
    updateGlobalImNotification: onUpdateGlobalImNotification,
    subscribeRuntimeTaskNotifications: onSubscribeRuntimeTaskNotifications,
    unsubscribeRuntimeTaskNotifications: onUnsubscribeRuntimeTaskNotifications,
  } = useWorkbench()
  const activeItem = 'chat'
  const { sidebarCollapsed, setSidebarCollapsed } = useDesktopSidebarCollapsed()
  const [settingsOpen, setSettingsOpen] = useState(() =>
    isSettingsRoute(stripAppBasePath(window.location.pathname))
  )
  const [autoOpenAddCloudDeviceDialog, setAutoOpenAddCloudDeviceDialog] = useState(false)
  const [blankProjectDialogOpen, setBlankProjectDialogOpen] = useState(false)
  const [standaloneWorkspaceDialogMode, setStandaloneWorkspaceDialogMode] =
    useState<StandaloneWorkspaceDialogMode | null>(null)
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

  useEffect(() => {
    const handlePopState = () => {
      setSettingsOpen(isSettingsRoute(stripAppBasePath(window.location.pathname)))
    }
    window.addEventListener('popstate', handlePopState)
    return () => window.removeEventListener('popstate', handlePopState)
  }, [])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== 'k') return
      if (!event.metaKey && !event.ctrlKey) return
      event.preventDefault()
      setSearchOpen(true)
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  useEffect(() => {
    if (settingsOpen && autoOpenAddCloudDeviceDialog) {
      setAutoOpenAddCloudDeviceDialog(false)
    }
  }, [autoOpenAddCloudDeviceDialog, settingsOpen])

  const openProjectFromWorkMenu = useCallback(
    (mode: ProjectCreateMode) => {
      setBlankProjectDialogOpen(mode === 'scratch')
      setStandaloneWorkspaceDialogMode(
        mode === 'existing' ? 'existing' : mode === 'git' ? 'remote' : null
      )
      setProjectWorkEditProject(null)
      void onRefreshDevices?.().catch(() => undefined)
    },
    [onRefreshDevices]
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
    navigateTo('/settings')
  }, [])

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
    void refreshImNotificationSettings().catch(() => undefined)
  }, [refreshImNotificationSettings])

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

    const taskKey = `${imNotificationDialogMode.address.deviceId}\0${imNotificationDialogMode.address.localTaskId}`
    const subscription = imNotificationSettings.runtimeTaskSubscriptions.find(
      item => `${item.address.deviceId}\0${item.address.localTaskId}` === taskKey
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

  return (
    <div className="relative flex h-full overflow-hidden bg-transparent text-text-primary">
      {!settingsOpen && (
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
          preferredDeviceId={
            state.standaloneDeviceId ?? state.user?.preferences?.default_execution_target
          }
          activeItem={activeItem}
          collapsed={sidebarCollapsed}
          onNewChat={onNewChat}
          onOpenSearch={() => setSearchOpen(true)}
          onSelectProject={onSelectProject}
          onStartNewProjectChat={onStartNewProjectChat}
          onOpenRuntimeLocalTask={onOpenRuntimeLocalTask}
          onRenameRuntimeLocalTask={onRenameRuntimeLocalTask}
          onArchiveRuntimeLocalTask={onArchiveRuntimeLocalTask}
          onArchiveProjectConversations={onArchiveProjectConversations}
          onArchiveProjectsConversations={onArchiveProjectsConversations}
          onArchiveChatConversations={onArchiveChatConversations}
          onToggleRuntimeTaskNotification={toggleRuntimeTaskNotification}
          onToggleGlobalImNotification={toggleGlobalImNotification}
          onOpenGlobalImNotificationSettings={() =>
            openImNotificationTargetDialog({ type: 'global' })
          }
          onOpenStandaloneWorkspace={onOpenStandaloneWorkspace}
          onSelectStandaloneDevice={selectStandaloneDevice}
          onGetRemoteDeviceStartupCommand={onGetRemoteDeviceStartupCommand}
          onOpenPlugins={() => navigateTo('/plugins')}
          onRefreshDevices={onRefreshDevices}
          onUpdateProjectName={onUpdateProjectName}
          onRemoveProject={onRemoveProject}
          onGetDeviceHomeDirectory={onGetDeviceHomeDirectory}
          onListDeviceDirectories={onListDeviceDirectories}
          onCreateDeviceDirectory={onCreateDeviceDirectory}
          onOpenSettings={options => {
            setAutoOpenAddCloudDeviceDialog(Boolean(options?.autoOpenAddCloudDeviceDialog))
            setSettingsOpen(true)
            navigateTo('/settings')
          }}
          onRefreshWorkLists={onRefreshWorkLists}
          onLogout={onLogout}
        />
      )}
      {settingsOpen ? (
        <ConnectionsSettingsPage
          autoOpenAddCloudDeviceDialog={autoOpenAddCloudDeviceDialog}
          onBack={() => {
            setSettingsOpen(false)
            setAutoOpenAddCloudDeviceDialog(false)
            navigateTo('/')
          }}
        />
      ) : (
        <DesktopWorkbenchMain
          activePane={{
            currentRuntimeTask: state.currentRuntimeTask,
            currentProject: state.currentProject,
          }}
        />
      )}
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
        devices={state.devices}
        preferredDeviceId={
          state.standaloneDeviceId ?? state.user?.preferences?.default_execution_target
        }
        onClose={() => setStandaloneWorkspaceDialogMode(null)}
        onGetDeviceHomeDirectory={onGetDeviceHomeDirectory}
        onListDeviceDirectories={onListDeviceDirectories}
        onCreateDeviceDirectory={onCreateDeviceDirectory}
        onOpenStandaloneWorkspace={onOpenStandaloneWorkspace}
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
        onOpenRuntimeLocalTask={async address => {
          if (!onOpenRuntimeLocalTask) return
          await onOpenRuntimeLocalTask(address)
        }}
      />
    </div>
  )
}
