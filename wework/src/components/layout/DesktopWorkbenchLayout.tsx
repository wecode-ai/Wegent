import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  GuidanceWorkbenchMessage,
  QueuedWorkbenchMessage,
  WorkbenchMessage,
  WorkbenchState,
} from '@/types/workbench'
import type {
  ProjectChatControls,
  ProjectCreateMode,
  ProjectWorkControls,
} from '@/components/chat/ChatInput'
import type {
  BindRuntimeTaskIMSessionsResponse,
  CreateGitWorkspaceProjectRequest,
  CreateProjectRequest,
  DeviceWorkspacePrepareRequest,
  DeviceWorkspacePrepareResponse,
  GitBranch,
  GitRepoInfo,
  IMPrivateSession,
  IMPrivateSessionListResponse,
  ProjectWithTasks,
  RuntimeTaskAddress,
  RuntimeTaskForkTarget,
  RuntimeGlobalIMNotificationUpdateRequest,
  RuntimeIMNotificationSettingsResponse,
  RuntimeTaskIMNotificationSubscriptionRequest,
  RuntimeTaskIMNotificationSubscriptionResponse,
  TurnFileChangesSummary,
} from '@/types/api'
import type { EnvironmentInfo } from '@/types/environment'
import type { DeviceUpgradeState } from '@/types/device-events'
import type { CodeCommentContext, WorkspaceTarget } from '@/types/workspace-files'
import { stripAppBasePath } from '@/config/runtime'
import { isSettingsRoute, navigateTo } from '@/lib/navigation'
import {
  resolveRuntimeWorkspaceContext,
  resolveWorkspaceTarget,
  workspaceTargetKey,
} from '@/lib/workspace-target'
import { findProjectForTask } from '@/lib/workbench-device'
import { DesktopSidebar } from './DesktopSidebar'
import { ProjectCreateDialog } from '@/components/projects/ProjectCreateDialog'
import { ContinueInImDialog } from '@/components/chat/ContinueInImDialog'
import { TransientNotice } from '@/components/common/TransientNotice'
import { DesktopWorkbenchMain } from './DesktopWorkbenchMain'
import { DesktopWindowControls } from './DesktopWindowControls'
import { useDesktopSidebarCollapsed } from './useDesktopSidebarCollapsed'
import { ConnectionsSettingsPage } from '@/components/settings/ConnectionsSettingsPage'
import { useTranslation } from '@/hooks/useTranslation'

