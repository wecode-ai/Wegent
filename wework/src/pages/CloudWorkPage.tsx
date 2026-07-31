import { Cloud, FolderGit2, Menu, Plus, Settings } from 'lucide-react'
import { useMemo, useState } from 'react'
import { DesktopSidebar } from '@/components/layout/DesktopSidebar'
import { DesktopCollapsedSidebarToggle } from '@/components/layout/DesktopCollapsedSidebarToggle'
import { DesktopWindowsTitlebar } from '@/components/layout/DesktopWindowsTitlebar'
import { MobileDrawer } from '@/components/layout/MobileDrawer'
import { WorkbenchSearchDialog } from '@/components/layout/WorkbenchSearchDialog'
import { requestProjectCreateMode } from '@/components/layout/workbenchShellEvents'
import { DeviceSection } from '@/components/settings/ConnectionsSettingsPage'
import { useDesktopSidebarCollapsed } from '@/components/layout/useDesktopSidebarCollapsed'
import { isTauriRuntime } from '@/lib/runtime-environment'
import { useAuth } from '@/features/auth/useAuth'
import { useWorkbench } from '@/features/workbench/useWorkbench'
import { useIsMobile } from '@/hooks/useIsMobile'
import { useTranslation } from '@/hooks/useTranslation'
import { navigateTo, resolveDesktopAppRoute } from '@/lib/navigation'
import { runtimeProjectUiId } from '@/lib/runtime-project'
import type { DeviceInfo as WorkbenchDeviceInfo, RuntimeProjectWork } from '@/types/api'
import type { DeviceInfo as ManagedDeviceInfo } from '@/types/devices'

function toManagedDeviceInfo(device: WorkbenchDeviceInfo): ManagedDeviceInfo | null {
  const deviceType = device.device_type
  if (deviceType !== 'cloud' && deviceType !== 'remote') return null

  return {
    ...device,
    device_type: deviceType,
    bind_shell: device.bind_shell === 'openclaw' ? 'openclaw' : 'claudecode',
  }
}

function getCloudProjectWorkspace(
  projectWork: RuntimeProjectWork,
  cloudDeviceIds: ReadonlySet<string>
) {
  return (
    projectWork.deviceWorkspaces.find(
      workspace => cloudDeviceIds.has(workspace.deviceId) && workspace.available
    ) ??
    projectWork.deviceWorkspaces.find(workspace => cloudDeviceIds.has(workspace.deviceId)) ??
    null
  )
}

