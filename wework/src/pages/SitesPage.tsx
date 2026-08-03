import { useMemo, useState } from 'react'
import { Menu } from 'lucide-react'
import { ApiError, createHttpClient } from '@/api/http'
import { createPluginApi } from '@/api/plugins'
import { createSitesApi, createUnavailableSitesApi } from '@/api/sites'
import { DesktopSidebar } from '@/components/layout/DesktopSidebar'
import { DesktopCollapsedSidebarToggle } from '@/components/layout/DesktopCollapsedSidebarToggle'
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
import { useWorkbench } from '@/features/workbench/useWorkbench'
import { useIsMobile } from '@/hooks/useIsMobile'
import { useTranslation } from '@/hooks/useTranslation'
import { notifyLocalPluginSkillsChanged, queuePluginTrial } from '@/features/plugins/pluginTrial'
import { WEGENT_SITES_PLUGIN_NAME } from '@/features/plugins/builtinPlugins'
import { getPreferredStandaloneDeviceId } from '@/lib/device-selection'
import { buildRuntimeTaskRoute, navigateTo } from '@/lib/navigation'
import { isTauriRuntime } from '@/lib/runtime-environment'
import { isLocalFirstAppRuntime } from '@/lib/runtime-mode'
import type { RuntimeTaskAddress } from '@/types/api'

class SitesDeviceSyncConfirmationError extends Error {}

export function SitesPage() {
  const { t } = useTranslation('sites')
  const { t: commonT } = useTranslation('common')
  const { logout } = useAuth()
  const cloudConnection = useCloudConnection()
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
  const pluginApi = useMemo(() => {
    if (!isLocalFirst) {
      return createPluginApi(createHttpClient({ baseUrl: apiBaseUrl }))
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
      })
    )
  }, [
    apiBaseUrl,
    cloudConnection.apiBaseUrl,
    cloudConnection.isConnected,
    cloudConnection.token,
    isLocalFirst,
  ])

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
    if (creating) return
    setCreating(true)
    try {
      if (!pluginApi) {
        setCreateError(t('plugin_cloud_unavailable', '连接云端后才能使用 Sites 插件'))
        return
      }
      const targetDeviceId = getPreferredStandaloneDeviceId(
        state.devices,
        state.standaloneDeviceId ?? state.user?.preferences?.default_execution_target
      )
      if (!targetDeviceId) {
        setCreateError(t('plugin_device_unavailable', '请选择一个在线且版本兼容的设备后再创建站点'))
        return
      }

      const { plugin, sync } = await pluginApi.ensureBuiltinPluginInstalled(
        WEGENT_SITES_PLUGIN_NAME,
        { deviceId: targetDeviceId }
      )
      const sitesPluginSynced = sync?.plugins.some(
        item => item.name === WEGENT_SITES_PLUGIN_NAME && item.status === 'synced'
      )
      if (
        !sync?.success ||
        sync.mode !== 'merge' ||
        sync.synced !== 1 ||
        sync.failed !== 0 ||
        sync.skipped !== 0 ||
        !sitesPluginSynced
      ) {
        throw new SitesDeviceSyncConfirmationError(
          'The Backend did not confirm Sites synchronization to the target device'
        )
      }
      if (!queuePluginTrial(plugin)) {
        throw new Error('The installed Sites plugin cannot be referenced in chat')
      }

      notifyLocalPluginSkillsChanged()
      setCreateError(null)
      navigateTo('/')
    } catch (error) {
      console.error('[Wework Sites] cloud plugin preparation failed', error)
      if (error instanceof ApiError && error.status === 404) {
        setCreateError(
          t(
            'plugin_backend_upgrade_required',
            '云端 Backend 尚未升级 Sites 插件，请先部署最新 Backend'
          )
        )
      } else if (error instanceof ApiError && error.status === 503) {
        setCreateError(
          t('plugin_not_published', '云端市场尚未发布 Sites 插件，请检查内置插件打包配置')
        )
      } else if (error instanceof ApiError && error.status === 409) {
        setCreateError(t('plugin_device_unavailable', '目标设备当前离线，请连接设备后重试'))
      } else if (error instanceof ApiError && error.status === 502) {
        setCreateError(
          t('plugin_device_sync_failed', 'Sites 插件未能同步到目标设备，请检查设备后重试')
        )
      } else if (error instanceof SitesDeviceSyncConfirmationError) {
        setCreateError(
          t('plugin_device_sync_failed', 'Sites 插件未能同步到目标设备，请检查设备后重试')
        )
      } else {
        setCreateError(t('plugin_install_failed', 'Sites 插件安装失败，请重试'))
      }
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
            onGetRemoteDeviceStartupCommand={getRemoteDeviceStartupCommand}
            onOpenPlugins={() => navigateTo('/plugins')}
            onOpenSites={() => navigateTo('/sites')}
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
    </div>
  )
}
