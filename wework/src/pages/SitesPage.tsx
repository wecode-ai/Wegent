import { useMemo, useState } from 'react'
import { Menu } from 'lucide-react'
import { createSitesApi, type SitesApi } from '@/api/sites'
import { DesktopSidebar } from '@/components/layout/DesktopSidebar'
import { DesktopWindowControls } from '@/components/layout/DesktopWindowControls'
import { MobileDrawer } from '@/components/layout/MobileDrawer'
import { useDesktopSidebarCollapsed } from '@/components/layout/useDesktopSidebarCollapsed'
import { WorkbenchSearchDialog } from '@/components/layout/WorkbenchSearchDialog'
import { ConnectionsSettingsPage } from '@/components/settings/ConnectionsSettingsPage'
import { MobileSettingsPage } from '@/components/settings/MobileSettingsPage'
import { SitesWorkspace } from '@/components/sites/SitesWorkspace'
import { getRuntimeConfig } from '@/config/runtime'
import { useAuth } from '@/features/auth/useAuth'
import { useWorkbench } from '@/features/workbench/useWorkbench'
import { useIsMobile } from '@/hooks/useIsMobile'
import { useTranslation } from '@/hooks/useTranslation'
import { buildRuntimeTaskRoute, navigateTo } from '@/lib/navigation'
import { isTauriRuntime } from '@/lib/runtime-environment'
import type { RuntimeTaskAddress } from '@/types/api'

function createUnavailableSitesApi(message: string): SitesApi {
  return {
    listSites: () => Promise.reject(new Error(message)),
    publishSite: () => Promise.reject(new Error(message)),
    deleteSite: () => Promise.reject(new Error(message)),
  }
}

export function SitesPage() {
  const { t } = useTranslation('sites')
  const { t: commonT } = useTranslation('common')
  const { user: authUser, logout } = useAuth()
  const isMobile = useIsMobile()
  const isTauri = isTauriRuntime()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const { sidebarCollapsed, setSidebarCollapsed } = useDesktopSidebarCollapsed()
  const {
    state,
    cloudWorkStatus,
    selectProject,
    startNewChat,
    startNewSkillChat,
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

  const sitesApiBaseUrl = getRuntimeConfig().sitesApiBaseUrl
  const sitesApi = useMemo(
    () =>
      sitesApiBaseUrl
        ? createSitesApi(sitesApiBaseUrl)
        : createUnavailableSitesApi('VITE_SITES_API_BASE_URL is not configured'),
    [sitesApiBaseUrl]
  )
  const username = state.user?.user_name?.trim() || authUser?.user_name?.trim() || ''

  const handleSelectProject = (projectId: number) => {
    navigateTo('/')
    selectProject(projectId)
  }

  const handleOpenRuntimeTask = async (address: RuntimeTaskAddress) => {
    await openRuntimeTask(address)
    navigateTo(buildRuntimeTaskRoute(address))
  }

  const handleNewChat = () => {
    navigateTo('/')
    startNewChat()
  }

  const handleStartStandaloneChat = () => {
    navigateTo('/')
    startStandaloneChat()
  }

  const handleStartNewProjectChat = (projectId: number) => {
    navigateTo('/')
    startNewProjectChat(projectId)
  }

  const handleCreate = async () => {
    setCreating(true)
    try {
      const started = await startNewSkillChat(['sites:sites-building'])
      setCreateError(started ? null : t('skill_missing', 'Sites 插件尚未安装或启用'))
    } catch {
      setCreateError(t('skill_missing', 'Sites 插件尚未安装或启用'))
    } finally {
      setCreating(false)
    }
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
    return <ConnectionsSettingsPage onBack={() => setSettingsOpen(false)} />
  }

  const topBarLeftActions =
    !isMobile && !isTauri ? (
      sidebarCollapsed ? (
        <DesktopWindowControls
          sidebarCollapsed
          onToggleSidebar={() => setSidebarCollapsed(false)}
          onNewChat={handleNewChat}
        />
      ) : (
        <DesktopWindowControls
          sidebarCollapsed={false}
          onToggleSidebar={() => setSidebarCollapsed(true)}
        />
      )
    ) : undefined

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
          activeItem="sites"
          collapsed={sidebarCollapsed}
          onNewChat={handleNewChat}
          onOpenSearch={() => setSearchOpen(true)}
          onSelectProject={handleSelectProject}
          onStartNewProjectChat={handleStartNewProjectChat}
          onOpenRuntimeTask={handleOpenRuntimeTask}
          onRenameRuntimeTask={renameRuntimeTask}
          onArchiveRuntimeTask={archiveRuntimeTask}
          onArchiveProjectConversations={archiveProjectConversations}
          onArchiveProjectsConversations={archiveProjectsConversations}
          onArchiveChatConversations={archiveChatConversations}
          onOpenStandaloneWorkspace={openStandaloneWorkspace}
          onSelectStandaloneDevice={selectStandaloneDevice}
          onGetRemoteDeviceStartupCommand={getRemoteDeviceStartupCommand}
          onOpenPlugins={() => navigateTo('/plugins')}
          onOpenSites={() => navigateTo('/sites')}
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
              aria-label={commonT('workbench.open_menu', '打开菜单')}
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
            activeItem="sites"
            onClose={() => setDrawerOpen(false)}
            onNewChat={handleNewChat}
            onStartStandaloneChat={handleStartStandaloneChat}
            onOpenSettings={() => setSettingsOpen(true)}
            onSelectProject={handleSelectProject}
            onOpenRuntimeTask={handleOpenRuntimeTask}
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
      <SitesWorkspace
        api={sitesApi}
        username={username}
        onCreate={handleCreate}
        creating={creating}
        createError={createError}
        onOpenPlugins={() => navigateTo('/plugins')}
        sidebarCollapsed={sidebarCollapsed && !isMobile}
        topBarLeftActions={topBarLeftActions}
      />
      <WorkbenchSearchDialog
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
        onSearchRuntimeWork={searchRuntimeWork}
        onOpenRuntimeTask={handleOpenRuntimeTask}
      />
    </div>
  )
}
