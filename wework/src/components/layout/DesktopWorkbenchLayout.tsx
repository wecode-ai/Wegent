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
  ArchivedTaskListResponse,
  BindTaskIMSessionsResponse,
  CreateGitWorkspaceProjectRequest,
  CreateProjectRequest,
  GitBranch,
  GitRepoInfo,
  IMPrivateSession,
  IMPrivateSessionListResponse,
  LocalCodexBindRequest,
  LocalCodexBindResponse,
  LocalCodexThreadSummary,
  ProjectWithTasks,
  TaskDetail,
  TaskListResponse,
  TurnFileChangesSummary,
} from '@/types/api'
import type { EnvironmentInfo } from '@/types/environment'
import type { DeviceUpgradeState } from '@/types/device-events'
import type { CodeCommentContext, WorkspaceTarget } from '@/types/workspace-files'
import { stripAppBasePath } from '@/config/runtime'
import { isSettingsRoute, navigateTo } from '@/lib/navigation'
import { resolveWorkspaceTarget, workspaceTargetKey } from '@/lib/workspace-target'
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
  runningTaskIds: Set<number>
  upgradingDevices?: Record<string, DeviceUpgradeState>
  activeItem?: 'chat' | 'plugins' | 'automation'
  onNewChat: () => void
  onStartStandaloneChat: () => void
  onOpenPlugins: () => void
  projectChat: ProjectChatControls
  projectWork: ProjectWorkControls
  onSelectProject: (projectId: number | null) => void
  onStartNewProjectChat: (projectId: number) => void
  onOpenTask: (taskId: number, projectId?: number) => void
  onSearchTasks?: (query: string) => Promise<TaskListResponse>
  onSearchTaskDetail?: (taskId: number) => Promise<TaskDetail>
  onListLocalCodexThreads?: (deviceId: string, limit?: number) => Promise<LocalCodexThreadSummary[]>
  onBindLocalCodexThread?: (request: LocalCodexBindRequest) => Promise<LocalCodexBindResponse>
  onRememberExecutionDevice?: (deviceId: string) => void
  onRefreshDevices?: () => Promise<void>
  onUpgradeDevice?: (deviceId: string) => Promise<void>
  onListImPrivateSessions?: () => Promise<IMPrivateSessionListResponse>
  onBindTaskToImSessions?: (
    taskId: number,
    sessionKeys: string[]
  ) => Promise<BindTaskIMSessionsResponse>
  onCreateProject: (data: CreateProjectRequest) => Promise<ProjectWithTasks>
  onCreateGitWorkspaceProject: (data: CreateGitWorkspaceProjectRequest) => Promise<ProjectWithTasks>
  onListGitRepositories: () => Promise<GitRepoInfo[]>
  onListGitBranches: (repo: GitRepoInfo) => Promise<GitBranch[]>
  onUpdateProjectName: (projectId: number, name: string) => Promise<void>
  onRemoveProject: (projectId: number) => Promise<void>
  onArchiveAllChats: () => Promise<void>
  onArchiveAllProjectChats: () => Promise<void>
  onArchiveProjectChats: (projectId: number) => Promise<void>
  onArchiveTask: (taskId: number) => Promise<void>
  onRenameTask: (taskId: number, title: string) => Promise<void>
  onListArchivedTasks: () => Promise<ArchivedTaskListResponse>
  onUnarchiveTask: (taskId: number) => Promise<void>
  onDeleteTask: (taskId: number) => Promise<void>
  onDeleteArchivedTasks: () => Promise<void>
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

