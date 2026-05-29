import { useState } from 'react'
import { DesktopSidebar } from '@/components/layout/DesktopSidebar'
import { PluginManagementWorkspace } from '@/components/plugins/PluginManagementWorkspace'
import { ConnectionsSettingsPage } from '@/components/settings/ConnectionsSettingsPage'
import { useAuth } from '@/features/auth/useAuth'
import { useWorkbench } from '@/features/workbench/useWorkbench'
import { navigateTo } from '@/lib/navigation'

export function PluginManagementPage() {
  const { logout } = useAuth()
  const {
    state,
    selectProject,
    startNewProjectChat,
    openTask,
    createProject,
    updateProjectName,
    removeProject,
    archiveAllChats,
    archiveProjectChats,
    archiveTask,
    renameTask,
    listArchivedTasks,
    unarchiveTask,
    deleteTask,
    deleteArchivedTasks,
    getDeviceHomeDirectory,
    getProjectWorkspaceRoot,
    listDeviceDirectories,
  } = useWorkbench()
  const [settingsOpen, setSettingsOpen] = useState(false)

  const handleSelectProject = (projectId: number) => {
    navigateTo('/')
    selectProject(projectId)
  }

  const handleOpenTask = (taskId: number, projectId?: number) => {
    navigateTo('/')
    void openTask(taskId, projectId)
  }

  if (settingsOpen) {
    return (
      <ConnectionsSettingsPage
        onBack={() => setSettingsOpen(false)}
        onListArchivedTasks={listArchivedTasks}
        onUnarchiveTask={unarchiveTask}
        onDeleteTask={deleteTask}
        onDeleteArchivedTasks={deleteArchivedTasks}
      />
    )
  }

  const handleStartNewProjectChat = (projectId: number) => {
    navigateTo('/')
    startNewProjectChat(projectId)
  }

  return (
    <div className="flex h-screen overflow-hidden bg-base text-text-primary">
      <DesktopSidebar
        user={state.user}
        projects={state.projects}
        devices={state.devices}
        recentTasks={state.recentTasks}
        currentProjectId={state.currentProject?.id}
        currentTaskId={state.currentTask?.id}
        activeItem="plugins"
        onCollapse={() => {}}
        onNewChat={() => navigateTo('/')}
        onSelectProject={handleSelectProject}
        onStartNewProjectChat={handleStartNewProjectChat}
        onOpenTask={handleOpenTask}
        onOpenPlugins={() => navigateTo('/plugins')}
        onCreateProject={createProject}
        onUpdateProjectName={updateProjectName}
        onRemoveProject={removeProject}
        onArchiveAllChats={archiveAllChats}
        onArchiveProjectChats={archiveProjectChats}
        onArchiveTask={archiveTask}
        onRenameTask={renameTask}
        onGetDeviceHomeDirectory={getDeviceHomeDirectory}
        onGetProjectWorkspaceRoot={getProjectWorkspaceRoot}
        onListDeviceDirectories={listDeviceDirectories}
        onOpenSettings={() => setSettingsOpen(true)}
        onLogout={logout}
      />
      <PluginManagementWorkspace />
    </div>
  )
}
