import { createSitesPageSource } from './sitesPageSource'
import { SmartAppsMarketplacePage } from './SmartAppsMarketplacePage'
import { createHttpClient } from '@/api/http'
import { createLocalCodexPluginApi } from '@/api/local/codexPlugins'
import { createPluginApi } from '@/api/plugins'
import { createSitesApi } from '@/api/sites'
import { createUnavailableSitesApi } from '@/api/sites'
import { createSmartAppsApi } from '@/api/smartApps'
import { DesktopCollapsedSidebarToggle } from '@/components/layout/DesktopCollapsedSidebarToggle'
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
import { useCloudConnection } from '@/features/cloud-connection/useCloudConnection'
import { useExperimentalFeaturesState } from '@/features/experimental-features/useExperimentalFeaturesEnabled'
import { useWorkbench } from '@/features/workbench/useWorkbench'
import { useIsMobile } from '@/hooks/useIsMobile'
import { useTranslation } from '@/hooks/useTranslation'
import { getPreferredStandaloneDeviceId } from '@/lib/device-selection'
import { navigateTo } from '@/lib/navigation'
import { isElectronRuntime } from '@/lib/runtime-environment'
import { isLocalFirstAppRuntime } from '@/lib/runtime-mode'
import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import { Menu } from 'lucide-react'
import { useCallback } from 'react'
import { useMemo } from 'react'
import { useState } from 'react'
import { useSyncExternalStore } from 'react'

interface SitesPageProps {
  onNavigate?: (path: string) => void
  search?: string
}