export function DesktopWorkbenchLayout({
  state,
  messages,
  queuedMessages = [],
  guidanceMessages = [],
  codeCommentContexts = [],
  runningTaskIds,
  upgradingDevices = {},
  activeItem = 'chat',
  onNewChat,
  onStartStandaloneChat,
  onOpenPlugins,
  projectChat,
  projectWork,
  onSelectProject,
  onStartNewProjectChat,
  onOpenTask,
  onSearchTasks,
  onSearchTaskDetail,
  onListLocalCodexThreads,
  onBindLocalCodexThread,
  onRememberExecutionDevice,
  onRefreshDevices,
  onUpgradeDevice = async () => {},
  onListImPrivateSessions,
  onBindTaskToImSessions,
  onCreateProject,
  onCreateGitWorkspaceProject,
  onListGitRepositories,
  onListGitBranches,
  onUpdateProjectName,
  onRemoveProject,
  onArchiveAllChats,
  onArchiveAllProjectChats,
  onArchiveProjectChats,
  onArchiveTask,
  onRenameTask,
  onListArchivedTasks,
  onUnarchiveTask,
  onDeleteTask,
  onDeleteArchivedTasks,
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
  const activeConversationProject = state.currentProject ?? currentTaskProject
  const environmentProject = useMemo(
    () =>
      activeConversationProject ??
      state.projects.find(project => project.config?.mode === 'workspace') ??
      null,
    [activeConversationProject, state.projects]
  )
  const completedAssistantMessageIds = useRef<Set<string>>(new Set())
  const completedAssistantMessagesInitialized = useRef(false)
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

  useEffect(() => {
    let cancelled = false
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
    state.currentTask,
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

  useEffect(() => {
    const nextCompletedIds = new Set(
      messages
        .filter(message => message.role === 'assistant' && message.status === 'done')
        .map(message => message.id)
    )
    const hasNewCompletedMessage = [...nextCompletedIds].some(
      id => !completedAssistantMessageIds.current.has(id)
    )
    completedAssistantMessageIds.current = nextCompletedIds

    if (!completedAssistantMessagesInitialized.current) {
      completedAssistantMessagesInitialized.current = true
      return
    }

    if (hasNewCompletedMessage) {
      void refreshEnvironmentInfo()
    }
  }, [messages, refreshEnvironmentInfo])

  async function handleCommitEnvironmentChanges(message: string) {
    if (!workspaceTarget) {
      throw new Error(workspaceTargetError ?? 'Workspace is not ready')
    }
    await onCommitEnvironmentChanges(environmentProject, message, workspaceTarget)
    await refreshEnvironmentInfo()
  }

  async function handleCheckoutEnvironmentBranch(branchName: string) {
    if (!workspaceTarget) {
      throw new Error(workspaceTargetError ?? 'Workspace is not ready')
    }
    await onCheckoutEnvironmentBranch(environmentProject, branchName, workspaceTarget)
    await refreshEnvironmentInfo()
  }

  async function handleCreateEnvironmentBranch(branchName: string) {
    if (!workspaceTarget) {
      throw new Error(workspaceTargetError ?? 'Workspace is not ready')
    }
    await onCreateEnvironmentBranch(environmentProject, branchName, workspaceTarget)
    await refreshEnvironmentInfo()
  }

  const openProjectFromWorkMenu = useCallback(
    (mode: ProjectCreateMode) => {
      setProjectWorkCreateMode(mode)
      void onRefreshDevices?.().catch(() => undefined)
    },
    [onRefreshDevices]
  )

  const openContinueInImDialog = useCallback(() => {
    if (!state.currentTask || state.currentTask.is_group_chat) return

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
  }, [onListImPrivateSessions, state.currentTask, t])

  const closeContinueInImDialog = useCallback(() => {
    imSessionsRequestSequence.current += 1
    setContinueInImOpen(false)
    setImSessionsLoading(false)
  }, [])

  const submitContinueInIm = useCallback(
    async (sessionKeys: string[]) => {
      if (!state.currentTask || state.currentTask.is_group_chat) return

      setImSessionsSubmitting(true)
      try {
        if (!onBindTaskToImSessions) {
          throw new Error('IM bind handler is not available')
        }
        await onBindTaskToImSessions(state.currentTask.id, sessionKeys)
        setContinueInImOpen(false)
        setNotice({ message: t('workbench.continue_im_success'), tone: 'success' })
      } catch {
        setNotice({ message: t('workbench.continue_im_failed'), tone: 'error' })
      } finally {
        setImSessionsSubmitting(false)
      }
    },
    [onBindTaskToImSessions, state.currentTask, t]
  )

  const projectWorkWithCreation: ProjectWorkControls = {
    ...projectWork,
    onCreateProjectMode: openProjectFromWorkMenu,
    branchName: environmentInfo.branchName,
    branchLoading: environmentInfo.loading,
    onRefreshBranch: refreshEnvironmentInfo,
    onListBranches: workspaceTarget
      ? () => onListEnvironmentBranches(environmentProject, workspaceTarget)
      : undefined,
    onCheckoutBranch: handleCheckoutEnvironmentBranch,
    onCreateBranch: handleCreateEnvironmentBranch,
  }

  useEffect(() => {
    if (state.currentProject && !state.currentTask) {
      void refreshEnvironmentInfo()
    }
  }, [refreshEnvironmentInfo, state.currentProject, state.currentTask])

  return (
    <div className="relative flex h-full overflow-hidden bg-transparent text-text-primary">
      {!settingsOpen && !sidebarCollapsed && (
        <DesktopSidebar
          user={state.user}
          projects={state.projects}
          devices={state.devices}
          recentTasks={state.recentTasks}
          runningTaskIds={runningTaskIds}
          currentProjectId={state.currentProject?.id}
          currentTaskId={state.currentTask?.id}
          preferredDeviceId={
            state.standaloneDeviceId ?? state.user?.preferences?.default_execution_target
          }
          upgradingDevices={upgradingDevices}
          activeItem={activeItem}
          onCollapse={() => setSidebarCollapsed(true)}
          onNewChat={onNewChat}
          onStartStandaloneChat={onStartStandaloneChat}
          onSelectProject={onSelectProject}
          onStartNewProjectChat={onStartNewProjectChat}
          onOpenTask={onOpenTask}
          onSearchTasks={onSearchTasks}
          onSearchTaskDetail={onSearchTaskDetail}
          onListLocalCodexThreads={onListLocalCodexThreads}
          onBindLocalCodexThread={onBindLocalCodexThread}
          onRememberExecutionDevice={onRememberExecutionDevice}
          onOpenPlugins={onOpenPlugins}
          onRefreshDevices={onRefreshDevices}
          onUpgradeDevice={onUpgradeDevice}
          onCreateProject={onCreateProject}
          onCreateGitWorkspaceProject={onCreateGitWorkspaceProject}
          onListGitRepositories={onListGitRepositories}
          onListGitBranches={onListGitBranches}
          onUpdateProjectName={onUpdateProjectName}
          onRemoveProject={onRemoveProject}
          onArchiveAllChats={onArchiveAllChats}
          onArchiveAllProjectChats={onArchiveAllProjectChats}
          onArchiveProjectChats={onArchiveProjectChats}
          onArchiveTask={onArchiveTask}
          onRenameTask={onRenameTask}
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
          onListArchivedTasks={onListArchivedTasks}
          onUnarchiveTask={onUnarchiveTask}
          onDeleteTask={onDeleteTask}
          onDeleteArchivedTasks={onDeleteArchivedTasks}
        />
      ) : (
        <DesktopWorkbenchMain
          sidebarCollapsed={sidebarCollapsed}
          isBootstrapping={state.isBootstrapping}
          currentTask={state.currentTask}
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
      <TransientNotice
        message={notice?.message ?? null}
        tone={notice?.tone}
        onClear={() => setNotice(null)}
      />
    </div>
  )
}
