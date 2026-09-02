import { useEffect, useMemo, useState } from 'react'
import { Menu } from 'lucide-react'
import { ApiError, createHttpClient } from '@/api/http'
import { createPluginApi } from '@/api/plugins'
import { createSitesApi, createUnavailableSitesApi } from '@/api/sites'
import { createSmartAppsApi } from '@/api/smartApps'
import type { Site, SiteAppType } from '@/api/sites'
import { DesktopSidebar } from '@/components/layout/DesktopSidebar'
import { DesktopCollapsedSidebarToggle } from '@/components/layout/DesktopCollapsedSidebarToggle'
import { DesktopWindowControls } from '@/components/layout/DesktopWindowControls'
import { MobileDrawer } from '@/components/layout/MobileDrawer'
import { useDesktopSidebarCollapsed } from '@/components/layout/useDesktopSidebarCollapsed'
import { WorkbenchSearchDialog } from '@/components/layout/WorkbenchSearchDialog'
import { ConnectionsSettingsPage } from '@/components/settings/ConnectionsSettingsPage'
import { MobileSettingsPage } from '@/components/settings/MobileSettingsPage'
import { SitesWorkspace } from '@/components/sites/SitesWorkspace'
import { getApplicationTypeDefinition } from '@/components/sites/applicationTypeDefinitions'
import type { ApplicationCreateStrategy } from '@/components/sites/applicationTypeDefinitions'
import { getRuntimeConfig } from '@/config/runtime'
import { useAuth } from '@/features/auth/useAuth'
import { useCloudConnection } from '@/features/cloud-connection/useCloudConnection'
import { useExperimentalFeaturesState } from '@/features/experimental-features/useExperimentalFeaturesEnabled'
import { useWorkbench } from '@/features/workbench/useWorkbench'
import { useIsMobile } from '@/hooks/useIsMobile'
import { useTranslation } from '@/hooks/useTranslation'
import { managedMarketplaceName } from '@/features/plugins/pluginMarketplaceIdentity'
import {
  notifyLocalPluginSkillsChanged,
  queuePluginInputTrial,
  queuePluginTrial,
} from '@/features/plugins/pluginTrial'
import { getPreferredStandaloneDeviceId } from '@/lib/device-selection'
import { buildRuntimeTaskRoute, navigateTo } from '@/lib/navigation'
import { isElectronRuntime } from '@/lib/runtime-environment'
import { isLocalFirstAppRuntime } from '@/lib/runtime-mode'
import type {
  DeviceCapabilityItemResult,
  DeviceCapabilitySyncResponse,
  InstalledPlugin,
  RuntimeTaskAddress,
} from '@/types/api'
import { SmartAppsMarketplacePage } from './SmartAppsMarketplacePage'

class ApplicationPluginSyncConfirmationError extends Error {}

interface PreparedApplicationPlugin {
  plugin: InstalledPlugin
  pluginName: string
  marketplaceName: string
}