interface DesktopWorkbenchLayoutProps {
  state: WorkbenchState
  messages: WorkbenchMessage[]
  queuedMessages?: QueuedWorkbenchMessage[]
  guidanceMessages?: GuidanceWorkbenchMessage[]
  codeCommentContexts?: CodeCommentContext[]
  upgradingDevices?: Record<string, DeviceUpgradeState>
  activeItem?: 'chat' | 'plugins' | 'automation'
  onNewChat: () => void
  onStartStandaloneChat: () => void
  onOpenPlugins: () => void
  projectChat: ProjectChatControls
  projectWork: ProjectWorkControls
  onSelectProject: (projectId: number | null) => void
  onStartNewProjectChat: (projectId: number) => void
  onOpenRuntimeLocalTask?: (address: RuntimeTaskAddress) => Promise<void>
  onArchiveRuntimeLocalTask?: (address: RuntimeTaskAddress) => Promise<void>
  onForkCurrentRuntimeTask?: (target: RuntimeTaskForkTarget) => Promise<void>
  onRememberExecutionDevice?: (deviceId: string) => void
  onRefreshDevices?: () => Promise<void>
  onUpgradeDevice?: (deviceId: string) => Promise<void>
  onListImPrivateSessions?: () => Promise<IMPrivateSessionListResponse>
  onBindRuntimeTaskToImSessions?: (
    address: RuntimeTaskAddress,
    sessionKeys: string[]
  ) => Promise<BindRuntimeTaskIMSessionsResponse>
  onGetImNotificationSettings?: () => Promise<RuntimeIMNotificationSettingsResponse>
  onUpdateGlobalImNotification?: (
    data: RuntimeGlobalIMNotificationUpdateRequest
  ) => Promise<RuntimeIMNotificationSettingsResponse>
  onSubscribeRuntimeTaskNotifications?: (
    data: RuntimeTaskIMNotificationSubscriptionRequest
  ) => Promise<RuntimeTaskIMNotificationSubscriptionResponse>
  onUnsubscribeRuntimeTaskNotifications?: (
    address: RuntimeTaskAddress
  ) => Promise<RuntimeTaskIMNotificationSubscriptionResponse>
  onCreateProject: (data: CreateProjectRequest) => Promise<ProjectWithTasks>
  onCreateGitWorkspaceProject: (data: CreateGitWorkspaceProjectRequest) => Promise<ProjectWithTasks>
  onPrepareDeviceWorkspace: (
    data: DeviceWorkspacePrepareRequest
  ) => Promise<DeviceWorkspacePrepareResponse>
  onListGitRepositories: () => Promise<GitRepoInfo[]>
  onListGitBranches: (repo: GitRepoInfo) => Promise<GitBranch[]>
  onUpdateProjectName: (projectId: number, name: string) => Promise<void>
  onRemoveProject: (projectId: number) => Promise<void>
  onGetDeviceHomeDirectory: (deviceId: string) => Promise<string>
  onGetProjectWorkspaceRoot: (deviceId: string) => Promise<string>
  onListDeviceDirectories: (deviceId: string, path: string) => Promise<string[]>
  onCreateDeviceDirectory: (deviceId: string, path: string) => Promise<void>
  onLoadEnvironmentInfo: (
    project: ProjectWithTasks | null,
    workspaceTarget?: WorkspaceTarget | null
  ) => Promise<EnvironmentInfo>
  onCommitEnvironmentChanges: (
    project: ProjectWithTasks | null,
    message: string,
    workspaceTarget?: WorkspaceTarget | null
  ) => Promise<void>
  onLoadEnvironmentDiff?: (
    project: ProjectWithTasks | null,
    workspaceTarget: WorkspaceTarget
  ) => Promise<string>
  onListEnvironmentBranches: (
    project: ProjectWithTasks | null,
    workspaceTarget?: WorkspaceTarget | null
  ) => Promise<string[]>
  onCheckoutEnvironmentBranch: (
    project: ProjectWithTasks | null,
    branchName: string,
    workspaceTarget?: WorkspaceTarget | null
  ) => Promise<void>
  onCreateEnvironmentBranch: (
    project: ProjectWithTasks | null,
    branchName: string,
    workspaceTarget?: WorkspaceTarget | null
  ) => Promise<void>
  onInputChange: (value: string) => void
  onSend: () => void
  onRetryFailedMessage?: (messageId: string) => void
  isResponseStreaming?: boolean
  onPauseResponse?: () => void
  onCancelQueuedMessage?: (id: string) => void
  onSendQueuedAsGuidance?: (id: string) => void
  onEditQueuedMessage?: (id: string) => void
  onCancelGuidanceMessage?: (id: string) => void
  onLoadFileChangesDiff?: (subtaskId: number) => Promise<string>
  onRevertFileChanges?: (subtaskId: number) => Promise<TurnFileChangesSummary>
  onAddCodeComment?: (context: CodeCommentContext) => void
  onClearCodeComments?: () => void
  onRefreshWorkLists?: () => Promise<void>
  onLogout: () => void
}

type ImNotificationDialogMode = { type: 'global' } | { type: 'task'; address: RuntimeTaskAddress }

