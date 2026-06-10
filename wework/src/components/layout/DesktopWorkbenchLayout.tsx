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
  CreateGitWorkspaceProjectRequest,
  CreateProjectRequest,
  GitBranch,
  GitRepoInfo,
  ProjectWithTasks,
  TaskDetail,
  TaskListResponse,
} from '@/types/api'
import type { EnvironmentInfo } from '@/types/environment'
import type { DeviceUpgradeState } from '@/types/device-events'
import { stripAppBasePath } from '@/config/runtime'
import { isSettingsRoute, navigateTo } from '@/lib/navigation'
import { DesktopSidebar } from './DesktopSidebar'
import { ProjectCreateDialog } from '@/components/projects/ProjectCreateDialog'
import { DesktopWorkbenchMain } from './DesktopWorkbenchMain'
import { DesktopWindowControls } from './DesktopWindowControls'
import { useDesktopSidebarCollapsed } from './useDesktopSidebarCollapsed'
import { ConnectionsSettingsPage } from '@/components/settings/ConnectionsSettingsPage'

interface DesktopWorkbenchLayoutProps {
  state: WorkbenchState
  messages: WorkbenchMessage[]
  queuedMessages?: QueuedWorkbenchMessage[]
  guidanceMessages?: GuidanceWorkbenchMessage[]
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
  onRememberExecutionDevice?: (deviceId: string) => void
  onRefreshDevices?: () => Promise<void>
  onUpgradeDevice?: (deviceId: string) => Promise<void>
  onCreateProject: (data: CreateProjectRequest) => Promise<ProjectWithTasks>
  onCreateGitWorkspaceProject: (
    data: CreateGitWorkspaceProjectRequest,
  ) => Promise<ProjectWithTasks>
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
  onLoadEnvironmentInfo: (project: ProjectWithTasks | null) => Promise<EnvironmentInfo>
  onCommitEnvironmentChanges: (
    project: ProjectWithTasks | null,
    message: string,
  ) => Promise<void>
  onListEnvironmentBranches: (project: ProjectWithTasks | null) => Promise<string[]>
  onCheckoutEnvironmentBranch: (
    project: ProjectWithTasks | null,
    branchName: string,
  ) => Promise<void>
  onCreateEnvironmentBranch: (
    project: ProjectWithTasks | null,
    branchName: string,
  ) => Promise<void>
  onInputChange: (value: string) => void
  onSend: () => void
  isResponseStreaming?: boolean
  onPauseResponse?: () => void
  onCancelQueuedMessage?: (id: string) => void
  onSendQueuedAsGuidance?: (id: string) => void
  onEditQueuedMessage?: (id: string) => void
  onCancelGuidanceMessage?: (id: string) => void
  onLogout: () => void
}

