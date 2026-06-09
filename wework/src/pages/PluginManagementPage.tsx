import { useState } from 'react'
import { Menu } from 'lucide-react'
import { DesktopSidebar } from '@/components/layout/DesktopSidebar'
import { DesktopWindowControls } from '@/components/layout/DesktopWindowControls'
import { MobileDrawer } from '@/components/layout/MobileDrawer'
import { useDesktopSidebarCollapsed } from '@/components/layout/useDesktopSidebarCollapsed'
import { PluginManagementWorkspace } from '@/components/plugins/PluginManagementWorkspace'
import { ConnectionsSettingsPage } from '@/components/settings/ConnectionsSettingsPage'
import { MobileSettingsPage } from '@/components/settings/MobileSettingsPage'
import { useAuth } from '@/features/auth/useAuth'
import { useWorkbench } from '@/features/workbench/useWorkbench'
import { useIsMobile } from '@/hooks/useIsMobile'
import { useTranslation } from '@/hooks/useTranslation'
import { navigateTo } from '@/lib/navigation'

export function PluginManagementPage() {
  const { t } = useTranslation('common')
  const { logout } = useAuth()
  const isMobile = useIsMobile()
  const {
    state,
    runningTaskIds,
    selectProject,
    startNewChat,
    startStandaloneChat,
    startNewProjectChat,
    openTask,
    refreshDevices,
    createProject,
    createGitWorkspaceProject,
    listGitRepositories,
    listGitBranches,
    updateProjectName,
    removeProject,
    archiveAllChats,
    archiveAllProjectChats,
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
    createDeviceDirectory,
  } = useWorkbench()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const { sidebarCollapsed, setSidebarCollapsed } =
    useDesktopSidebarCollapsed()

  const handleSelectProject = (projectId: number) => {
    navigateTo('/')
    selectProject(projectId)
  }

  const handleOpenTask = (taskId: number, projectId?: number) => {
    navigateTo('/')
    void openTask(taskId, projectId)
  }

  const handleOpenPlugins = () => {
    setSettingsOpen(false)
    navigateTo('/plugins')
  }

  if (settingsOpen) {
    if (isMobile) {
      return (
        <MobileSettingsPage
          onBack={() => setSettingsOpen(false)}
          onOpenPlugins={handleOpenPlugins}
        />
      )
    }

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

  const handleNewChat = () => {
    navigateTo('/')
    startNewChat()
  }

  const handleStartStandaloneChat = () => {
    navigateTo('/')
    startStandaloneChat()
  }

  return (
    <div className="flex h-dvh overflow-hidden bg-background text-text-primary lg:h-screen">
      {!isMobile && !sidebarCollapsed && (
        <DesktopSidebar
          user={state.user}
          projects={state.projects}
          devices={state.devices}
          recentTasks={state.recentTasks}
          runningTaskIds={runningTaskIds}
          currentProjectId={state.currentProject?.id}
          currentTaskId={state.currentTask?.id}
          activeItem="plugins"
          onCollapse={() => setSidebarCollapsed(true)}
          onNewChat={handleNewChat}
          onStartStandaloneChat={handleStartStandaloneChat}
          onSelectProject={handleSelectProject}
          onStartNewProjectChat={handleStartNewProjectChat}
          onOpenTask={handleOpenTask}
          onOpenPlugins={handleOpenPlugins}
          onRefreshDevices={refreshDevices}
          onCreateProject={createProject}
          onCreateGitWorkspaceProject={createGitWorkspaceProject}
          onListGitRepositories={listGitRepositories}
          onListGitBranches={listGitBranches}
          onUpdateProjectName={updateProjectName}
          onRemoveProject={removeProject}
          onArchiveAllChats={archiveAllChats}
          onArchiveAllProjectChats={archiveAllProjectChats}
          onArchiveProjectChats={archiveProjectChats}
          onArchiveTask={archiveTask}
          onRenameTask={renameTask}
          onGetDeviceHomeDirectory={getDeviceHomeDirectory}
          onGetProjectWorkspaceRoot={getProjectWorkspaceRoot}
          onListDeviceDirectories={listDeviceDirectories}
          onCreateDeviceDirectory={createDeviceDirectory}
          onOpenSettings={() => setSettingsOpen(true)}
          onLogout={logout}
        />
      )}
      {isMobile && (
        <>
          <header className="pointer-events-none absolute left-5 top-[max(8px,env(safe-area-inset-top))] z-chrome flex h-11 items-center">
            <button
              type="button"
              data-testid="open-mobile-drawer-button"
              onClick={() => setDrawerOpen(true)}
              className="pointer-events-auto flex h-11 min-w-[44px] items-center justify-center rounded-lg bg-surface text-text-primary transition-colors hover:bg-muted"
              aria-label={t('workbench.open_menu', '打开菜单')}
            >
              <Menu className="h-5 w-5" />
            </button>
          </header>
          <MobileDrawer
            open={drawerOpen}
            user={state.user}
            projects={state.projects}
            recentTasks={state.recentTasks}
            runningTaskIds={runningTaskIds}
            currentProjectId={state.currentProject?.id}
            currentTaskId={state.currentTask?.id}
            activeItem="plugins"
            onClose={() => setDrawerOpen(false)}
            onNewChat={handleNewChat}
            onStartStandaloneChat={handleStartStandaloneChat}
            onOpenSettings={() => setSettingsOpen(true)}
            onSelectProject={handleSelectProject}
            onOpenTask={handleOpenTask}
          />
        </>
      )}
      <PluginManagementWorkspace
        sidebarCollapsed={sidebarCollapsed && !isMobile}
        topBarLeftActions={
          sidebarCollapsed && !isMobile ? (
            <DesktopWindowControls
              sidebarCollapsed
              onToggleSidebar={() => setSidebarCollapsed(false)}
              onNewChat={handleNewChat}
            />
          ) : undefined
        }
      />
    </div>
  )
}
