import { useState } from 'react'
import { ChevronRight, Menu } from 'lucide-react'
import { DesktopSidebar } from '@/components/layout/DesktopSidebar'
import { MobileDrawer } from '@/components/layout/MobileDrawer'
import { PluginsWorkspace } from '@/components/plugins/PluginsWorkspace'
import { ConnectionsSettingsPage } from '@/components/settings/ConnectionsSettingsPage'
import { MobileSettingsPage } from '@/components/settings/MobileSettingsPage'
import { useAuth } from '@/features/auth/useAuth'
import { useWorkbench } from '@/features/workbench/useWorkbench'
import { useIsMobile } from '@/hooks/useIsMobile'
import { useTranslation } from '@/hooks/useTranslation'
import { navigateTo } from '@/lib/navigation'

export function PluginsPage() {
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
  } = useWorkbench()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)

  const handleSelectProject = (projectId: number) => {
    navigateTo('/')
    selectProject(projectId)
  }

  const handleOpenTask = (taskId: number, projectId?: number) => {
    navigateTo('/')
    void openTask(taskId, projectId)
  }

  if (settingsOpen) {
    if (isMobile) {
      return (
        <MobileSettingsPage
          onBack={() => setSettingsOpen(false)}
          onOpenPlugins={() => navigateTo('/plugins')}
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
      {!isMobile && !sidebarCollapsed ? (
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
          onOpenPlugins={() => navigateTo('/plugins')}
          onRefreshDevices={refreshDevices}
          onCreateProject={createProject}
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
          onOpenSettings={() => setSettingsOpen(true)}
          onLogout={logout}
        />
      ) : !isMobile ? (
        <button
          type="button"
          data-testid="expand-sidebar-button"
          onClick={() => setSidebarCollapsed(false)}
          className="absolute left-4 top-4 z-20 flex h-9 w-9 items-center justify-center rounded-md bg-surface text-text-secondary hover:bg-muted"
          aria-label={t('workbench.expand_sidebar', '展开侧边栏')}
        >
          <ChevronRight className="h-4 w-4" />
        </button>
      ) : (
        <header className="absolute left-0 right-0 top-0 z-20 flex h-14 items-center justify-between bg-background/95 px-4 backdrop-blur">
          <button
            type="button"
            data-testid="open-mobile-drawer-button"
            onClick={() => setDrawerOpen(true)}
            className="flex h-11 min-w-[44px] items-center justify-center rounded-full bg-surface"
            aria-label={t('workbench.open_menu', '打开菜单')}
          >
            <Menu className="h-6 w-6" />
          </button>
          <span className="text-sm font-semibold">{t('workbench.plugins_tab', '插件')}</span>
          <div className="h-11 min-w-[44px]" />
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
        </header>
      )}
      <PluginsWorkspace />
    </div>
  )
}
