import { useState } from 'react'
import { DesktopSidebar } from '@/components/layout/DesktopSidebar'
import { PluginsWorkspace } from '@/components/plugins/PluginsWorkspace'
import { ConnectionsSettingsPage } from '@/components/settings/ConnectionsSettingsPage'
import { useAuth } from '@/features/auth/useAuth'
import { useWorkbench } from '@/features/workbench/useWorkbench'
import { navigateTo } from '@/lib/navigation'

export function PluginsPage() {
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
    listDeviceDirectories,
  } = useWorkbench()
  const [settingsOpen, setSettingsOpen] = useState(false)

  const handleSelectProject = (projectId: number) => {
    navigateTo('/')
    selectProject(projectId)
  }

  const handleOpenTask = (taskId: number) => {
    navigateTo('/')
    void openTask(taskId)
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

  return (
    <div className="flex h-screen overflow-hidden bg-base text-text-primary">
      <DesktopSidebar
        user={state.user}
        projects={state.projects}
        devices={state.devices}
        recentTasks={state.recentTasks}
        currentProjectId={state.currentProject?.id}
        activeItem="plugins"
        onCollapse={() => {}}
        onNewChat={() => navigateTo('/')}
        onSelectProject={handleSelectProject}
        onStartNewProjectChat={startNewProjectChat}
        onOpenTask={handleOpenTask}
        onOpenPlugins={() => navigateTo('/plugins')}
        onCreateProject={createProject}
        onUpdateProjectName={updateProjectName}
        onRemoveProject={removeProject}
        onArchiveAllChats={archiveAllChats}
        onArchiveProjectChats={archiveProjectChats}
        onArchiveTask={archiveTask}
        onRenameTask={renameTask}
        onListDeviceDirectories={listDeviceDirectories}
        onOpenSettings={() => setSettingsOpen(true)}
        onLogout={logout}
      />
      <PluginsWorkspace />
    </div>
  )
}
