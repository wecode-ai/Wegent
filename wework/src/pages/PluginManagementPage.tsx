import { useState } from 'react'
import { Menu } from 'lucide-react'
import { DesktopSidebar } from '@/components/layout/DesktopSidebar'
import { DesktopWindowControls } from '@/components/layout/DesktopWindowControls'
import { MobileDrawer } from '@/components/layout/MobileDrawer'
import { useDesktopSidebarCollapsed } from '@/components/layout/useDesktopSidebarCollapsed'
import { WorkbenchSearchDialog } from '@/components/layout/WorkbenchSearchDialog'
import { PluginManagementWorkspace } from '@/components/plugins/PluginManagementWorkspace'
import { ConnectionsSettingsPage } from '@/components/settings/ConnectionsSettingsPage'
import { MobileSettingsPage } from '@/components/settings/MobileSettingsPage'
import { useAuth } from '@/features/auth/useAuth'
import { useWorkbench } from '@/features/workbench/useWorkbench'
import { useIsMobile } from '@/hooks/useIsMobile'
import { useTranslation } from '@/hooks/useTranslation'
import { navigateTo } from '@/lib/navigation'
import { isTauriRuntime } from '@/lib/runtime-environment'

export function PluginManagementPage() {
  const { t } = useTranslation('common')
  const { logout } = useAuth()
  const isMobile = useIsMobile()
  const {
    state,
    cloudWorkStatus,
    selectProject,
    startNewChat,
    startStandaloneChat,
    startNewProjectChat,
    openRuntimeTask,
    renameRuntimeTask,
    archiveRuntimeTask,
    archiveProjectConversations,
    archiveProjectsConversations,
    archiveChatConversations,
    selectStandaloneDevice,
    openStandaloneWorkspace,
    getRemoteDeviceStartupCommand,
    refreshDevices,
    createProject,
    createGitWorkspaceProject,
    prepareDeviceWorkspace,
    deleteDeviceWorkspace,
    searchRuntimeWork,
    listGitRepositories,
    listGitBranches,
    updateProjectName,
    removeProject,
    getDeviceHomeDirectory,
    getProjectWorkspaceRoot,
    listDeviceDirectories,
    createDeviceDirectory,
  } = useWorkbench()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const { sidebarCollapsed, setSidebarCollapsed } = useDesktopSidebarCollapsed()
  const isTauri = isTauriRuntime()

  const handleSelectProject = (projectId: number) => {
    navigateTo('/')
    selectProject(projectId)
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

    return <ConnectionsSettingsPage onBack={() => setSettingsOpen(false)} />
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
    <div className="flex h-full overflow-hidden bg-background text-text-primary">
      {!isMobile && (
        <DesktopSidebar
          user={state.user}
          projects={state.projects}
          devices={state.devices}
          runtimeWork={state.runtimeWork}
          currentRuntimeTask={state.currentRuntimeTask}
          cloudWorkStatus={cloudWorkStatus}
          standaloneDeviceId={state.standaloneDeviceId}
          standaloneWorkspacePath={state.standaloneWorkspacePath}
          preferredDeviceId={
            state.standaloneDeviceId ?? state.user?.preferences?.default_execution_target
          }
          activeItem="plugins"
          collapsed={sidebarCollapsed}
          onNewChat={handleNewChat}
          onOpenSearch={() => setSearchOpen(true)}
          onSelectProject={handleSelectProject}
          onStartNewProjectChat={handleStartNewProjectChat}
          onOpenRuntimeTask={openRuntimeTask}
          onRenameRuntimeTask={renameRuntimeTask}
          onArchiveRuntimeTask={archiveRuntimeTask}
          onArchiveProjectConversations={archiveProjectConversations}
          onArchiveProjectsConversations={archiveProjectsConversations}
          onArchiveChatConversations={archiveChatConversations}
          onOpenStandaloneWorkspace={openStandaloneWorkspace}
          onSelectStandaloneDevice={selectStandaloneDevice}
          onGetRemoteDeviceStartupCommand={getRemoteDeviceStartupCommand}
          onOpenPlugins={handleOpenPlugins}
          onRefreshDevices={refreshDevices}
          onUpdateProjectName={updateProjectName}
          onRemoveProject={removeProject}
          onGetDeviceHomeDirectory={getDeviceHomeDirectory}
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
            devices={state.devices}
            projects={state.projects}
            runtimeWork={state.runtimeWork}
            currentProjectId={state.currentProject?.id}
            currentRuntimeTask={state.currentRuntimeTask}
            activeItem="plugins"
            onClose={() => setDrawerOpen(false)}
            onNewChat={handleNewChat}
            onStartStandaloneChat={handleStartStandaloneChat}
            onOpenSettings={() => setSettingsOpen(true)}
            onSelectProject={handleSelectProject}
            onOpenRuntimeTask={openRuntimeTask}
            onCreateProject={createProject}
            onCreateGitWorkspaceProject={createGitWorkspaceProject}
            onPrepareDeviceWorkspace={prepareDeviceWorkspace}
            onDeleteDeviceWorkspace={deleteDeviceWorkspace}
            onListGitRepositories={listGitRepositories}
            onListGitBranches={listGitBranches}
            onUpdateProjectName={updateProjectName}
            onRemoveProject={removeProject}
            onGetDeviceHomeDirectory={getDeviceHomeDirectory}
            onGetProjectWorkspaceRoot={getProjectWorkspaceRoot}
            onListDeviceDirectories={listDeviceDirectories}
            onCreateDeviceDirectory={createDeviceDirectory}
          />
        </>
      )}
      <PluginManagementWorkspace
        sidebarCollapsed={sidebarCollapsed && !isMobile}
        topBarLeftActions={
          !isMobile && sidebarCollapsed && !isTauri ? (
            <DesktopWindowControls
              sidebarCollapsed
              onToggleSidebar={() => setSidebarCollapsed(false)}
              onNewChat={handleNewChat}
            />
          ) : !isMobile && !isTauri ? (
            <DesktopWindowControls
              sidebarCollapsed={false}
              onToggleSidebar={() => setSidebarCollapsed(true)}
            />
          ) : undefined
        }
      />
      <WorkbenchSearchDialog
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
        onSearchRuntimeWork={searchRuntimeWork}
        onOpenRuntimeTask={async address => {
          await openRuntimeTask(address)
        }}
      />
    </div>
  )
}