export function SitesPage({ onNavigate, search = window.location.search }: SitesPageProps) {
  const { t } = useTranslation('sites')
  const { t: commonT } = useTranslation('common')
  const { logout } = useAuth()
  const cloudConnection = useCloudConnection()
  const experimentalFeatures = useExperimentalFeaturesState()
  const isMobile = useIsMobile()
  const isDesktop = isElectronRuntime()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const { sidebarCollapsed, setSidebarCollapsed } = useDesktopSidebarCollapsed()
  const searchParams = new URLSearchParams(search)
  const smartAppsView = searchParams.get('view')
  const requestedSmartAppId = searchParams.get('smartAppId') ?? ''
  const targetSmartAppId = /^[1-9]\d{0,15}$/.test(requestedSmartAppId)
    ? Number(requestedSmartAppId)
    : null

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

  const apiBaseUrl = getRuntimeConfig().apiBaseUrl
  const isLocalFirst = isLocalFirstAppRuntime()
  const sitesApi = useMemo(() => {
    if (!isLocalFirst) return createSitesApi(apiBaseUrl)
    if (!cloudConnection.isConnected || !cloudConnection.apiBaseUrl || !cloudConnection.token) {
      return createUnavailableSitesApi()
    }

    const token = cloudConnection.token
    return createSitesApi(cloudConnection.apiBaseUrl, {
      getToken: () => token,
      redirectOnUnauthorized: false,
    })
  }, [
    apiBaseUrl,
    cloudConnection.apiBaseUrl,
    cloudConnection.isConnected,
    cloudConnection.token,
    isLocalFirst,
  ])
  const localPluginApi = useMemo(() => createLocalCodexPluginApi(), [])
  const pluginApi = useMemo(() => {
    if (!isLocalFirst) {
      return createPluginApi(createHttpClient({ baseUrl: apiBaseUrl }), apiBaseUrl)
    }
    if (!cloudConnection.isConnected || !cloudConnection.apiBaseUrl || !cloudConnection.token) {
      return null
    }

    const token = cloudConnection.token
    return createPluginApi(
      createHttpClient({
        baseUrl: cloudConnection.apiBaseUrl,
        getToken: () => token,
        redirectOnUnauthorized: false,
      }),
      cloudConnection.apiBaseUrl
    )
  }, [
    apiBaseUrl,
    cloudConnection.apiBaseUrl,
    cloudConnection.isConnected,
    cloudConnection.token,
    isLocalFirst,
  ])
  const smartAppsApi = useMemo(() => {
    if (!isLocalFirst) {
      return createSmartAppsApi(createHttpClient({ baseUrl: apiBaseUrl }), apiBaseUrl)
    }
    if (!cloudConnection.isConnected || !cloudConnection.apiBaseUrl || !cloudConnection.token) {
      return null
    }
    const token = cloudConnection.token
    return createSmartAppsApi(
      createHttpClient({
        baseUrl: cloudConnection.apiBaseUrl,
        getToken: () => token,
        redirectOnUnauthorized: false,
      }),
      cloudConnection.apiBaseUrl
    )
  }, [
    apiBaseUrl,
    cloudConnection.apiBaseUrl,
    cloudConnection.isConnected,
    cloudConnection.token,
    isLocalFirst,
  ])

  const targetDeviceId = getPreferredStandaloneDeviceId(
    state.devices,
    state.standaloneDeviceId ?? state.user?.preferences?.default_execution_target
  )
  const runtimeInstance = state.devices.find(
    device => device.device_id === targetDeviceId
  )?.runtime_instance_id
  const [pageSource] = useState(createSitesPageSource)
  const owner = useMemo(
    () => ({
      sitesApi,
      pluginApi,
      localPluginApi,
      userId: state.user?.id,
      targetDeviceId,
      runtimeInstance,
      backendUrl: cloudConnection.apiBaseUrl,
      token: cloudConnection.token,
    }),
    [
      sitesApi,
      pluginApi,
      localPluginApi,
      state.user?.id,
      targetDeviceId,
      runtimeInstance,
      cloudConnection.apiBaseUrl,
      cloudConnection.token,
    ]
  )
  const pageView = useMemo(() => pageSource.observe(owner), [pageSource, owner])
  const subscribe = useCallback(
    (listener: () => void) =>
      pageView.subscribe(listener, { t, isDesktop, search, experimentalFeatures, openRuntimeTask }),
    [pageView, t, isDesktop, search, experimentalFeatures, openRuntimeTask]
  )
  const { createError, createNotice, creatingType, continuingSiteId } = useSyncExternalStore(
    subscribe,
    pageView.getSnapshot,
    pageView.getSnapshot
  )
  const handleCreate = pageView.create
  const handleContinueDevelopment = pageView.continueDevelopment
  const handleSelectProject = (projectId: number) => {
    navigateTo('/')
    selectProject(projectId)
  }

  const handleOpenRuntimeTask = pageView.openTask

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

  if (settingsOpen) {
    if (isMobile) {
      return <MobileSettingsPage onBack={() => setSettingsOpen(false)} />
    }
    return <ConnectionsSettingsPage onBack={() => setSettingsOpen(false)} />
  }

  const topBarLeftActions =
    !isMobile && !isDesktop ? (
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
    <div className="relative flex h-full flex-col overflow-hidden bg-background text-text-primary">
      <div className="flex flex-1 overflow-hidden">
        {!isMobile && isDesktop && (
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
            activeItem="sites"
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
                aria-label={commonT('workbench.open_menu', '打开菜单')}
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
          search={search}
          onCreate={handleCreate}
          onContinueDevelopment={handleContinueDevelopment}
          creatingType={creatingType}
          continuingSiteId={continuingSiteId}
          createError={createError}
          createNotice={createNotice}
          smartAppsEnabled={experimentalFeatures.enabled}
          smartAppsContent={
            smartAppsView === 'owned' ? (
              <SmartAppsMarketplacePage
                api={smartAppsApi}
                mode="owned"
                onNavigate={onNavigate}
                targetSmartAppId={targetSmartAppId}
              />
            ) : (
              <SmartAppsMarketplacePage
                api={smartAppsApi}
                onNavigate={onNavigate}
                targetSmartAppId={targetSmartAppId}
              />
            )
          }
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
    </div>
  )
}