function sanitizeMarkdownLinkLabel(value: string): string {
  return value
    .replace(/[\r\n]+/g, ' ')
    .replace(/\[/g, ' ')
    .replace(/]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function buildSiteContinueDevelopmentInput(
  site: Pick<Site, 'name' | 'project_id' | 'siteid'>,
  suffix: string
): string | null {
  const projectId = String(site.project_id || site.siteid || '').trim()
  if (!projectId) return null
  const label = sanitizeMarkdownLinkLabel(site.name) || projectId
  const normalizedSuffix = suffix.trim()
  return `[${label}](wegent-sites-project://${encodeURIComponent(projectId)})${
    normalizedSuffix ? ` ${normalizedSuffix}` : ''
  }`
}

function installedPluginId(plugin: InstalledPlugin): string | null {
  const labels =
    plugin.metadata.labels && typeof plugin.metadata.labels === 'object'
      ? (plugin.metadata.labels as Record<string, unknown>)
      : null
  const value = labels?.id
  return typeof value === 'string' || typeof value === 'number' ? String(value) : null
}

function pluginSourcePayload(plugin: InstalledPlugin): Record<string, unknown> {
  const payload = plugin.spec.sourcePayload
  return payload && typeof payload === 'object' ? payload : {}
}

function installedPluginMarketplaces(plugin: InstalledPlugin): string[] {
  const payload = pluginSourcePayload(plugin)
  const metadataNamespace =
    typeof plugin.metadata.namespace === 'string' && plugin.metadata.namespace !== 'default'
      ? plugin.metadata.namespace
      : null
  return [
    typeof payload.marketplaceName === 'string' ? payload.marketplaceName : null,
    managedMarketplaceName(plugin),
    plugin.spec.source.marketplace,
    metadataNamespace,
  ]
    .map(candidate => String(candidate ?? '').trim())
    .filter(
      (candidate, index, candidates) =>
        candidate.length > 0 && candidates.indexOf(candidate) === index
    )
}

function installedPluginMatches(
  plugin: InstalledPlugin,
  pluginName: string,
  marketplaceName: string
): boolean {
  const manifestName = plugin.spec.manifest?.name
  const payload = pluginSourcePayload(plugin)
  const nameCandidates = [
    plugin.spec.source.pluginKey,
    payload.pluginName,
    payload.remotePluginId,
    plugin.metadata.name,
    manifestName,
  ]
  const nameMatches = nameCandidates.some(
    candidate => String(candidate ?? '').trim() === pluginName
  )
  const marketplaceMatches = installedPluginMarketplaces(plugin).some(
    candidate => candidate === marketplaceName
  )
  return nameMatches && marketplaceMatches
}

function applicationPluginReferenceName(plugin: InstalledPlugin, fallback: string): string {
  const manifestName = plugin.spec.manifest?.name
  const payload = pluginSourcePayload(plugin)
  const candidates = [
    plugin.spec.displayName,
    plugin.spec.interface?.displayName,
    plugin.spec.source.pluginKey,
    payload.pluginName,
    payload.remotePluginId,
    plugin.metadata.name,
    manifestName,
    fallback,
  ]
  return (
    candidates
      .map(candidate => String(candidate ?? '').trim())
      .find(candidate => candidate.length > 0) ?? fallback
  )
}

function isPluginInstalledOnDevice(plugin: InstalledPlugin, deviceId: string): boolean {
  const accountInstalled =
    plugin.spec.installState === 'installed' || plugin.spec.installState === 'update_available'
  if (!accountInstalled || !plugin.spec.enabled) return false
  return (
    plugin.status.devices?.some(
      device => device.deviceId === deviceId && device.state === 'installed'
    ) ?? false
  )
}

function findInstalledApplicationPlugin(
  plugins: readonly InstalledPlugin[],
  pluginName: string,
  marketplaceName: string,
  deviceId: string
): InstalledPlugin | null {
  return (
    plugins.find(
      plugin =>
        installedPluginMatches(plugin, pluginName, marketplaceName) &&
        isPluginInstalledOnDevice(plugin, deviceId)
    ) ?? null
  )
}

function syncedPluginItemMatches(
  item: DeviceCapabilityItemResult,
  pluginName: string,
  pluginId: string | null
): boolean {
  if (item.status !== 'synced') return false
  return (
    String(item.name ?? '').trim() === pluginName ||
    (pluginId !== null && String(item.id ?? '') === pluginId)
  )
}

function isApplicationPluginSyncConfirmed(
  sync: DeviceCapabilitySyncResponse | null | undefined,
  plugin: InstalledPlugin,
  pluginName: string,
  deviceId: string
): boolean {
  if (!sync) return false
  const pluginId = installedPluginId(plugin)
  const targetResult = Array.isArray(sync.results)
    ? sync.results.find(result => result.device_id === deviceId)
    : null
  if (targetResult) {
    return (
      targetResult.success &&
      targetResult.plugins.some(item => syncedPluginItemMatches(item, pluginName, pluginId))
    )
  }
  return (
    sync.success &&
    sync.failed === 0 &&
    sync.skipped === 0 &&
    (sync.device_id === deviceId || !sync.device_id) &&
    sync.plugins.some(item => syncedPluginItemMatches(item, pluginName, pluginId))
  )
}

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
  const [createError, setCreateError] = useState<string | null>(null)
  const [createNotice, setCreateNotice] = useState<string | null>(null)
  const [creatingType, setCreatingType] = useState<SiteAppType | null>(null)
  const [continuingSiteId, setContinuingSiteId] = useState<string | null>(null)
  const { sidebarCollapsed, setSidebarCollapsed } = useDesktopSidebarCollapsed()
  const searchParams = new URLSearchParams(search)
  const smartAppsRequested = searchParams.get('app_type') === 'smart_app'
  const smartAppsView = searchParams.get('view')

  useEffect(() => {
    if (smartAppsRequested && experimentalFeatures.loaded && !experimentalFeatures.enabled) {
      navigateTo('/sites')
    }
  }, [experimentalFeatures.enabled, experimentalFeatures.loaded, smartAppsRequested])
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

  const prepareApplicationPlugin = async (
    createStrategy: ApplicationCreateStrategy
  ): Promise<PreparedApplicationPlugin | null> => {
    if (!createStrategy.pluginName || !createStrategy.marketplaceName) {
      setCreateError(
        t('plugin_create_configuration_missing', '应用创建插件配置尚未同步，请刷新后重试')
      )
      return null
    }
    if (!pluginApi) {
      setCreateError(t('plugin_cloud_unavailable', '连接云端后才能使用应用创建插件'))
      return null
    }
    const targetDeviceId = getPreferredStandaloneDeviceId(
      state.devices,
      state.standaloneDeviceId ?? state.user?.preferences?.default_execution_target
    )
    if (!targetDeviceId) {
      setCreateError(t('plugin_device_unavailable', '请选择一个在线且版本兼容的设备后再创建应用'))
      return null
    }

    const installedPlugins = await pluginApi.listInstalledPlugins(targetDeviceId).catch(error => {
      console.warn('[Wework Applications] failed to inspect local plugin installation', error)
      return { items: [] }
    })
    const locallyInstalledPlugin = findInstalledApplicationPlugin(
      installedPlugins.items,
      createStrategy.pluginName,
      createStrategy.marketplaceName,
      targetDeviceId
    )
    const plugin = locallyInstalledPlugin
    if (!plugin) {
      setCreateNotice(t('plugin_installing', '正在安装应用插件，完成后将进入会话...'))
    }
    const prepared = plugin
      ? { plugin, sync: null }
      : await pluginApi.ensureBuiltinPluginInstalled(createStrategy.pluginName, {
          deviceId: targetDeviceId,
        })
    const syncConfirmed =
      locallyInstalledPlugin !== null ||
      isPluginInstalledOnDevice(prepared.plugin, targetDeviceId) ||
      isApplicationPluginSyncConfirmed(
        prepared.sync,
        prepared.plugin,
        createStrategy.pluginName,
        targetDeviceId
      )
    if (!syncConfirmed) {
      throw new ApplicationPluginSyncConfirmationError(
        'The Backend did not confirm application plugin synchronization to the target device'
      )
    }
    return {
      plugin: prepared.plugin,
      pluginName: createStrategy.pluginName,
      marketplaceName: createStrategy.marketplaceName,
    }
  }

  const handleApplicationPluginError = (error: unknown) => {
    console.error('[Wework Applications] cloud plugin preparation failed', error)
    if (error instanceof ApiError && error.status === 404) {
      setCreateError(
        t(
          'plugin_backend_upgrade_required',
          '云端 Backend 尚未支持对应的应用插件，请先部署最新 Backend'
        )
      )
    } else if (error instanceof ApiError && error.status === 503) {
      setCreateError(
        t('plugin_not_published', '云端市场尚未发布对应的应用插件，请检查内置插件打包配置')
      )
    } else if (error instanceof ApiError && error.status === 409) {
      setCreateError(t('plugin_device_unavailable', '目标设备当前离线，请连接设备后重试'))
    } else if (error instanceof ApiError && error.status === 502) {
      setCreateError(t('plugin_device_sync_failed', '应用插件未能同步到目标设备，请检查设备后重试'))
    } else if (error instanceof ApplicationPluginSyncConfirmationError) {
      setCreateError(t('plugin_device_sync_failed', '应用插件未能同步到目标设备，请检查设备后重试'))
    } else {
      setCreateError(t('plugin_install_failed', '应用插件安装失败，请重试'))
    }
  }

  const handleCreate = async (appType: SiteAppType, createStrategy: ApplicationCreateStrategy) => {
    if (creatingType) return
    setCreatingType(appType)
    setCreateError(null)
    try {
      const definition = getApplicationTypeDefinition(appType)
      if (!definition) {
        setCreateError(t('unsupported_application_type', '当前版本不支持该应用类型'))
        return
      }
      const prepared = await prepareApplicationPlugin(createStrategy)
      if (!prepared) return
      const queued = queuePluginTrial(prepared.plugin, {
        openInNewChat: true,
        reference: {
          pluginName: prepared.pluginName,
          marketplaceName: prepared.marketplaceName,
          displayName: applicationPluginReferenceName(prepared.plugin, prepared.pluginName),
        },
      })
      if (!queued) {
        throw new Error('The installed application plugin cannot be referenced in chat')
      }

      notifyLocalPluginSkillsChanged()
      setCreateError(null)
      setCreateNotice(null)
      navigateTo('/')
    } catch (error) {
      handleApplicationPluginError(error)
    } finally {
      setCreateNotice(null)
      setCreatingType(null)
    }
  }

  const handleContinueDevelopment = async (
    site: Site,
    createStrategy: ApplicationCreateStrategy
  ) => {
    if (continuingSiteId) return
    setContinuingSiteId(site.siteid)
    setCreateError(null)
    try {
      const prepared = await prepareApplicationPlugin(createStrategy)
      if (!prepared) return
      const suffix = t('continue_development_prompt_suffix', '请说出你要做的改动')
      const input = buildSiteContinueDevelopmentInput(site, suffix)
      if (!input) {
        setCreateError(
          t('plugin_create_configuration_missing', '应用创建插件配置尚未同步，请刷新后重试')
        )
        return
      }
      const queued = queuePluginInputTrial(prepared.plugin, input, {
        openInNewChat: true,
        prompt: `${site.name} ${suffix}`,
      })
      if (!queued) {
        throw new Error('The installed application plugin cannot be referenced in chat')
      }

      notifyLocalPluginSkillsChanged()
      setCreateError(null)
      setCreateNotice(null)
      navigateTo('/')
    } catch (error) {
      handleApplicationPluginError(error)
    } finally {
      setCreateNotice(null)
      setContinuingSiteId(null)
    }
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
            onGetRemoteDeviceStartupCommand={getRemoteDeviceStartupCommand}
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
              <SmartAppsMarketplacePage api={smartAppsApi} mode="owned" onNavigate={onNavigate} />
            ) : (
              <SmartAppsMarketplacePage api={smartAppsApi} onNavigate={onNavigate} />
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