export function DesktopWorkbenchLayout({
  state,
  messages,
  queuedMessages = [],
  guidanceMessages = [],
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
  onRememberExecutionDevice,
  onRefreshDevices,
  onUpgradeDevice = async () => {},
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
  onListEnvironmentBranches,
  onCheckoutEnvironmentBranch,
  onCreateEnvironmentBranch,
  onInputChange,
  onSend,
  isResponseStreaming = false,
  onPauseResponse = () => {},
  onCancelQueuedMessage = () => {},
  onSendQueuedAsGuidance = () => {},
  onEditQueuedMessage = () => {},
  onCancelGuidanceMessage = () => {},
  onLogout,
}: DesktopWorkbenchLayoutProps) {
  const { sidebarCollapsed, setSidebarCollapsed } =
    useDesktopSidebarCollapsed()
  const [settingsOpen, setSettingsOpen] = useState(() =>
    isSettingsRoute(stripAppBasePath(window.location.pathname))
  )
  const [autoOpenAddCloudDeviceDialog, setAutoOpenAddCloudDeviceDialog] =
    useState(false)
  const [projectWorkCreateMode, setProjectWorkCreateMode] =
    useState<ProjectCreateMode | null>(null)
  const [environmentInfo, setEnvironmentInfo] = useState<EnvironmentInfo>({
    additions: '+0',
    deletions: '-0',
    executionTarget: 'local',
  })
  const environmentProject = useMemo(
    () => {
      const taskProject =
        state.currentTask?.project_id && state.currentTask.project_id > 0
          ? state.projects.find(project => project.id === state.currentTask?.project_id)
          : null
      return (
        state.currentProject ??
        taskProject ??
        state.projects.find(project => project.config?.mode === 'workspace') ??
        null
      )
    },
    [state.currentProject, state.currentTask?.project_id, state.projects],
  )
  const completedAssistantMessageIds = useRef<Set<string>>(new Set())
  const completedAssistantMessagesInitialized = useRef(false)

  const refreshEnvironmentInfo = useCallback(async () => {
    setEnvironmentInfo(info => ({ ...info, loading: true }))
    try {
      const info = await onLoadEnvironmentInfo(environmentProject)
      setEnvironmentInfo({ ...info, loading: false })
    } catch (error) {
      setEnvironmentInfo(info => ({
        ...info,
        loading: false,
        error: error instanceof Error ? error.message : 'Failed to load environment info',
      }))
    }
  }, [environmentProject, onLoadEnvironmentInfo])

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
        .map(message => message.id),
    )
    const hasNewCompletedMessage = [...nextCompletedIds].some(
      id => !completedAssistantMessageIds.current.has(id),
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
    await onCommitEnvironmentChanges(environmentProject, message)
    await refreshEnvironmentInfo()
  }

  async function handleCheckoutEnvironmentBranch(branchName: string) {
    await onCheckoutEnvironmentBranch(environmentProject, branchName)
    await refreshEnvironmentInfo()
  }

  async function handleCreateEnvironmentBranch(branchName: string) {
    await onCreateEnvironmentBranch(environmentProject, branchName)
    await refreshEnvironmentInfo()
  }

  const openProjectFromWorkMenu = useCallback((mode: ProjectCreateMode) => {
    setProjectWorkCreateMode(mode)
    void onRefreshDevices?.().catch(() => undefined)
  }, [onRefreshDevices])

  const projectWorkWithCreation: ProjectWorkControls = {
    ...projectWork,
    onCreateProjectMode: openProjectFromWorkMenu,
    branchName: environmentInfo.branchName,
    branchLoading: environmentInfo.loading,
    onRefreshBranch: refreshEnvironmentInfo,
    onListBranches: () => onListEnvironmentBranches(environmentProject),
    onCheckoutBranch: handleCheckoutEnvironmentBranch,
    onCreateBranch: handleCreateEnvironmentBranch,
  }

  useEffect(() => {
    if (state.currentProject && !state.currentTask) {
      void refreshEnvironmentInfo()
    }
  }, [refreshEnvironmentInfo, state.currentProject, state.currentTask])

  return (
    <div className="relative flex h-screen overflow-hidden bg-background text-text-primary">
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
            state.standaloneDeviceId ??
            state.user?.preferences?.default_execution_target
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
            setAutoOpenAddCloudDeviceDialog(
              Boolean(options?.autoOpenAddCloudDeviceDialog),
            )
            setSettingsOpen(true)
            navigateTo('/settings')
          }}
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
          isBootstrapping={state.isBootstrapping}
          currentTask={state.currentTask}
          currentProject={state.currentProject}
          devices={state.devices}
          upgradingDevices={upgradingDevices}
          messages={messages}
          queuedMessages={queuedMessages}
          guidanceMessages={guidanceMessages}
          projectChat={projectChat}
          projectWork={projectWorkWithCreation}
          input={state.input}
          isSending={state.isSending}
          environmentInfo={environmentInfo}
          onRefreshEnvironmentInfo={refreshEnvironmentInfo}
          onCommitEnvironmentChanges={handleCommitEnvironmentChanges}
          onListEnvironmentBranches={() => onListEnvironmentBranches(environmentProject)}
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
          isResponseStreaming={isResponseStreaming}
          onPauseResponse={onPauseResponse}
          onCancelQueuedMessage={onCancelQueuedMessage}
          onSendQueuedAsGuidance={onSendQueuedAsGuidance}
          onEditQueuedMessage={onEditQueuedMessage}
          onCancelGuidanceMessage={onCancelGuidanceMessage}
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
          state.standaloneDeviceId ??
          state.user?.preferences?.default_execution_target
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
    </div>
  )
}