export function DesktopWorkbenchLayout({
  state,
  messages,
  queuedMessages = [],
  guidanceMessages = [],
  codeCommentContexts = [],
  upgradingDevices = {},
  activeItem = 'chat',
  onNewChat,
  onOpenPlugins,
  projectChat,
  projectWork,
  onSelectProject,
  onStartNewProjectChat,
  onOpenRuntimeLocalTask,
  onArchiveRuntimeLocalTask,
  onForkCurrentRuntimeTask,
  onRememberExecutionDevice,
  onRefreshDevices,
  onUpgradeDevice = async () => {},
  onListImPrivateSessions,
  onBindRuntimeTaskToImSessions,
  onGetImNotificationSettings,
  onUpdateGlobalImNotification,
  onSubscribeRuntimeTaskNotifications,
  onUnsubscribeRuntimeTaskNotifications,
  onCreateProject,
  onCreateGitWorkspaceProject,
  onPrepareDeviceWorkspace,
  onListGitRepositories,
  onListGitBranches,
  onUpdateProjectName,
  onRemoveProject,
  onGetDeviceHomeDirectory,
  onGetProjectWorkspaceRoot,
  onListDeviceDirectories,
  onCreateDeviceDirectory,
  onLoadEnvironmentInfo,
  onCommitEnvironmentChanges,
  onLoadEnvironmentDiff,
  onListEnvironmentBranches,
  onCheckoutEnvironmentBranch,
  onCreateEnvironmentBranch,
  onInputChange,
  onSend,
  onRetryFailedMessage,
  isResponseStreaming = false,
  onPauseResponse = () => {},
  onCancelQueuedMessage = () => {},
  onSendQueuedAsGuidance = () => {},
  onEditQueuedMessage = () => {},
  onCancelGuidanceMessage = () => {},
  onLoadFileChangesDiff,
  onRevertFileChanges,
  onAddCodeComment = () => {},
  onClearCodeComments,
  onRefreshWorkLists,
  onLogout,
}: DesktopWorkbenchLayoutProps) {
  const { t } = useTranslation('common')
  const { sidebarCollapsed, setSidebarCollapsed } = useDesktopSidebarCollapsed()
  const [settingsOpen, setSettingsOpen] = useState(() =>
    isSettingsRoute(stripAppBasePath(window.location.pathname))
  )
  const [autoOpenAddCloudDeviceDialog, setAutoOpenAddCloudDeviceDialog] = useState(false)
  const [projectWorkCreateMode, setProjectWorkCreateMode] = useState<ProjectCreateMode | null>(null)
  const [environmentInfo, setEnvironmentInfo] = useState<EnvironmentInfo>({
    additions: '+0',
    deletions: '-0',
    executionTarget: 'local',
  })
  const [workspaceTarget, setWorkspaceTarget] = useState<WorkspaceTarget | null>(null)
  const [workspaceTargetError, setWorkspaceTargetError] = useState<string | null>(null)
  const [workspaceTargetResolving, setWorkspaceTargetResolving] = useState(false)
  const [continueInImOpen, setContinueInImOpen] = useState(false)
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
  const currentTaskProject = useMemo(
    () => findProjectForTask(state.projects, state.currentTask),
    [state.currentTask, state.projects]
  )
  const runtimeWorkspaceContext = useMemo(
    () =>
      resolveRuntimeWorkspaceContext({
        currentRuntimeTask: state.currentRuntimeTask,
        projects: state.projects,
        runtimeWork: state.runtimeWork,
      }),
    [state.currentRuntimeTask, state.projects, state.runtimeWork]
  )
  const activeConversationProject =
    state.currentProject ?? currentTaskProject ?? runtimeWorkspaceContext?.project ?? null
  const environmentProject = useMemo(() => {
    if (state.currentRuntimeTask) {
      return runtimeWorkspaceContext?.project ?? null
    }
    return (
      activeConversationProject ??
      state.projects.find(project => project.config?.mode === 'workspace') ??
      null
    )
  }, [
    activeConversationProject,
    runtimeWorkspaceContext?.project,
    state.currentRuntimeTask,
    state.projects,
  ])
  const currentTaskWorkspaceKey = state.currentTask
    ? [
        state.currentTask.id,
        state.currentTask.device_id ?? '',
        state.currentTask.execution_workspace_path ?? '',
      ].join(':')
    : ''
  const workspaceTargetResolverApi = useMemo(
    () => ({ getProjectWorkspaceRoot: onGetProjectWorkspaceRoot }),
    [onGetProjectWorkspaceRoot]
  )
  const hasEnvironmentProject = Boolean(environmentProject)
  const environmentWorkspaceReady = !hasEnvironmentProject || Boolean(workspaceTarget)
  const workspaceTargetProject = environmentProject
  const runtimeWorkspaceTarget = runtimeWorkspaceContext?.workspaceTarget ?? null
  const runtimeWorkspaceTargetKey = workspaceTargetKey(runtimeWorkspaceTarget)

  useEffect(() => {
    let cancelled = false

    if (state.currentRuntimeTask) {
      setWorkspaceTarget(current =>
        workspaceTargetKey(current) === runtimeWorkspaceTargetKey ? current : runtimeWorkspaceTarget
      )
      setWorkspaceTargetError(runtimeWorkspaceTarget ? null : 'Workspace is not ready')
      setWorkspaceTargetResolving(false)
      return () => {
        cancelled = true
      }
    }

    setWorkspaceTargetResolving(true)
    setWorkspaceTarget(null)
    setWorkspaceTargetError(null)
    resolveWorkspaceTarget({
      currentTask: state.currentTask,
      currentProject: workspaceTargetProject,
      api: workspaceTargetResolverApi,
    })
      .then(target => {
        if (!cancelled) {
          setWorkspaceTarget(current =>
            workspaceTargetKey(current) === workspaceTargetKey(target) ? current : target
          )
          setWorkspaceTargetError(null)
          setWorkspaceTargetResolving(false)
        }
      })
      .catch(error => {
        if (!cancelled) {
          setWorkspaceTarget(null)
          setWorkspaceTargetError(
            error instanceof Error ? error.message : 'Failed to resolve workspace'
          )
          setWorkspaceTargetResolving(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [
    currentTaskWorkspaceKey,
    runtimeWorkspaceTarget,
    runtimeWorkspaceTargetKey,
    state.currentTask,
    state.currentRuntimeTask,
    workspaceTargetProject,
    workspaceTargetResolverApi,
  ])

  const refreshEnvironmentInfo = useCallback(async () => {
    if (workspaceTargetResolving) {
      setEnvironmentInfo(info => ({ ...info, loading: true }))
      return
    }

    if (!environmentWorkspaceReady) {
      setEnvironmentInfo(info => ({
        ...info,
        loading: false,
        error: workspaceTargetError ?? 'Workspace is not ready',
      }))
      return
    }

    setEnvironmentInfo(info => ({ ...info, loading: true }))
    try {
      const info = await onLoadEnvironmentInfo(environmentProject, workspaceTarget)
      setEnvironmentInfo({ ...info, loading: false })
    } catch (error) {
      setEnvironmentInfo(info => ({
        ...info,
        loading: false,
        error: error instanceof Error ? error.message : 'Failed to load environment info',
      }))
    }
  }, [
    environmentProject,
    environmentWorkspaceReady,
    onLoadEnvironmentInfo,
    workspaceTarget,
    workspaceTargetError,
    workspaceTargetResolving,
  ])

  useEffect(() => {
    const handlePopState = () => {
      setSettingsOpen(isSettingsRoute(stripAppBasePath(window.location.pathname)))
    }
    window.addEventListener('popstate', handlePopState)
    return () => window.removeEventListener('popstate', handlePopState)
  }, [])

  useEffect(() => {
    if (settingsOpen && autoOpenAddCloudDeviceDialog) {
      setAutoOpenAddCloudDeviceDialog(false)
    }
  }, [autoOpenAddCloudDeviceDialog, settingsOpen])

  async function handleCommitEnvironmentChanges(message: string) {
    if (!workspaceTarget) {
      throw new Error(workspaceTargetError ?? 'Workspace is not ready')
    }
    await onCommitEnvironmentChanges(environmentProject, message, workspaceTarget)
    setEnvironmentInfo(info => ({ ...info, additions: '', deletions: '' }))
  }

  async function handleCheckoutEnvironmentBranch(branchName: string) {
    if (!workspaceTarget) {
      throw new Error(workspaceTargetError ?? 'Workspace is not ready')
    }
    await onCheckoutEnvironmentBranch(environmentProject, branchName, workspaceTarget)
    setEnvironmentInfo(info => ({ ...info, branchName }))
  }

  async function handleCreateEnvironmentBranch(branchName: string) {
    if (!workspaceTarget) {
      throw new Error(workspaceTargetError ?? 'Workspace is not ready')
    }
    await onCreateEnvironmentBranch(environmentProject, branchName, workspaceTarget)
    setEnvironmentInfo(info => ({ ...info, branchName }))
  }

  const openProjectFromWorkMenu = useCallback(
    (mode: ProjectCreateMode) => {
      setProjectWorkCreateMode(mode)
      void onRefreshDevices?.().catch(() => undefined)
    },
    [onRefreshDevices]
  )

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

  const openContinueInImDialog = useCallback(() => {
    if (!state.currentRuntimeTask) return

    setImNotificationDialogMode(null)
    setContinueInImOpen(true)
    loadImSessionsForDialog()
  }, [loadImSessionsForDialog, state.currentRuntimeTask])

  const openImNotificationTargetDialog = useCallback(
    (mode: ImNotificationDialogMode) => {
      setContinueInImOpen(false)
      setImNotificationDialogMode(mode)
      loadImSessionsForDialog()
    },
    [loadImSessionsForDialog]
  )

  const closeContinueInImDialog = useCallback(() => {
    imSessionsRequestSequence.current += 1
    setContinueInImOpen(false)
    setImSessionsLoading(false)
  }, [])

  const closeImNotificationDialog = useCallback(() => {
    imSessionsRequestSequence.current += 1
    setImNotificationDialogMode(null)
    setImSessionsLoading(false)
  }, [])

  const submitContinueInIm = useCallback(
    async (sessionKeys: string[]) => {
      if (!state.currentRuntimeTask) return

      setImSessionsSubmitting(true)
      try {
        if (!onBindRuntimeTaskToImSessions) {
          throw new Error('IM bind handler is not available')
        }
        await onBindRuntimeTaskToImSessions(state.currentRuntimeTask, sessionKeys)
        setContinueInImOpen(false)
        setNotice({ message: t('workbench.continue_im_success'), tone: 'success' })
      } catch {
        setNotice({ message: t('workbench.continue_im_failed'), tone: 'error' })
      } finally {
        setImSessionsSubmitting(false)
      }
    },
    [onBindRuntimeTaskToImSessions, state.currentRuntimeTask, t]
  )

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

  const projectWorkWithCreation: ProjectWorkControls = {
    ...projectWork,
    onCreateProjectMode: openProjectFromWorkMenu,
    branchName: environmentInfo.branchName,
    branchLoading: environmentInfo.loading,
    onRefreshBranch: undefined,
    onListBranches: workspaceTarget
      ? () => onListEnvironmentBranches(environmentProject, workspaceTarget)
      : undefined,
    onCheckoutBranch: handleCheckoutEnvironmentBranch,
    onCreateBranch: handleCreateEnvironmentBranch,
  }

  return (
    <div className="relative flex h-full overflow-hidden bg-transparent text-text-primary">
      {!settingsOpen && !sidebarCollapsed && (
        <DesktopSidebar
          user={state.user}
          projects={state.projects}
          devices={state.devices}
          runtimeWork={state.runtimeWork}
          currentRuntimeTask={state.currentRuntimeTask}
          imNotificationSettings={imNotificationSettings}
          preferredDeviceId={
            state.standaloneDeviceId ?? state.user?.preferences?.default_execution_target
          }
          upgradingDevices={upgradingDevices}
          activeItem={activeItem}
          onCollapse={() => setSidebarCollapsed(true)}
          onNewChat={onNewChat}
          onSelectProject={onSelectProject}
          onStartNewProjectChat={onStartNewProjectChat}
          onOpenRuntimeLocalTask={onOpenRuntimeLocalTask}
          onArchiveRuntimeLocalTask={onArchiveRuntimeLocalTask}
          onToggleRuntimeTaskNotification={toggleRuntimeTaskNotification}
          onToggleGlobalImNotification={toggleGlobalImNotification}
          onOpenGlobalImNotificationSettings={() =>
            openImNotificationTargetDialog({ type: 'global' })
          }
          onRememberExecutionDevice={onRememberExecutionDevice}
          onOpenPlugins={onOpenPlugins}
          onRefreshDevices={onRefreshDevices}
          onUpgradeDevice={onUpgradeDevice}
          onCreateProject={onCreateProject}
          onCreateGitWorkspaceProject={onCreateGitWorkspaceProject}
          onPrepareDeviceWorkspace={onPrepareDeviceWorkspace}
          onListGitRepositories={onListGitRepositories}
          onListGitBranches={onListGitBranches}
          onUpdateProjectName={onUpdateProjectName}
          onRemoveProject={onRemoveProject}
          onGetDeviceHomeDirectory={onGetDeviceHomeDirectory}
          onGetProjectWorkspaceRoot={onGetProjectWorkspaceRoot}
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
          sidebarCollapsed={sidebarCollapsed}
          isBootstrapping={state.isBootstrapping}
          currentTask={state.currentTask}
          currentRuntimeTask={state.currentRuntimeTask}
          runtimeWork={state.runtimeWork}
          currentProject={activeConversationProject}
          workspaceTarget={workspaceTarget}
          workspaceTargetError={workspaceTargetError}
          devices={state.devices}
          upgradingDevices={upgradingDevices}
          messages={messages}
          queuedMessages={queuedMessages}
          guidanceMessages={guidanceMessages}
          codeCommentContexts={codeCommentContexts}
          projectChat={projectChat}
          projectWork={projectWorkWithCreation}
          input={state.input}
          isSending={state.isSending}
          error={state.error}
          environmentInfo={environmentInfo}
          onRefreshEnvironmentInfo={refreshEnvironmentInfo}
          onCommitEnvironmentChanges={handleCommitEnvironmentChanges}
          onLoadEnvironmentDiff={
            onLoadEnvironmentDiff
              ? workspaceTarget => onLoadEnvironmentDiff(environmentProject, workspaceTarget)
              : undefined
          }
          onListEnvironmentBranches={() => {
            if (!workspaceTarget) {
              return Promise.reject(new Error(workspaceTargetError ?? 'Workspace is not ready'))
            }
            return onListEnvironmentBranches(environmentProject, workspaceTarget)
          }}
          onCheckoutEnvironmentBranch={handleCheckoutEnvironmentBranch}
          onCreateEnvironmentBranch={handleCreateEnvironmentBranch}
          onOpenCloudDeviceSettings={() => {
            setAutoOpenAddCloudDeviceDialog(true)
            setSettingsOpen(true)
            navigateTo('/settings')
          }}
          onUpgradeDevice={onUpgradeDevice}
          onInputChange={onInputChange}
          onSend={onSend}
          onRetryFailedMessage={onRetryFailedMessage}
          isResponseStreaming={isResponseStreaming}
          onPauseResponse={onPauseResponse}
          onCancelQueuedMessage={onCancelQueuedMessage}
          onSendQueuedAsGuidance={onSendQueuedAsGuidance}
          onEditQueuedMessage={onEditQueuedMessage}
          onCancelGuidanceMessage={onCancelGuidanceMessage}
          onLoadFileChangesDiff={onLoadFileChangesDiff}
          onRevertFileChanges={onRevertFileChanges}
          onAddCodeComment={onAddCodeComment}
          onClearCodeComments={onClearCodeComments}
          onContinueInIm={openContinueInImDialog}
          onForkCurrentRuntimeTask={onForkCurrentRuntimeTask}
          onPrepareDeviceWorkspace={onPrepareDeviceWorkspace}
          onGetDeviceHomeDirectory={onGetDeviceHomeDirectory}
          onGetProjectWorkspaceRoot={onGetProjectWorkspaceRoot}
          onListDeviceDirectories={onListDeviceDirectories}
          onCreateDeviceDirectory={onCreateDeviceDirectory}
          topBarLeftActions={
            sidebarCollapsed ? (
              <DesktopWindowControls
                sidebarCollapsed
                onToggleSidebar={() => setSidebarCollapsed(false)}
                onNewChat={onNewChat}
              />
            ) : undefined
          }
        />
      )}
      <ProjectCreateDialog
        open={projectWorkCreateMode !== null}
        mode={projectWorkCreateMode ?? 'scratch'}
        devices={state.devices}
        onClose={() => setProjectWorkCreateMode(null)}
        onOpenCloudDeviceSettings={() => {
          setProjectWorkCreateMode(null)
          setAutoOpenAddCloudDeviceDialog(true)
          setSettingsOpen(true)
          navigateTo('/settings')
        }}
        onCreateProject={onCreateProject}
        onCreateGitWorkspaceProject={onCreateGitWorkspaceProject}
        onPrepareDeviceWorkspace={onPrepareDeviceWorkspace}
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
        key={continueInImOpen ? 'continue-im-open' : 'continue-im-closed'}
        open={continueInImOpen}
        loading={imSessionsLoading}
        submitting={imSessionsSubmitting}
        sessions={imSessions}
        onClose={closeContinueInImDialog}
        onSubmit={submitContinueInIm}
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
    </div>
  )
}
