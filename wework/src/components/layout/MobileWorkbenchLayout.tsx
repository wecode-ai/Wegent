import { ArrowLeftRight, Bot, Menu, MessageCircle } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChatInput } from '@/components/chat/ChatInput'
import type { ProjectChatControls, ProjectWorkControls } from '@/components/chat/ChatInput'
import { ModelSelector } from '@/components/chat/composer/ModelSelector'
import { ProjectWorkBar } from '@/components/chat/composer/ProjectWorkBar'
import { MobileSettingsPage } from '@/components/settings/MobileSettingsPage'
import { stripAppBasePath } from '@/config/runtime'
import { useTranslation } from '@/hooks/useTranslation'
import { isSettingsRoute, navigateTo } from '@/lib/navigation'
import { resolveWorkspaceTarget, workspaceTargetKey } from '@/lib/workspace-target'
import {
  findProjectForTask,
  findWorkbenchDevice,
  getActiveWorkbenchDeviceId,
  isWorkbenchDeviceOnline,
} from '@/lib/workbench-device'
import {
  WEWORK_MIN_EXECUTOR_VERSION,
  isDeviceBelowWeWorkVersion,
  isWeWorkCompatibleDevice,
} from '@/lib/device-capabilities'
import { ScrollableMessageArea } from '@/components/chat/ScrollableMessageArea'
import type {
  BindRuntimeTaskIMSessionsResponse,
  CreateGitWorkspaceProjectRequest,
  CreateProjectRequest,
  DeleteDeviceWorkspaceRequest,
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
import type {
  GuidanceWorkbenchMessage,
  QueuedWorkbenchMessage,
  WorkbenchMessage,
  WorkbenchState,
} from '@/types/workbench'
import { ConversationDeviceOfflineBanner } from './ConversationDeviceOfflineBanner'
import { DeviceStatusPrompt } from './DeviceStatusPrompt'
import { MobileDrawer } from './MobileDrawer'
import { ContinueInImDialog } from '@/components/chat/ContinueInImDialog'
import { TransientNotice } from '@/components/common/TransientNotice'
import { TaskForkDialog } from './TaskForkDialog'

interface MobileWorkbenchLayoutProps {
  state: WorkbenchState
  messages: WorkbenchMessage[]
  queuedMessages?: QueuedWorkbenchMessage[]
  guidanceMessages?: GuidanceWorkbenchMessage[]
  codeCommentContexts?: CodeCommentContext[]
  upgradingDevices?: Record<string, DeviceUpgradeState>
  activeItem?: 'chat' | 'plugins' | 'automation'
  onNewChat?: () => void
  onStartStandaloneChat?: () => void
  onOpenPlugins?: () => void
  projectChat: ProjectChatControls
  projectWork: ProjectWorkControls
  onSelectProject: (projectId: number | null) => void
  onStartNewProjectChat?: (projectId: number) => void
  onOpenRuntimeLocalTask?: (address: RuntimeTaskAddress) => Promise<void>
  onArchiveRuntimeLocalTask?: (address: RuntimeTaskAddress) => Promise<void>
  onForkCurrentRuntimeTask?: (target: RuntimeTaskForkTarget) => Promise<void>
  onCreateProject?: (data: CreateProjectRequest) => Promise<ProjectWithTasks>
  onCreateGitWorkspaceProject?: (
    data: CreateGitWorkspaceProjectRequest
  ) => Promise<ProjectWithTasks>
  onPrepareDeviceWorkspace?: (
    data: DeviceWorkspacePrepareRequest
  ) => Promise<DeviceWorkspacePrepareResponse>
  onDeleteDeviceWorkspace?: (data: DeleteDeviceWorkspaceRequest) => Promise<void>
  onListGitRepositories?: () => Promise<GitRepoInfo[]>
  onListGitBranches?: (repo: GitRepoInfo) => Promise<GitBranch[]>
  onUpdateProjectName?: (projectId: number, name: string) => Promise<void>
  onRemoveProject?: (projectId: number) => Promise<void>
  onGetDeviceHomeDirectory?: (deviceId: string) => Promise<string>
  onGetProjectWorkspaceRoot?: (deviceId: string) => Promise<string>
  onListDeviceDirectories?: (deviceId: string, path: string) => Promise<string[]>
  onCreateDeviceDirectory?: (deviceId: string, path: string) => Promise<void>
  onLoadEnvironmentInfo?: (
    project: ProjectWithTasks | null,
    workspaceTarget?: WorkspaceTarget | null
  ) => Promise<EnvironmentInfo>
  onLoadEnvironmentDiff?: (
    project: ProjectWithTasks | null,
    workspaceTarget?: WorkspaceTarget | null
  ) => Promise<string>
  onCommitEnvironmentChanges?: (
    project: ProjectWithTasks | null,
    message: string,
    workspaceTarget?: WorkspaceTarget | null
  ) => Promise<void>
  onListEnvironmentBranches?: (
    project: ProjectWithTasks | null,
    workspaceTarget?: WorkspaceTarget | null
  ) => Promise<string[]>
  onCheckoutEnvironmentBranch?: (
    project: ProjectWithTasks | null,
    branchName: string,
    workspaceTarget?: WorkspaceTarget | null
  ) => Promise<void>
  onCreateEnvironmentBranch?: (
    project: ProjectWithTasks | null,
    branchName: string,
    workspaceTarget?: WorkspaceTarget | null
  ) => Promise<void>
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
  onUpgradeDevice?: (deviceId: string) => Promise<void>
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

export function MobileWorkbenchLayout({
  state,
  messages,
  queuedMessages = [],
  guidanceMessages = [],
  codeCommentContexts = [],
  upgradingDevices = {},
  activeItem,
  onNewChat,
  onStartStandaloneChat,
  onOpenPlugins,
  projectChat,
  projectWork,
  onSelectProject,
  onOpenRuntimeLocalTask,
  onForkCurrentRuntimeTask,
  onCreateProject,
  onCreateGitWorkspaceProject,
  onPrepareDeviceWorkspace,
  onDeleteDeviceWorkspace,
  onListGitRepositories,
  onListGitBranches,
  onUpdateProjectName,
  onRemoveProject,
  onGetDeviceHomeDirectory,
  onGetProjectWorkspaceRoot,
  onListDeviceDirectories,
  onCreateDeviceDirectory,
  onListEnvironmentBranches,
  onCheckoutEnvironmentBranch,
  onCreateEnvironmentBranch,
  onListImPrivateSessions,
  onBindRuntimeTaskToImSessions,
  onUpgradeDevice = async () => {},
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
  onClearCodeComments,
  onRefreshWorkLists,
}: MobileWorkbenchLayoutProps) {
  const { t } = useTranslation('common')
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [modelSelectorOpenSignal, setModelSelectorOpenSignal] = useState(0)
  const [settingsOpen, setSettingsOpen] = useState(() =>
    isSettingsRoute(stripAppBasePath(window.location.pathname))
  )
  const [environmentInfo, setEnvironmentInfo] = useState<EnvironmentInfo>({
    additions: '+0',
    deletions: '-0',
    executionTarget: 'local',
  })
  const [workspaceTarget, setWorkspaceTarget] = useState<WorkspaceTarget | null>(null)
  const [continueInImOpen, setContinueInImOpen] = useState(false)
  const [forkDialogOpen, setForkDialogOpen] = useState(false)
  const [imSessions, setImSessions] = useState<IMPrivateSession[]>([])
  const [imSessionsLoading, setImSessionsLoading] = useState(false)
  const [imSessionsSubmitting, setImSessionsSubmitting] = useState(false)
  const [notice, setNotice] = useState<{
    message: string
    tone: 'success' | 'error'
  } | null>(null)
  const imSessionsRequestSequence = useRef(0)
  const hasConversation =
    messages.length > 0 || Boolean(state.currentTask || state.currentRuntimeTask)
  const currentTaskProject = useMemo(
    () => findProjectForTask(state.projects, state.currentTask),
    [state.currentTask, state.projects]
  )
  const activeConversationProject = state.currentProject ?? currentTaskProject
  const currentTaskWorkspaceKey = state.currentTask
    ? [
        state.currentTask.id,
        state.currentTask.device_id ?? '',
        state.currentTask.execution_workspace_path ?? '',
      ].join(':')
    : ''
  const workspaceTargetResolverApi = useMemo(
    () => ({
      getProjectWorkspaceRoot: (deviceId: string) => {
        if (!onGetProjectWorkspaceRoot) {
          return Promise.reject(new Error('Project workspace root loader is not available'))
        }
        return onGetProjectWorkspaceRoot(deviceId)
      },
    }),
    [onGetProjectWorkspaceRoot]
  )
  const effectiveProjectChat = projectChat ?? {
    models: [],
    selectedModel: null,
    selectedModelOptions: {},
    isModelSelectionReady: true,
    isOptionsLocked: false,
    setSelectedModel: () => {},
    setSelectedModelOption: () => {},
  }
  const projectChatWithModelSelectorSignal: ProjectChatControls = {
    ...effectiveProjectChat,
    modelSelectorOpenSignal,
  }
  const emptyTitle = state.currentProject
    ? t('workbench.project_empty_title', {
        defaultValue: `我们应该在 ${state.currentProject.name} 中构建什么？`,
        projectName: state.currentProject.name,
      })
    : t('workbench.empty_title', '我们该做什么？')
  const baseProjectWork = projectWork ?? {
    projects: state.projects,
    devices: state.devices,
    currentProjectId: state.currentProject?.id,
    currentStandaloneDeviceId: state.standaloneDeviceId,
    executionMode: 'current_workspace',
    executionModeLocked: Boolean(state.currentTask),
    onSelectProject,
    onSelectStandaloneDevice: () => {},
    onExecutionModeChange: () => {},
  }
  const effectiveProjectWork: ProjectWorkControls = {
    ...baseProjectWork,
    branchName: environmentInfo.branchName,
    branchLoading: environmentInfo.loading,
    onRefreshBranch: undefined,
    onListBranches:
      activeConversationProject && onListEnvironmentBranches && workspaceTarget
        ? () => onListEnvironmentBranches(activeConversationProject, workspaceTarget)
        : undefined,
    onCheckoutBranch:
      activeConversationProject && onCheckoutEnvironmentBranch && workspaceTarget
        ? async branchName => {
            await onCheckoutEnvironmentBranch(
              activeConversationProject,
              branchName,
              workspaceTarget
            )
            setEnvironmentInfo(info => ({ ...info, branchName }))
          }
        : undefined,
    onCreateBranch:
      activeConversationProject && onCreateEnvironmentBranch && workspaceTarget
        ? async branchName => {
            await onCreateEnvironmentBranch(activeConversationProject, branchName, workspaceTarget)
            setEnvironmentInfo(info => ({ ...info, branchName }))
          }
        : undefined,
  }
  const activeDeviceId = getActiveWorkbenchDeviceId({
    currentTask: state.currentTask,
    currentProject: activeConversationProject,
    standaloneDeviceId: effectiveProjectWork.currentStandaloneDeviceId,
  })
  const activeDevice = findWorkbenchDevice(state.devices, activeDeviceId)
  const activeDeviceUnavailable = Boolean(activeDeviceId) && !isWorkbenchDeviceOnline(activeDevice)
  const showConversationDeviceBanner =
    Boolean(activeDeviceId) && (!activeDevice || activeDevice.status === 'offline')
  const activeDeviceVersionUnsupported = Boolean(
    activeDevice && isDeviceBelowWeWorkVersion(activeDevice)
  )
  const noStandaloneCompatibleDevice =
    !activeConversationProject &&
    !activeDeviceId &&
    !state.devices.some(device => device.status === 'online' && isWeWorkCompatibleDevice(device))
  const composerDisabled =
    state.isSending ||
    activeDeviceUnavailable ||
    activeDeviceVersionUnsupported ||
    noStandaloneCompatibleDevice
  const composerDisabledReason = state.isSending
    ? t('workbench.sending_message')
    : activeDeviceUnavailable
      ? t('workbench.device_status_active_unavailable', {
          device: activeDevice?.name || activeDeviceId || t('workbench.project_device'),
        })
      : activeDeviceVersionUnsupported
        ? t('workbench.device_status_active_upgrade_required', {
            device: activeDevice?.name || activeDeviceId || t('workbench.project_device'),
            version: WEWORK_MIN_EXECUTOR_VERSION,
          })
        : noStandaloneCompatibleDevice
          ? t('workbench.device_status_no_online_device')
          : undefined

  useEffect(() => {
    const handlePopState = () => {
      setSettingsOpen(isSettingsRoute(stripAppBasePath(window.location.pathname)))
    }
    window.addEventListener('popstate', handlePopState)
    return () => window.removeEventListener('popstate', handlePopState)
  }, [])

  useEffect(() => {
    let cancelled = false
    Promise.resolve()
      .then(() => {
        if (!cancelled) {
          setWorkspaceTarget(null)
        }
        return resolveWorkspaceTarget({
          currentTask: state.currentTask,
          currentProject: activeConversationProject,
          api: workspaceTargetResolverApi,
        })
      })
      .then(target => {
        if (!cancelled) {
          setWorkspaceTarget(current =>
            workspaceTargetKey(current) === workspaceTargetKey(target) ? current : target
          )
        }
      })
      .catch(() => {
        if (!cancelled) {
          setWorkspaceTarget(null)
        }
      })
    return () => {
      cancelled = true
    }
  }, [
    activeConversationProject,
    currentTaskWorkspaceKey,
    state.currentTask,
    workspaceTargetResolverApi,
  ])

  const openContinueInImDialog = useCallback(() => {
    if (!state.currentRuntimeTask) return

    const requestId = imSessionsRequestSequence.current + 1
    imSessionsRequestSequence.current = requestId
    setContinueInImOpen(true)
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
  }, [onListImPrivateSessions, state.currentRuntimeTask, t])

  const closeContinueInImDialog = useCallback(() => {
    imSessionsRequestSequence.current += 1
    setContinueInImOpen(false)
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

  if (settingsOpen) {
    return (
      <MobileSettingsPage
        onBack={() => {
          setSettingsOpen(false)
          navigateTo('/')
        }}
        onOpenPlugins={onOpenPlugins}
      />
    )
  }

  if (state.isBootstrapping) {
    return (
      <div className="flex h-dvh overflow-hidden bg-background text-text-primary">
        <main
          className="flex h-dvh min-h-0 w-full flex-col overflow-hidden"
          data-testid="mobile-workbench-loading"
        />
      </div>
    )
  }

  return (
    <div className="flex h-dvh overflow-hidden bg-background text-text-primary">
      <main className="flex h-dvh min-h-0 w-full flex-col overflow-hidden">
        {hasConversation ? (
          <div className="relative min-h-0 flex-1 overflow-hidden">
            <header
              data-testid="mobile-conversation-header"
              className="pointer-events-none absolute left-0 right-0 top-0 z-chrome flex min-h-[56px] items-center gap-2 border-b border-border/60 bg-background/95 px-3 pb-2 pt-[max(6px,env(safe-area-inset-top))] backdrop-blur"
            >
              <button
                type="button"
                data-testid="open-mobile-drawer-button"
                onClick={() => setDrawerOpen(true)}
                className="pointer-events-auto flex h-11 min-w-[44px] items-center justify-center rounded-full text-text-primary hover:bg-surface"
                aria-label={t('workbench.open_menu', '打开菜单')}
              >
                <Menu className="h-5 w-5" />
              </button>
              <div className="pointer-events-auto flex min-w-0 flex-1 justify-start">
                {(effectiveProjectChat.isModelSelectionReady ?? true) ? (
                  <ModelSelector
                    models={effectiveProjectChat.models}
                    selectedModel={effectiveProjectChat.selectedModel}
                    selectedModelOptions={effectiveProjectChat.selectedModelOptions}
                    openSignal={modelSelectorOpenSignal}
                    disabled={false}
                    onSelectModel={effectiveProjectChat.setSelectedModel}
                    onSelectModelOption={effectiveProjectChat.setSelectedModelOption}
                    onBlockedModelSelect={effectiveProjectChat.onBlockedModelSelect}
                    menuPlacement="below"
                    buttonClassName="max-w-[min(14rem,calc(100vw-6rem))] bg-surface px-3"
                    menuClassName="left-0 right-auto w-[min(34rem,calc(100vw-2rem))]"
                  />
                ) : (
                  <div className="h-10 w-32" data-testid="model-selector-loading" />
                )}
              </div>
              {state.currentRuntimeTask ? (
                <div className="pointer-events-auto flex items-center gap-1">
                  {onForkCurrentRuntimeTask && (
                    <button
                      type="button"
                      data-testid="mobile-fork-runtime-task-button"
                      className="flex h-11 min-w-[44px] items-center justify-center rounded-full text-text-primary hover:bg-surface"
                      aria-label={t('workbench.task_fork_title', '复制任务')}
                      onClick={() => setForkDialogOpen(true)}
                    >
                      <ArrowLeftRight className="h-5 w-5" />
                    </button>
                  )}
                  <button
                    type="button"
                    data-testid="mobile-continue-in-im-button"
                    className="flex h-11 min-w-[44px] items-center justify-center rounded-full text-text-primary hover:bg-surface"
                    aria-label={t('workbench.continue_im_title')}
                    onClick={openContinueInImDialog}
                  >
                    <MessageCircle className="h-5 w-5" />
                  </button>
                </div>
              ) : (
                <div className="h-11 min-w-[44px]" />
              )}
            </header>
            <ScrollableMessageArea
              messages={messages}
              conversationKey={state.currentTask?.id ?? null}
              className="h-full"
              scrollerClassName="pb-28 pt-16"
              devices={state.devices}
              onRetryFailedMessage={message => onRetryFailedMessage?.(message.id)}
              onSwitchModelForFailedMessage={() => setModelSelectorOpenSignal(signal => signal + 1)}
              onLoadFileChangesDiff={onLoadFileChangesDiff}
              onRevertFileChanges={onRevertFileChanges}
            />
            <div
              data-testid="mobile-chat-input-dock"
              className="pointer-events-none absolute bottom-0 left-0 right-0 z-chrome px-4 pb-[max(16px,env(safe-area-inset-bottom))] pt-3"
            >
              <div className="pointer-events-auto">
                {showConversationDeviceBanner ? (
                  <ConversationDeviceOfflineBanner
                    device={activeDevice}
                    deviceId={activeDeviceId}
                    className="mb-2"
                  />
                ) : (
                  <DeviceStatusPrompt
                    devices={state.devices}
                    upgradingDevices={upgradingDevices}
                    onUpgradeDevice={onUpgradeDevice}
                    onOpenCloudDeviceSettings={() => navigateTo('/settings')}
                    activeDeviceId={activeDeviceId}
                    requiresOnlineCompatibleDevice={noStandaloneCompatibleDevice}
                    compact
                    className="mb-2"
                  />
                )}
                <ChatInput
                  value={state.input}
                  onChange={onInputChange}
                  onSubmit={onSend}
                  disabled={composerDisabled}
                  error={state.error}
                  disabledReason={composerDisabledReason}
                  placeholder={t('workbench.mobile_input_placeholder', '询问 Wework')}
                  projectChat={projectChatWithModelSelectorSignal}
                  projectWork={projectWork}
                  queuedMessages={queuedMessages}
                  guidanceMessages={guidanceMessages}
                  codeComments={codeCommentContexts}
                  isStreaming={isResponseStreaming}
                  onPause={onPauseResponse}
                  onCancelQueuedMessage={onCancelQueuedMessage}
                  onSendQueuedAsGuidance={onSendQueuedAsGuidance}
                  onEditQueuedMessage={onEditQueuedMessage}
                  onCancelGuidanceMessage={onCancelGuidanceMessage}
                  onClearCodeComments={onClearCodeComments}
                />
              </div>
            </div>
          </div>
        ) : (
          <div className="flex h-dvh min-h-0 flex-col pb-[max(16px,env(safe-area-inset-bottom))]">
            <header
              data-testid="mobile-empty-header"
              className="flex min-h-[56px] shrink-0 items-center gap-2 border-b border-transparent bg-background/95 px-3 pb-2 pt-[max(6px,env(safe-area-inset-top))]"
            >
              <button
                type="button"
                data-testid="open-mobile-drawer-button"
                onClick={() => setDrawerOpen(true)}
                className="flex h-11 min-w-[44px] items-center justify-center rounded-full text-text-primary hover:bg-surface"
                aria-label={t('workbench.open_menu', '打开菜单')}
              >
                <Menu className="h-5 w-5" />
              </button>
              <div className="flex min-w-0 flex-1 justify-start">
                {(effectiveProjectChat.isModelSelectionReady ?? true) ? (
                  <ModelSelector
                    models={effectiveProjectChat.models}
                    selectedModel={effectiveProjectChat.selectedModel}
                    selectedModelOptions={effectiveProjectChat.selectedModelOptions}
                    openSignal={modelSelectorOpenSignal}
                    disabled={false}
                    onSelectModel={effectiveProjectChat.setSelectedModel}
                    onSelectModelOption={effectiveProjectChat.setSelectedModelOption}
                    onBlockedModelSelect={effectiveProjectChat.onBlockedModelSelect}
                    menuPlacement="below"
                    buttonClassName="max-w-[min(14rem,calc(100vw-6rem))] bg-surface px-3"
                    menuClassName="left-0 right-auto w-[min(34rem,calc(100vw-2rem))]"
                  />
                ) : (
                  <div className="h-10 w-32" data-testid="model-selector-loading" />
                )}
              </div>
              <div className="h-11 min-w-[44px]" />
            </header>

            <section className="flex min-h-0 flex-1 items-center justify-center px-5 pb-6">
              <div
                data-testid="mobile-empty-state-content"
                className="flex w-full max-w-[360px] flex-col items-center gap-6"
              >
                <Bot className="h-8 w-8 text-text-muted" />
                <h1 className="text-center text-2xl font-semibold tracking-normal">{emptyTitle}</h1>
                <ProjectWorkBar
                  {...effectiveProjectWork}
                  className="min-h-0 flex-col justify-center gap-1 px-0"
                  buttonClassName="bg-surface px-4 text-text-primary"
                  menuClassName="left-1/2 w-[min(20rem,calc(100vw-2.5rem))] -translate-x-1/2"
                  emptyLabel={t('workbench.select_project', '选择项目')}
                />
              </div>
            </section>
            <div data-testid="mobile-empty-chat-input-dock" className="px-4 pb-0 pt-3">
              <DeviceStatusPrompt
                devices={state.devices}
                upgradingDevices={upgradingDevices}
                onUpgradeDevice={onUpgradeDevice}
                onOpenCloudDeviceSettings={() => navigateTo('/settings')}
                activeDeviceId={activeDeviceId}
                requiresOnlineCompatibleDevice={noStandaloneCompatibleDevice}
                compact
                className="mb-2"
              />
              <ChatInput
                value={state.input}
                onChange={onInputChange}
                onSubmit={onSend}
                disabled={composerDisabled}
                error={state.error}
                disabledReason={composerDisabledReason}
                placeholder={t('workbench.mobile_input_placeholder', '询问 Wework')}
                projectChat={projectChatWithModelSelectorSignal}
                projectWork={projectWork}
                queuedMessages={queuedMessages}
                guidanceMessages={guidanceMessages}
                codeComments={codeCommentContexts}
                isStreaming={isResponseStreaming}
                onPause={onPauseResponse}
                onCancelQueuedMessage={onCancelQueuedMessage}
                onSendQueuedAsGuidance={onSendQueuedAsGuidance}
                onEditQueuedMessage={onEditQueuedMessage}
                onCancelGuidanceMessage={onCancelGuidanceMessage}
                onClearCodeComments={onClearCodeComments}
              />
            </div>
          </div>
        )}
      </main>

      <MobileDrawer
        open={drawerOpen}
        user={state.user}
        devices={state.devices}
        projects={state.projects}
        runtimeWork={state.runtimeWork}
        currentProjectId={state.currentProject?.id}
        currentRuntimeTask={state.currentRuntimeTask}
        activeItem={activeItem}
        onClose={() => setDrawerOpen(false)}
        onNewChat={onNewChat}
        onStartStandaloneChat={onStartStandaloneChat}
        onOpenSettings={() => {
          setSettingsOpen(true)
          navigateTo('/settings')
        }}
        onCreateProject={onCreateProject}
        onCreateGitWorkspaceProject={onCreateGitWorkspaceProject}
        onPrepareDeviceWorkspace={onPrepareDeviceWorkspace}
        onDeleteDeviceWorkspace={onDeleteDeviceWorkspace}
        onListGitRepositories={onListGitRepositories}
        onListGitBranches={onListGitBranches}
        onGetDeviceHomeDirectory={onGetDeviceHomeDirectory}
        onGetProjectWorkspaceRoot={onGetProjectWorkspaceRoot}
        onListDeviceDirectories={onListDeviceDirectories}
        onCreateDeviceDirectory={onCreateDeviceDirectory}
        onUpdateProjectName={onUpdateProjectName}
        onRemoveProject={onRemoveProject}
        onSelectProject={onSelectProject}
        onOpenRuntimeLocalTask={onOpenRuntimeLocalTask}
        onRefreshWorkLists={onRefreshWorkLists}
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
      <TaskForkDialog
        key={forkDialogOpen ? `open-${state.currentRuntimeTask?.localTaskId ?? 'none'}` : 'closed'}
        open={forkDialogOpen}
        source={state.currentRuntimeTask}
        runtimeWork={state.runtimeWork}
        currentProject={activeConversationProject}
        devices={state.devices}
        requiresStop={isResponseStreaming}
        onOpenChange={setForkDialogOpen}
        onStopCurrentResponse={onPauseResponse}
        onPrepareDeviceWorkspace={onPrepareDeviceWorkspace}
        onDeleteDeviceWorkspace={onDeleteDeviceWorkspace}
        onGetDeviceHomeDirectory={onGetDeviceHomeDirectory}
        onGetProjectWorkspaceRoot={onGetProjectWorkspaceRoot}
        onListDeviceDirectories={onListDeviceDirectories}
        onCreateDeviceDirectory={onCreateDeviceDirectory}
        onFork={async target => {
          if (!onForkCurrentRuntimeTask) return
          await onForkCurrentRuntimeTask(target)
        }}
      />
      <TransientNotice
        message={notice?.message ?? null}
        tone={notice?.tone}
        onClear={() => setNotice(null)}
      />
    </div>
  )
}
