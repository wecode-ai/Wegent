import { lazy, Suspense, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Menu } from 'lucide-react'
import { DesktopSidebar } from '@/components/layout/DesktopSidebar'
import { DesktopCollapsedSidebarToggle } from '@/components/layout/DesktopCollapsedSidebarToggle'
import { DesktopWindowControls } from '@/components/layout/DesktopWindowControls'
import { MobileDrawer } from '@/components/layout/MobileDrawer'
import { useDesktopSidebarCollapsed } from '@/components/layout/useDesktopSidebarCollapsed'
import { WorkbenchSearchDialog } from '@/components/layout/WorkbenchSearchDialog'
import { ConnectionsSettingsPage } from '@/components/settings/ConnectionsSettingsPage'
import { MobileSettingsPage } from '@/components/settings/MobileSettingsPage'
import { useAuth } from '@/features/auth/useAuth'
import { useOptionalCloudConnection } from '@/features/cloud-connection/useCloudConnection'
import { useWorkbench } from '@/features/workbench/useWorkbench'
import { useIsMobile } from '@/hooks/useIsMobile'
import { useTranslation } from '@/hooks/useTranslation'
import { navigateTo } from '@/lib/navigation'
import { isTauriRuntime } from '@/lib/runtime-environment'
import { getRuntimeConfig } from '@/config/runtime'
import { parsePluginDetailRoute } from '@/features/plugins/pluginNavigation'
import { track } from '@/telemetry/client'
import { createPluginRouteRuntimeTaskOpener } from './plugin-route-navigation'

const PluginsWorkspace = lazy(() =>
  import('@/components/plugins/PluginsWorkspace').then(module => ({
    default: module.PluginsWorkspace,
  }))
)
function PluginsWorkspaceRouteFallback({
  sidebarCollapsed,
  topBarLeftActions,
}: {
  sidebarCollapsed: boolean
  topBarLeftActions?: ReactNode
}) {
  return (
    <main
      data-testid="plugins-route-loading"
      className="min-w-0 flex-1 overflow-y-auto bg-background text-text-primary"
    >
      <div
        className={[
          'mx-auto flex w-full max-w-[1120px] flex-col gap-7 px-5 pb-14 pt-6 md:px-10 md:pt-7',
          sidebarCollapsed ? 'md:pl-6' : 'md:pl-7',
        ].join(' ')}
      >
        {topBarLeftActions ? (
          <div className="flex min-h-8 items-center gap-2">{topBarLeftActions}</div>
        ) : null}
        <section className="space-y-2">
          <h1 className="heading-medium text-text-primary">插件市场</h1>
          <p className="text-base leading-6 text-text-secondary">
            发现并接入开发工具、企业数据和专业方法。
          </p>
        </section>
        <div className="h-11 w-full animate-pulse rounded-full bg-surface" />
        <div className="space-y-8 border-t border-border pt-8">
          {['Featured', 'Productivity'].map(section => (
            <section key={section} className="space-y-4">
              <div className="border-b border-border pb-3">
                <div className="h-5 w-28 animate-pulse rounded-md bg-surface" />
              </div>
              <div className="grid grid-cols-1 gap-x-10 gap-y-3 sm:grid-cols-2">
                {Array.from({ length: 4 }).map((_, index) => (
                  <div
                    key={index}
                    className="grid min-h-[66px] grid-cols-[44px_minmax(0,1fr)_72px] items-center gap-3 rounded-lg px-2 py-2"
                  >
                    <div className="h-10 w-10 animate-pulse rounded-lg bg-surface" />
                    <div className="space-y-2">
                      <div className="h-4 w-32 animate-pulse rounded-md bg-surface" />
                      <div className="h-3 w-44 max-w-full animate-pulse rounded-md bg-surface" />
                    </div>
                    <div className="h-8 animate-pulse rounded-xl bg-surface" />
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>
    </main>
  )
}

export function PluginsPage({ routeSearch = '' }: { routeSearch?: string }) {
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
  const handleOpenRuntimeTask = createPluginRouteRuntimeTaskOpener(openRuntimeTask)

  useEffect(() => {
    track('plugin_center_opened', { surface: 'catalog' })
  }, [])

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
    <div className="relative flex h-full flex-col overflow-hidden bg-background text-text-primary">
      <div className="flex flex-1 overflow-hidden">
        {!isMobile && isTauri && (
          <DesktopCollapsedSidebarToggle
            collapsed={sidebarCollapsed}
            onToggle={() => setSidebarCollapsed(false)}
          />
        )}
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
            onToggleSidebar={() => setSidebarCollapsed(!sidebarCollapsed)}
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
            onGetRemoteDeviceStartupCommand={getRemoteDeviceStartupCommand}
            onOpenPlugins={handleOpenPlugins}
            onRefreshDevices={refreshDevices}
            onUpdateProjectName={updateProjectName}
            onRemoveProject={removeProject}
            onGetDeviceHomeDirectory={getDeviceHomeDirectory}
            onListDeviceDirectories={listDeviceDirectories}
            onCreateDeviceDirectory={createDeviceDirectory}
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
        <Suspense
          fallback={
            <PluginsWorkspaceRouteFallback
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
          }
        >
          <PluginsWorkspace
            pluginReference={parsePluginDetailRoute(routeSearch)}
            cloudMarketplaceAvailable={true}
            cloudApiBaseUrl={cloudConnection.apiBaseUrl || getRuntimeConfig().apiBaseUrl}
            cloudToken={cloudConnection.token}
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
        </Suspense>
        <WorkbenchSearchDialog
          open={searchOpen}
          onClose={() => setSearchOpen(false)}
          onSearchRuntimeWork={searchRuntimeWork}
          onOpenRuntimeTask={handleOpenRuntimeTask}
        />
      </div>
    </div>
  )
}