export function CloudWorkPage() {
  const { t } = useTranslation('common')
  const { logout } = useAuth()
  const isMobile = useIsMobile()
  const isTauri = isTauriRuntime()
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
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

  const cloudDevices = useMemo(
    () =>
      state.devices.flatMap(device => {
        const managedDevice = toManagedDeviceInfo(device)
        return managedDevice ? [managedDevice] : []
      }),
    [state.devices]
  )
  const cloudDeviceIds = useMemo(
    () => new Set(cloudDevices.map(device => device.device_id)),
    [cloudDevices]
  )
  const cloudProjects = useMemo(
    () =>
      (state.runtimeWork?.projects ?? []).filter(projectWork => {
        const stateDeviceId = projectWork.project.stateDeviceId
        return (
          (stateDeviceId ? cloudDeviceIds.has(stateDeviceId) : false) ||
          projectWork.deviceWorkspaces.some(workspace => cloudDeviceIds.has(workspace.deviceId))
        )
      }),
    [cloudDeviceIds, state.runtimeWork?.projects]
  )

  const handleSelectProject = (projectId: number) => {
    navigateTo('/')
    selectProject(projectId)
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
  const handleOpenRuntimeTask = async (address: Parameters<typeof openRuntimeTask>[0]) => {
    navigateTo('/')
    await openRuntimeTask(address)
  }
  const handleCreateCloudProject = () => {
    navigateTo('/')
    requestProjectCreateMode('git')
  }
  const handleAddDevice = () => {
    navigateTo('/settings/connections?addDevice=1')
  }

  return (
    <div className="relative flex h-full flex-col overflow-hidden bg-background text-text-primary">
      <DesktopWindowsTitlebar
        sidebarCollapsed={sidebarCollapsed && !isMobile}
        onToggleSidebar={() => setSidebarCollapsed(!sidebarCollapsed)}
        activeApp="wework"
        onNavigate={app => navigateTo(resolveDesktopAppRoute(app))}
      />
      <div className="flex min-h-0 flex-1 overflow-hidden">
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
            activeItem="cloud-work"
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
            onOpenCloudWork={() => navigateTo('/cloud-work')}
            onRefreshDevices={refreshDevices}
            onUpdateProjectName={updateProjectName}
            onRemoveProject={removeProject}
            onGetDeviceHomeDirectory={getDeviceHomeDirectory}
            onListDeviceDirectories={listDeviceDirectories}
            onCreateDeviceDirectory={createDeviceDirectory}
            onOpenSettings={options =>
              navigateTo(
                options?.settingsPage === 'connections' ? '/settings/connections' : '/settings'
              )
            }
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
              activeItem="cloud-work"
              onClose={() => setDrawerOpen(false)}
              onNewChat={handleNewChat}
              onStartStandaloneChat={handleStartStandaloneChat}
              onOpenSettings={() => navigateTo('/settings')}
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

        <main
          data-testid="cloud-work-page"
          className="min-w-0 flex-1 overflow-y-auto bg-background"
        >
          <div className="mx-auto w-full max-w-5xl px-5 pb-14 pt-8 md:px-8">
            <header className="flex items-center justify-between gap-4">
              <div>
                <h1 className="text-heading-md font-medium text-text-primary">
                  {t('workbench.cloud_work_title', '云端工作')}
                </h1>
                <p className="mt-1 text-sm text-text-secondary">
                  {t('workbench.cloud_work_page_description', '查看云端设备资源状态并进入云端项目')}
                </p>
              </div>
              <button
                type="button"
                data-testid="cloud-work-settings-button"
                onClick={() => navigateTo('/settings/connections')}
                className="flex h-8 items-center gap-1.5 rounded-lg px-3 text-sm text-text-secondary hover:bg-muted hover:text-text-primary"
              >
                <Settings className="h-4 w-4" />
                {t('workbench.cloud_work_connection_settings', '连接设置')}
              </button>
            </header>

            <div className="mt-8 space-y-10">
              <section data-testid="cloud-work-devices-section">
                <div className="mb-3 flex items-center justify-between gap-4">
                  <div className="flex items-center gap-2">
                    <Cloud className="h-4 w-4 text-text-secondary" />
                    <h2 className="text-base font-medium text-text-primary">
                      {t('workbench.cloud_work_devices', '设备')}
                    </h2>
                  </div>
                  <button
                    type="button"
                    data-testid="cloud-work-add-device-button"
                    onClick={handleAddDevice}
                    className="flex h-8 items-center gap-1.5 rounded-lg bg-text-primary px-3 text-sm font-medium text-background hover:opacity-80"
                  >
                    <Plus className="h-4 w-4" />
                    {t('workbench.cloud_work_add_device', '添加设备')}
                  </button>
                </div>
                {cloudDevices.length > 0 ? (
                  <DeviceSection
                    title={t('workbench.cloud_work_available_devices', '云端与远程设备')}
                    devices={cloudDevices}
                    onChanged={() => void refreshDevices()}
                    icon={Cloud}
                  />
                ) : (
                  <div
                    data-testid="cloud-work-devices-empty"
                    className="rounded-xl border border-border px-4 py-8 text-center text-sm text-text-secondary"
                  >
                    {t('workbench.cloud_work_no_devices', '还没有可用的云端设备')}
                  </div>
                )}
              </section>

              <section data-testid="cloud-work-projects-section">
                <div className="mb-3 flex items-center justify-between gap-4">
                  <div className="flex items-center gap-2">
                    <FolderGit2 className="h-4 w-4 text-text-secondary" />
                    <h2 className="text-base font-medium text-text-primary">
                      {t('workbench.cloud_work_projects', '云端项目')}
                    </h2>
                  </div>
                  <button
                    type="button"
                    data-testid="cloud-work-create-project-button"
                    onClick={handleCreateCloudProject}
                    disabled={cloudDevices.length === 0}
                    className="flex h-8 items-center gap-1.5 rounded-lg px-3 text-sm text-text-secondary hover:bg-muted hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <Plus className="h-4 w-4" />
                    {t('workbench.cloud_work_create_project', '新建项目')}
                  </button>
                </div>
                {cloudProjects.length > 0 ? (
                  <div className="space-y-1">
                    {cloudProjects.map(projectWork => {
                      const workspace = getCloudProjectWorkspace(projectWork, cloudDeviceIds)
                      const device = workspace
                        ? cloudDevices.find(item => item.device_id === workspace.deviceId)
                        : null
                      const projectId = runtimeProjectUiId(projectWork.project)
                      return (
                        <button
                          key={`${projectWork.project.stateDeviceId ?? ''}:${projectWork.project.key}`}
                          type="button"
                          data-testid={`cloud-work-project-${projectId}`}
                          onClick={() => handleSelectProject(projectId)}
                          className="flex min-h-12 w-full items-center gap-3 rounded-lg px-3 py-2 text-left hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-blue-500"
                        >
                          <FolderGit2 className="h-4 w-4 shrink-0 text-text-secondary" />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-medium text-text-primary">
                              {projectWork.project.name}
                            </span>
                            <span className="block truncate text-xs text-text-secondary">
                              {[device?.name || workspace?.deviceName, workspace?.workspacePath]
                                .filter(Boolean)
                                .join(' · ')}
                            </span>
                          </span>
                          <span className="shrink-0 text-xs text-text-muted">
                            {workspace?.available
                              ? t('workbench.cloud_work_project_available', '可用')
                              : t('workbench.cloud_work_project_unavailable', '不可用')}
                          </span>
                        </button>
                      )
                    })}
                  </div>
                ) : (
                  <div
                    data-testid="cloud-work-projects-empty"
                    className="rounded-xl border border-border px-4 py-8 text-center text-sm text-text-secondary"
                  >
                    {t('workbench.cloud_work_no_projects', '还没有云端项目')}
                  </div>
                )}
              </section>
            </div>
          </div>
        </main>

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
