import type { PointerEventHandler } from 'react'
import { navigateTo } from '@/lib/navigation'
import { shouldUseNativeProjectDirectoryPicker } from '@/e2e/automation'
import { cn } from '@/lib/utils'
import { DesktopSidebar } from './DesktopSidebar'
import { ProjectCreateDialog } from '@/components/projects/ProjectCreateDialog'
import { ExistingLocalProjectImportDialog } from '@/components/projects/ExistingLocalProjectImportDialog'
import {
  StandaloneBlankProjectDialog,
  StandaloneFolderProjectDialog,
} from '@/components/projects/StandaloneProjectDialogs'
import { runtimeProjectUiId } from '@/lib/runtime-project'
import { TransientNotice } from '@/components/common/TransientNotice'
import { DesktopWorkbenchMain } from './DesktopWorkbenchMain'
import { WorkbenchSearchDialog } from './WorkbenchSearchDialog'
import { ConnectionsSettingsPage } from '@/components/settings/ConnectionsSettingsPage'
import { CloudTodoWorkspace } from '@/features/todo/CloudTodoWorkspace'
import { TaskBoardView } from '@/features/todo/TaskBoardView'
import { PersonalStandInWorkspace } from '@/features/todo/PersonalStandInWorkspace'
import { WeworkCollaborationPlatform } from '@/features/todo/WeworkCollaborationPlatform'
import { LOCAL_USER } from '@/api/local/localSession'
import { projectSpaceRef } from '@/features/todo/projectSpaceSelection'
import {
  defaultProjectSpaceContentRoute,
  projectSpaceContentRoute,
  projectSpaceRefFromRoute,
  projectSpaceRouteParam,
  projectSpaceRouteRequestsDefaultProject,
} from '@/features/todo/projectSpaceRoute'
import { WorkbenchBackground } from '@/features/appearance'
import { readSettingsReturnPath } from '@/features/workspace-tabs/settingsReturnPath'
import { TitlebarActionsPortal } from '@/components/topnav/TitlebarActionsPortal'
import { TaskBoardCreateButton } from '@/features/todo/TaskBoardActions'
import { routePathname } from './desktopWorkbenchLayoutHelpers'
import type { useDesktopWorkbenchLayoutModel } from './useDesktopWorkbenchLayoutModel'
export function DesktopWorkbenchLayoutView({
  model,
}: {
  model: ReturnType<typeof useDesktopWorkbenchLayoutModel>
}) {
  const {
    setArchivedCleanupError,
    routeActive,
    t,
    archivedCleanupError,
    onLogout,
    runtimeTaskLifecycle,
    state,
    cloudWorkStatus,
    upgradingDevices,
    selectStandaloneDevice,
    onOpenStandaloneWorkspace,
    onOpenRuntimeTask,
    onSearchRuntimeWork,
    onRenameRuntimeTask,
    onArchiveRuntimeTask,
    onArchiveProjectConversations,
    onArchiveProjectsConversations,
    onArchiveChatConversations,
    onCancelRuntimeTask,
    onRefreshDevices,
    onUpgradeDevice,
    onCreateProject,
    onCreateLocalRuntimeProject,
    onCreateGitWorkspaceProject,
    onPrepareDeviceWorkspace,
    onDeleteDeviceWorkspace,
    onListGitRepositories,
    onListGitBranches,
    onUpdateProjectName,
    onUpdateLocalRuntimeProject,
    onRemoveProject,
    onReorderRuntimeProjects,
    onSetRuntimeProjectPinned,
    onSetRuntimeProjectAppearance,
    onSetRuntimeTaskPinned,
    onGetDeviceHomeDirectory,
    onGetProjectWorkspaceRoot,
    onListDeviceDirectories,
    onCreateDeviceDirectory,
    onCloneGitRepository,
    projectChat,
    sendRuntimePaneMessage,
    services,
    refreshWorkLists,
    localTodoProjects,
    availableProjectSpaceApis,
    workspaceTabs,
    ownedWorkspaceTab,
    activePane,
    splitGroups,
    layoutSession,
    localHarnessSessions,
    activeLocalHarnessSessionId,
    sidebarPreviewOpen,
    sidebarResizing,
    settingsOpen,
    autoOpenAddCloudDeviceDialog,
    blankProjectDialogOpen,
    standaloneWorkspaceDialogMode,
    standaloneRemoteDialogIntent,
    standalonePreferNativeLocalPicker,
    projectWorkEditProject,
    searchOpen,
    imNotificationSettings,
    notice,
    projectCreateRequest,
    setCurrentPath,
    setSidebarResizing,
    setSettingsOpen,
    setAutoOpenAddCloudDeviceDialog,
    setBlankProjectDialogOpen,
    setProjectWorkEditProject,
    setSearchOpen,
    setNotice,
    routeWorkItemsOpen,
    standInOpen,
    standInRetention,
    taskBoardOpen,
    routedDefaultWorkItemsOpen,
    workItemUser,
    workItemServicesReady,
    activeItem,
    taskReminders,
    toggleMyWork,
    startNewChatOutsideHarness,
    startStandaloneChatOutsideHarness,
    selectProjectOutsideHarness,
    startNewProjectChatOutsideHarness,
    openRuntimeTaskOutsideHarness,
    registerLocalHarnessSession,
    openLocalHarnessSession,
    handleLocalHarnessSessionExit,
    closeLocalHarnessSession,
    createPermanentWorktree,
    openProjectSpaceRuntimeTask,
    effectiveSidebarCollapsed,
    openStandaloneFolderProject,
    closeStandaloneFolderProject,
    openCloudDeviceSettings,
    openSettings,
    openSidebarPreview,
    closeSidebarPreview,
    updateSidebarCollapsed,
    collapseSidebar,
    sidebarWidth,
    handleSidebarResizeStart,
    toggleRuntimeTaskNotification,
  } = model
  const renderDesktopSidebar = ({
    collapsed,
    containerTestId,
    hideResizeHandle = false,
    onPointerEnter,
    onPointerLeave,
    onToggleSidebar,
  }: {
    collapsed: boolean
    containerTestId?: string
    hideResizeHandle?: boolean
    onPointerEnter?: PointerEventHandler<HTMLElement>
    onPointerLeave?: PointerEventHandler<HTMLElement>
    onToggleSidebar?: () => void
  }) => (
    <DesktopSidebar
      user={state.user}
      projects={state.projects}
      devices={state.devices}
      cloudWorkStatus={cloudWorkStatus}
      runtimeWork={state.runtimeWork}
      runtimeWorkLoad={state.runtimeWorkLoad}
      onRetryRuntimeWork={refreshWorkLists}
      currentRuntimeTask={activeLocalHarnessSessionId ? null : state.currentRuntimeTask}
      splitGroupMemberships={splitGroups.memberships}
      standaloneDeviceId={state.standaloneDeviceId}
      standaloneWorkspacePath={state.standaloneWorkspacePath}
      imNotificationSettings={imNotificationSettings}
      unreadRuntimeTaskKeys={taskReminders.unreadTaskKeys}
      standInUnreadCount={[...(taskReminders.unreadMessageCounts?.values() ?? [])].reduce(
        (sum, count) => sum + count,
        0
      )}
      preferredDeviceId={
        state.standaloneDeviceId ?? state.user?.preferences?.default_execution_target
      }
      activeItem={activeItem}
      taskView={taskBoardOpen ? 'default-work-items' : 'workbench'}
      localHarnessSessions={localHarnessSessions}
      activeLocalHarnessSessionId={activeLocalHarnessSessionId}
      collapsed={collapsed}
      containerTestId={containerTestId}
      hideResizeHandle={hideResizeHandle}
      sidebarWidth={sidebarWidth}
      resizing={sidebarResizing}
      onResizeStart={handleSidebarResizeStart}
      onResizeCollapse={collapseSidebar}
      onResizeStateChange={setSidebarResizing}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      onToggleSidebar={onToggleSidebar ?? (() => updateSidebarCollapsed(!collapsed))}
      onNewChat={startNewChatOutsideHarness}
      onOpenStandIn={() => navigateTo('/stand-in')}
      onStartStandaloneChat={startStandaloneChatOutsideHarness}
      onOpenLocalHarnessSession={openLocalHarnessSession}
      onCloseLocalHarnessSession={closeLocalHarnessSession}
      onOpenSearch={() => setSearchOpen(true)}
      onToggleMyWork={toggleMyWork}
      onSelectProject={selectProjectOutsideHarness}
      onStartNewProjectChat={startNewProjectChatOutsideHarness}
      onOpenRuntimeTask={openRuntimeTaskOutsideHarness}
      onMarkRuntimeTaskRead={taskReminders.markRuntimeTaskRead}
      onRenameRuntimeTask={onRenameRuntimeTask}
      onArchiveRuntimeTask={onArchiveRuntimeTask}
      onArchiveProjectConversations={onArchiveProjectConversations}
      onArchiveProjectsConversations={onArchiveProjectsConversations}
      onArchiveChatConversations={onArchiveChatConversations}
      onToggleRuntimeTaskNotification={toggleRuntimeTaskNotification}
      onOpenStandaloneWorkspace={onOpenStandaloneWorkspace}
      onCreatePermanentWorktree={createPermanentWorktree}
      onSelectStandaloneDevice={selectStandaloneDevice}
      onRefreshDevices={onRefreshDevices}
      onOpenStandaloneFolderProject={(mode, intent = 'project') => {
        void openStandaloneFolderProject(mode, intent)
      }}
      onUpdateProjectName={onUpdateProjectName}
      onUpdateLocalRuntimeProject={onUpdateLocalRuntimeProject}
      onRemoveProject={onRemoveProject}
      onReorderRuntimeProjects={onReorderRuntimeProjects}
      onSetRuntimeProjectPinned={onSetRuntimeProjectPinned}
      onSetRuntimeProjectAppearance={onSetRuntimeProjectAppearance}
      onSetRuntimeTaskPinned={onSetRuntimeTaskPinned}
      onGetDeviceHomeDirectory={onGetDeviceHomeDirectory}
      onListDeviceDirectories={onListDeviceDirectories}
      onCreateDeviceDirectory={onCreateDeviceDirectory}
      onCloneGitRepository={onCloneGitRepository}
      projectDevicePluginApi={services.projectDevicePluginApi}
      projectSpaceApis={availableProjectSpaceApis}
      models={projectChat.models}
      onOpenSettings={options => openSettings(options)}
      onLogout={onLogout}
    />
  )
  return (
    <div className="relative flex h-full overflow-hidden bg-transparent text-text-primary">
      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        {!routeWorkItemsOpen && <WorkbenchBackground />}
        {routeActive &&
          !settingsOpen &&
          !routeWorkItemsOpen &&
          renderDesktopSidebar({ collapsed: effectiveSidebarCollapsed })}
        {routeActive && !settingsOpen && !routeWorkItemsOpen && effectiveSidebarCollapsed && (
          <>
            <div
              data-testid="desktop-sidebar-hover-edge"
              aria-hidden="true"
              onPointerEnter={openSidebarPreview}
              className="absolute left-0 top-0 z-popover h-full w-4"
            />
            <div
              data-testid="desktop-sidebar-preview"
              aria-hidden={!sidebarPreviewOpen}
              onPointerEnter={openSidebarPreview}
              onPointerLeave={closeSidebarPreview}
              className={cn(
                'absolute left-0 top-0 z-popover h-full overflow-hidden rounded-tl-xl transition-transform duration-[180ms] ease-out motion-reduce:transition-none will-change-transform',
                sidebarPreviewOpen
                  ? 'pointer-events-auto translate-x-0 opacity-100'
                  : 'pointer-events-none -translate-x-full opacity-100'
              )}
            >
              {renderDesktopSidebar({
                collapsed: false,
                containerTestId: 'desktop-sidebar-preview-panel',
                hideResizeHandle: true,
                onPointerEnter: openSidebarPreview,
                onPointerLeave: closeSidebarPreview,
                onToggleSidebar: () => updateSidebarCollapsed(false),
              })}
            </div>
          </>
        )}
        {settingsOpen && (
          <ConnectionsSettingsPage
            autoOpenAddCloudDeviceDialog={autoOpenAddCloudDeviceDialog}
            services={services}
            devices={state.devices}
            onOpenRuntimeTask={onOpenRuntimeTask}
            onRefreshWorkLists={refreshWorkLists}
            onBack={() => {
              const returnPath = readSettingsReturnPath() ?? layoutSession.getSettingsReturnPath()
              setSettingsOpen(false)
              setAutoOpenAddCloudDeviceDialog(false)
              setCurrentPath(routePathname(returnPath))
              navigateTo(returnPath)
            }}
          />
        )}
        <div style={{ display: settingsOpen ? 'none' : 'contents' }} aria-hidden={settingsOpen}>
          {(standInOpen || standInRetention.visited) && (
            <div
              className="min-h-0 min-w-0 flex-1 flex-col"
              style={{ display: standInOpen ? 'flex' : 'none' }}
              aria-hidden={!standInOpen}
              inert={!standInOpen}
            >
              <PersonalStandInWorkspace
                contentRoute={standInRetention.contentRoute}
                entryRequestKey={standInRetention.entryKey}
                services={services}
                user={state.user ?? LOCAL_USER}
                devices={state.devices}
                active={standInOpen && routeActive && !settingsOpen}
                onClose={() => navigateTo('/')}
                onOpenTask={openRuntimeTaskOutsideHarness}
              />
            </div>
          )}
          {taskBoardOpen && routeActive && !settingsOpen ? (
            <TitlebarActionsPortal>
              <TaskBoardCreateButton
                label={t('todo.new_task', '新建任务')}
                onClick={startNewChatOutsideHarness}
              />
            </TitlebarActionsPortal>
          ) : null}
          {taskBoardOpen ? (
            <div
              data-testid="task-view-board-transition"
              className="task-view-board-enter flex min-h-0 min-w-0 flex-1"
            >
              <TaskBoardView
                runtimeWork={state.runtimeWork}
                runtimeTaskLifecycle={runtimeTaskLifecycle}
                unreadRuntimeTaskKeys={taskReminders.unreadTaskKeys}
                onCreateTask={startNewChatOutsideHarness}
                projectSpaceApis={availableProjectSpaceApis}
                onArchiveRuntimeTasks={onArchiveChatConversations}
                onMarkRuntimeTaskRead={taskReminders.markRuntimeTaskRead}
                onOpenRuntimeTask={address => {
                  void openRuntimeTaskOutsideHarness(address)
                }}
              />
            </div>
          ) : null}
          {routeWorkItemsOpen &&
            (workItemUser && workItemServicesReady ? (
              routedDefaultWorkItemsOpen ? (
                <CloudTodoWorkspace
                  user={workItemUser}
                  localProjects={localTodoProjects}
                  runtimeWork={state.runtimeWork}
                  runtimeTaskLifecycle={runtimeTaskLifecycle}
                  services={services}
                  embedded
                  embeddedTitle="project"
                  startupActive={routeActive}
                  workspaceActive={routeActive && routeWorkItemsOpen && !settingsOpen}
                  onOpenRuntimeTask={openProjectSpaceRuntimeTask}
                  onMarkRuntimeTaskRead={taskReminders.markRuntimeTaskRead}
                  onArchiveRuntimeTasks={onArchiveChatConversations}
                  onOpenSettings={options => openSettings(options)}
                  onLogout={onLogout}
                  activeProjectRef={
                    ownedWorkspaceTab?.kind === 'board'
                      ? projectSpaceRefFromRoute(ownedWorkspaceTab.contentRoute)
                      : undefined
                  }
                  defaultProjectRequested
                  focusedItemId={
                    ownedWorkspaceTab?.kind === 'board'
                      ? projectSpaceRouteParam(ownedWorkspaceTab.contentRoute, 'itemId')
                      : undefined
                  }
                  onFocusedItemHandled={() => {
                    if (
                      !workspaceTabs ||
                      ownedWorkspaceTab?.kind !== 'board' ||
                      workspaceTabs.activeTabId !== ownedWorkspaceTab.id
                    ) {
                      return
                    }
                    workspaceTabs.updateActiveTab({
                      contentRoute: defaultProjectSpaceContentRoute(),
                    })
                  }}
                  onActiveProjectChange={project => {
                    if (!workspaceTabs || ownedWorkspaceTab?.kind !== 'board' || !project) {
                      return
                    }
                    workspaceTabs.updateTab(ownedWorkspaceTab.id, {
                      title: project.name,
                      contentRoute: projectSpaceContentRoute(projectSpaceRef(project)),
                    })
                  }}
                />
              ) : (
                <WeworkCollaborationPlatform
                  homeDraft={projectChat}
                  user={workItemUser}
                  devices={state.devices}
                  localProjects={localTodoProjects}
                  runtimeWork={state.runtimeWork}
                  runtimeTaskLifecycle={runtimeTaskLifecycle}
                  services={services}
                  startupActive={routeActive && routeWorkItemsOpen}
                  workspaceActive={routeActive && routeWorkItemsOpen && !settingsOpen}
                  onOpenRuntimeTask={openProjectSpaceRuntimeTask}
                  onArchiveRuntimeTasks={onArchiveChatConversations}
                  onCancelRuntimeTask={onCancelRuntimeTask}
                  sendRuntimePaneMessage={sendRuntimePaneMessage}
                  onOpenSettings={options => openSettings(options)}
                  onLogout={onLogout}
                  renderLocalProjectImporter={({ mode, projects, onClose, onCreated }) =>
                    mode === 'existing' ? (
                      <ExistingLocalProjectImportDialog
                        open
                        projects={projects}
                        onClose={onClose}
                        onImport={async project => {
                          const ownerScope = layoutSession.captureOwner()

                          const runtimeProject = state.runtimeWork?.projects.find(
                            projectWork => runtimeProjectUiId(projectWork.project) === project.id
                          )
                          if (runtimeProject) {
                            const roots = Array.from(
                              new Set([
                                ...(runtimeProject.project.roots ?? []).map(root => root.path),
                                ...runtimeProject.deviceWorkspaces
                                  .filter(workspace => workspace.workspaceKind !== 'chat')
                                  .map(workspace => workspace.workspacePath),
                              ])
                            ).filter(Boolean)
                            const deviceId =
                              runtimeProject.project.stateDeviceId?.trim() ||
                              runtimeProject.deviceWorkspaces.find(
                                workspace => workspace.workspaceKind !== 'chat'
                              )?.deviceId
                            if (!deviceId || roots.length === 0) {
                              throw new Error(
                                t(
                                  'workbench.local_project_workspace_unavailable',
                                  '本地项目缺少可用的设备或工作目录'
                                )
                              )
                            }
                            await onUpdateLocalRuntimeProject({
                              deviceId,
                              projectKey: runtimeProject.project.key,
                              name: runtimeProject.project.name,
                              roots,
                              defaultProjectSpace:
                                runtimeProject.project.defaultProjectSpace ?? null,
                              aiSettings: runtimeProject.project.aiSettings ?? null,
                            })
                            if (!ownerScope.isCurrent()) return

                            await onCreated(
                              runtimeProject.project.key,
                              runtimeProject.project.name,
                              roots
                            )
                            if (!ownerScope.isCurrent()) return

                            return
                          }

                          const deviceId = project.config?.execution?.deviceId
                          const workspacePath =
                            project.config?.workspace?.source === 'local_path'
                              ? project.config.workspace.localPath
                              : null
                          if (!deviceId || !workspacePath) {
                            throw new Error(
                              t(
                                'workbench.local_project_workspace_unavailable',
                                '本地项目缺少可用的设备或工作目录'
                              )
                            )
                          }
                          const created = await onCreateLocalRuntimeProject({
                            deviceId,
                            name: project.name,
                            roots: [workspacePath],
                          })
                          if (!ownerScope.isCurrent()) return

                          await onCreated(created.runtimeProjectKey, project.name, [workspacePath])
                          if (!ownerScope.isCurrent()) return
                        }}
                      />
                    ) : (
                      <StandaloneFolderProjectDialog
                        key="collaboration-local-project-importer"
                        open
                        mode="existing"
                        preferNativeLocalPicker={shouldUseNativeProjectDirectoryPicker()}
                        devices={state.devices.filter(device => device.device_type === 'local')}
                        preferredDeviceId={
                          state.standaloneDeviceId ??
                          state.user?.preferences?.default_execution_target
                        }
                        onClose={onClose}
                        onGetDeviceHomeDirectory={onGetDeviceHomeDirectory}
                        onListDeviceDirectories={onListDeviceDirectories}
                        onCreateDeviceDirectory={onCreateDeviceDirectory}
                        onOpenStandaloneWorkspace={async (
                          deviceId,
                          workspacePath,
                          name,
                          projectRoots
                        ) => {
                          const ownerScope = layoutSession.captureOwner()

                          const roots = projectRoots?.length ? projectRoots : [workspacePath]
                          const created = await onCreateLocalRuntimeProject({
                            deviceId,
                            name:
                              name?.trim() ||
                              workspacePath.split(/[\\/]/).filter(Boolean).at(-1) ||
                              'Project',
                            roots,
                          })
                          if (!ownerScope.isCurrent()) return

                          await onCreated(
                            created.runtimeProjectKey,
                            name?.trim() ||
                              workspacePath.split(/[\\/]/).filter(Boolean).at(-1) ||
                              'Project',
                            roots
                          )
                          if (!ownerScope.isCurrent()) return
                        }}
                        onRefreshDevices={onRefreshDevices}
                      />
                    )
                  }
                  activeProjectRef={
                    ownedWorkspaceTab?.kind === 'board'
                      ? projectSpaceRefFromRoute(ownedWorkspaceTab.contentRoute)
                      : undefined
                  }
                  defaultProjectRequested={
                    ownedWorkspaceTab?.kind === 'board' &&
                    projectSpaceRouteRequestsDefaultProject(ownedWorkspaceTab.contentRoute)
                  }
                  focusedItemId={
                    ownedWorkspaceTab?.kind === 'board'
                      ? projectSpaceRouteParam(ownedWorkspaceTab.contentRoute, 'itemId')
                      : undefined
                  }
                  focusedCommentId={
                    ownedWorkspaceTab?.kind === 'board'
                      ? projectSpaceRouteParam(ownedWorkspaceTab.contentRoute, 'commentId')
                      : undefined
                  }
                  focusedCommentRequestKey={
                    ownedWorkspaceTab?.kind === 'board'
                      ? projectSpaceRouteParam(ownedWorkspaceTab.contentRoute, 'focusRequest')
                      : undefined
                  }
                  onFocusedItemHandled={() => {
                    if (
                      !workspaceTabs ||
                      ownedWorkspaceTab?.kind !== 'board' ||
                      workspaceTabs.activeTabId !== ownedWorkspaceTab.id
                    ) {
                      return
                    }
                    const projectRef = projectSpaceRefFromRoute(ownedWorkspaceTab.contentRoute)
                    workspaceTabs.updateActiveTab({
                      contentRoute: projectRef ? projectSpaceContentRoute(projectRef) : '/todo',
                    })
                  }}
                  onActiveProjectChange={project => {
                    if (!workspaceTabs || ownedWorkspaceTab?.kind !== 'board') {
                      return
                    }
                    if (!project) {
                      workspaceTabs.updateTab(ownedWorkspaceTab.id, {
                        title: t('workbench.workspace_tab_board', '协作'),
                        contentRoute: '/todo',
                      })
                      return
                    }
                    workspaceTabs.updateTab(ownedWorkspaceTab.id, {
                      title: project.name,
                      contentRoute: projectSpaceContentRoute(projectSpaceRef(project)),
                    })
                  }}
                />
              )
            ) : (
              <div
                data-testid="cloud-board-loading"
                className="flex h-full flex-1 items-center justify-center text-sm text-text-muted"
              >
                {t('workbench.cloud_board_loading', '正在加载云端看板…')}
              </div>
            ))}
          {!routeWorkItemsOpen ? (
            <div
              style={{ display: taskBoardOpen || standInOpen ? 'none' : 'contents' }}
              aria-hidden={taskBoardOpen || standInOpen}
            >
              <DesktopWorkbenchMain
                visible={routeActive && !settingsOpen && !taskBoardOpen && !standInOpen}
                sidebarCollapsed={effectiveSidebarCollapsed}
                sidebarResizing={sidebarResizing}
                onSidebarCollapsedChange={updateSidebarCollapsed}
                activePane={activePane}
                splitGroups={splitGroups}
                localHarnessSessions={localHarnessSessions}
                activeLocalHarnessSessionId={activeLocalHarnessSessionId}
                onLocalHarnessSessionStarted={registerLocalHarnessSession}
                onLocalHarnessSessionClose={closeLocalHarnessSession}
                onLocalHarnessSessionExit={handleLocalHarnessSessionExit}
              />
            </div>
          ) : null}
        </div>
      </div>
      <StandaloneBlankProjectDialog
        open={blankProjectDialogOpen}
        devices={state.devices}
        preferredDeviceId={
          state.standaloneDeviceId ?? state.user?.preferences?.default_execution_target
        }
        onClose={() => setBlankProjectDialogOpen(false)}
        onGetDeviceHomeDirectory={onGetDeviceHomeDirectory}
        onListDeviceDirectories={onListDeviceDirectories}
        onCreateDeviceDirectory={onCreateDeviceDirectory}
        onOpenStandaloneWorkspace={onOpenStandaloneWorkspace}
      />
      <StandaloneFolderProjectDialog
        key={standaloneWorkspaceDialogMode ?? 'standalone-folder-closed'}
        open={standaloneWorkspaceDialogMode !== null}
        mode={standaloneWorkspaceDialogMode ?? 'existing'}
        remoteIntent={standaloneRemoteDialogIntent}
        preferNativeLocalPicker={standalonePreferNativeLocalPicker}
        devices={state.devices}
        preferredDeviceId={
          state.standaloneDeviceId ?? state.user?.preferences?.default_execution_target
        }
        onClose={closeStandaloneFolderProject}
        onGetDeviceHomeDirectory={onGetDeviceHomeDirectory}
        onListDeviceDirectories={onListDeviceDirectories}
        onCreateDeviceDirectory={onCreateDeviceDirectory}
        onCloneGitRepository={onCloneGitRepository}
        onOpenStandaloneWorkspace={async (deviceId, workspacePath, name, projectRoots) => {
          const ownerScope = layoutSession.captureOwner()

          const scopedRequest = projectCreateRequest
          if (!scopedRequest?.preserveCurrentSurface) {
            if (projectRoots) {
              await onOpenStandaloneWorkspace(deviceId, workspacePath, name, projectRoots)
              if (!ownerScope.isCurrent()) return
            } else {
              await onOpenStandaloneWorkspace(deviceId, workspacePath, name)
              if (!ownerScope.isCurrent()) return
            }
            return
          }
          const roots = projectRoots?.length ? projectRoots : [workspacePath]
          const projectName =
            name?.trim() || workspacePath.split(/[\\/]/).filter(Boolean).at(-1) || 'Project'
          const createdProject = await onCreateLocalRuntimeProject({
            deviceId,
            name: projectName,
            roots,
          })
          if (!ownerScope.isCurrent()) return

          scopedRequest.onCreated?.(createdProject)
        }}
        onRefreshDevices={onRefreshDevices}
      />
      <ProjectCreateDialog
        open={projectWorkEditProject !== null}
        mode="existing"
        project={projectWorkEditProject}
        devices={state.devices}
        onClose={() => {
          setProjectWorkEditProject(null)
        }}
        onOpenCloudDeviceSettings={() => {
          setProjectWorkEditProject(null)
          openCloudDeviceSettings()
        }}
        onCreateProject={onCreateProject}
        onCreateGitWorkspaceProject={onCreateGitWorkspaceProject}
        onPrepareDeviceWorkspace={onPrepareDeviceWorkspace}
        onDeleteDeviceWorkspace={onDeleteDeviceWorkspace}
        preferredDeviceId={
          state.standaloneDeviceId ?? state.user?.preferences?.default_execution_target
        }
        upgradingDevices={upgradingDevices}
        onUpgradeDevice={onUpgradeDevice}
        onGetDeviceHomeDirectory={onGetDeviceHomeDirectory}
        onGetProjectWorkspaceRoot={onGetProjectWorkspaceRoot}
        onListDeviceDirectories={onListDeviceDirectories}
        onCreateDeviceDirectory={onCreateDeviceDirectory}
        onListGitRepositories={onListGitRepositories}
        onListGitBranches={onListGitBranches}
      />
      <TransientNotice
        message={notice?.message ?? null}
        tone={notice?.tone}
        onClear={() => setNotice(null)}
      />
      <TransientNotice
        message={archivedCleanupError}
        tone="error"
        onClear={() => setArchivedCleanupError(null)}
      />
      <WorkbenchSearchDialog
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
        onSearchRuntimeWork={onSearchRuntimeWork}
        onOpenRuntimeTask={async address => {
          const ownerScope = layoutSession.captureOwner()

          await openRuntimeTaskOutsideHarness(address)
          if (!ownerScope.isCurrent()) return
        }}
      />
    </div>
  )
}
