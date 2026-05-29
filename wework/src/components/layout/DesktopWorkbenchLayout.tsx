import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { WorkbenchMessage, WorkbenchState } from '@/types/workbench'
import type { ProjectChatControls, ProjectWorkControls } from '@/components/chat/ChatInput'
import type { ArchivedTaskListResponse, CreateProjectRequest, ProjectWithTasks } from '@/types/api'
import type { EnvironmentInfo } from '@/types/environment'
import { DesktopSidebar } from './DesktopSidebar'
import { DesktopWorkbenchMain } from './DesktopWorkbenchMain'
import { ConnectionsSettingsPage } from '@/components/settings/ConnectionsSettingsPage'

interface DesktopWorkbenchLayoutProps {
  state: WorkbenchState
  messages: WorkbenchMessage[]
  activeItem?: 'chat' | 'plugins' | 'automation'
  onNewChat: () => void
  onOpenPlugins: () => void
  projectChat: ProjectChatControls
  projectWork: ProjectWorkControls
  onSelectProject: (projectId: number) => void
  onStartNewProjectChat: (projectId: number) => void
  onOpenTask: (taskId: number, projectId?: number) => void
  onCreateProject: (data: CreateProjectRequest) => Promise<ProjectWithTasks>
  onUpdateProjectName: (projectId: number, name: string) => Promise<void>
  onRemoveProject: (projectId: number) => Promise<void>
  onArchiveAllChats: () => Promise<void>
  onArchiveProjectChats: (projectId: number) => Promise<void>
  onArchiveTask: (taskId: number) => Promise<void>
  onRenameTask: (taskId: number, title: string) => Promise<void>
  onListArchivedTasks: () => Promise<ArchivedTaskListResponse>
  onUnarchiveTask: (taskId: number) => Promise<void>
  onDeleteTask: (taskId: number) => Promise<void>
  onDeleteArchivedTasks: () => Promise<void>
  onListDeviceDirectories: (deviceId: string, path: string) => Promise<string[]>
  onLoadEnvironmentInfo: (project: ProjectWithTasks | null) => Promise<EnvironmentInfo>
  onCommitEnvironmentChanges: (
    project: ProjectWithTasks | null,
    message: string,
  ) => Promise<void>
  onInputChange: (value: string) => void
  onSend: () => void
  onLogout: () => void
}

export function DesktopWorkbenchLayout({
  state,
  messages,
  activeItem = 'chat',
  onNewChat,
  onOpenPlugins,
  projectChat,
  projectWork,
  onSelectProject,
  onStartNewProjectChat,
  onOpenTask,
  onCreateProject,
  onUpdateProjectName,
  onRemoveProject,
  onArchiveAllChats,
  onArchiveProjectChats,
  onArchiveTask,
  onRenameTask,
  onListArchivedTasks,
  onUnarchiveTask,
  onDeleteTask,
  onDeleteArchivedTasks,
  onListDeviceDirectories,
  onLoadEnvironmentInfo,
  onCommitEnvironmentChanges,
  onInputChange,
  onSend,
  onLogout,
}: DesktopWorkbenchLayoutProps) {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
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

  return (
    <div className="flex h-screen overflow-hidden bg-base text-text-primary">
      {!settingsOpen && !sidebarCollapsed && (
        <DesktopSidebar
          user={state.user}
          projects={state.projects}
          devices={state.devices}
          recentTasks={state.recentTasks}
          currentProjectId={state.currentProject?.id}
          activeItem={activeItem}
          onCollapse={() => setSidebarCollapsed(true)}
          onNewChat={onNewChat}
          onSelectProject={onSelectProject}
          onStartNewProjectChat={onStartNewProjectChat}
          onOpenTask={onOpenTask}
          onOpenPlugins={onOpenPlugins}
          onCreateProject={onCreateProject}
          onUpdateProjectName={onUpdateProjectName}
          onRemoveProject={onRemoveProject}
          onArchiveAllChats={onArchiveAllChats}
          onArchiveProjectChats={onArchiveProjectChats}
          onArchiveTask={onArchiveTask}
          onRenameTask={onRenameTask}
          onListDeviceDirectories={onListDeviceDirectories}
          onOpenSettings={() => setSettingsOpen(true)}
          onLogout={onLogout}
        />
      )}

      {settingsOpen ? (
        <ConnectionsSettingsPage
          onBack={() => setSettingsOpen(false)}
          onListArchivedTasks={onListArchivedTasks}
          onUnarchiveTask={onUnarchiveTask}
          onDeleteTask={onDeleteTask}
          onDeleteArchivedTasks={onDeleteArchivedTasks}
        />
      ) : (
        <DesktopWorkbenchMain
          sidebarCollapsed={sidebarCollapsed}
          currentTask={state.currentTask}
          currentProject={state.currentProject}
          messages={messages}
          projectChat={projectChat}
          projectWork={projectWork}
          input={state.input}
          isSending={state.isSending}
          environmentInfo={environmentInfo}
          onRefreshEnvironmentInfo={refreshEnvironmentInfo}
          onCommitEnvironmentChanges={handleCommitEnvironmentChanges}
          onExpandSidebar={() => setSidebarCollapsed(false)}
          onInputChange={onInputChange}
          onSend={onSend}
        />
      )}
    </div>
  )
}
