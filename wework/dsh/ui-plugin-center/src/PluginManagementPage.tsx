import { createPluginRouteRuntimeTaskOpener } from './plugin-route-navigation'
import { DesktopSidebar } from '@/components/layout/DesktopSidebar'
import { DesktopWindowControls } from '@/components/layout/DesktopWindowControls'
import { MobileDrawer } from '@/components/layout/MobileDrawer'
import { useDesktopSidebarCollapsed } from '@/components/layout/useDesktopSidebarCollapsed'
import { WorkbenchSearchDialog } from '@/components/layout/WorkbenchSearchDialog'
import { PluginManagementWorkspace } from '@/components/plugins/PluginManagementWorkspace'
import { ConnectionsSettingsPage } from '@/components/settings/ConnectionsSettingsPage'
import { MobileSettingsPage } from '@/components/settings/MobileSettingsPage'
import { useAuth } from '@/features/auth/useAuth'
import { useOptionalCloudConnection } from '@/features/cloud-connection/useCloudConnection'
import { initializePluginDevelopmentProject } from '@/features/dsh-plugins/pluginDevelopment'
import { pluginDevelopmentInitialInput } from '@/features/dsh-plugins/pluginDevelopment'
import { useWorkbench } from '@/features/workbench/useWorkbench'
import { useIsMobile } from '@/hooks/useIsMobile'
import { useTranslation } from '@/hooks/useTranslation'
import { getPreferredStandaloneDeviceId } from '@/lib/device-selection'
import { openNativeDirectoryPicker } from '@/lib/native-directory-picker'
import { navigateTo } from '@/lib/navigation'
import { isElectronRuntime } from '@/lib/runtime-environment'
import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import { Menu } from 'lucide-react'
import { useState } from 'react'

export function PluginManagementPage() {
  const { t } = useTranslation('common')
  const { logout } = useAuth()
  const cloudConnection = useOptionalCloudConnection()
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
    cloneGitRepository,
  } = useWorkbench()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const { sidebarCollapsed, setSidebarCollapsed } = useDesktopSidebarCollapsed()
  const isDesktop = isElectronRuntime()
  const handleOpenRuntimeTask = createPluginRouteRuntimeTaskOpener(openRuntimeTask)

  const handleSelectProject = (projectId: number) => {
    navigateTo('/')
    selectProject(projectId)
  }

  if (settingsOpen) {
    if (isMobile) {
      return <MobileSettingsPage onBack={() => setSettingsOpen(false)} />
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

  const handleCreateWeworkPlugin = async () => {
    const sourceRoot = await openNativeDirectoryPicker()
    if (!sourceRoot) return
    const deviceId = getPreferredStandaloneDeviceId(
      state.devices,
      state.standaloneDeviceId ?? state.user?.preferences?.default_execution_target
    )
    if (!deviceId) throw new Error(t('workbench.no_local_device', '没有可用的本地设备'))
    const plugin = await initializePluginDevelopmentProject(sourceRoot)
    await openStandaloneWorkspace(
      deviceId,
      plugin.sourceRoot,
      plugin.displayName,
      [plugin.sourceRoot],
      {
        initialInput: pluginDevelopmentInitialInput(
          t('workbench.plugin_development_name', 'Wework 插件开发'),
          t('workbench.plugin_development_initial_prompt', '开发这个 Wework 插件：')
        ),
        rightSidebarTab: { type: 'wework-plugin-developer.debug' },
      }
    )
  }

  const topBarLeftActions =
    !isMobile && sidebarCollapsed && !isDesktop ? (
      <DesktopWindowControls
        sidebarCollapsed
        onToggleSidebar={() => setSidebarCollapsed(false)}
        onNewChat={handleNewChat}
      />
    ) : !isMobile && !isDesktop ? (
      <DesktopWindowControls
        sidebarCollapsed={false}
        onToggleSidebar={() => setSidebarCollapsed(true)}
      />
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
          activeItem="plugins"
          collapsed={sidebarCollapsed}
          onNewChat={handleNewChat}
          onStartStandaloneChat={handleStartStandaloneChat}
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
          onRefreshDevices={refreshDevices}
          onUpdateProjectName={updateProjectName}
          onRemoveProject={removeProject}
          onGetDeviceHomeDirectory={getDeviceHomeDirectory}
          onListDeviceDirectories={listDeviceDirectories}
          onCreateDeviceDirectory={createDeviceDirectory}
          onCloneGitRepository={cloneGitRepository}
          onOpenSettings={options => {
            if (options?.settingsPage) {
              navigateTo(`/settings/${options.settingsPage}`)
              return
            }
            setSettingsOpen(true)
          }}
          onLogout={logout}
        />
      )}
      {isMobile && (
        <>
          <header className="pointer-events-none absolute left-5 top-[max(8px,env(safe-area-inset-top))] z-chrome flex h-11 items-center">
            <ControlButton
              variant="unstyled"
              type="button"
              data-testid="open-mobile-drawer-button"
              onClick={() => setDrawerOpen(true)}
              className="pointer-events-auto flex h-11 min-w-[44px] items-center justify-center rounded-lg bg-surface text-text-primary transition-colors hover:bg-muted"
              aria-label={t('workbench.open_menu', '打开菜单')}
            >
              <Menu className="h-5 w-5" />
            </ControlButton>
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
      <PluginManagementWorkspace
        cloudApiBaseUrl={cloudConnection.apiBaseUrl}
        cloudToken={cloudConnection.token}
        sidebarCollapsed={sidebarCollapsed && !isMobile}
        topBarLeftActions={topBarLeftActions}
        onCreateWeworkPlugin={handleCreateWeworkPlugin}
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
