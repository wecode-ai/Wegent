import { BetaBadge } from '@/components/common/BetaBadge'
import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import { Archive, FolderPlus, MessageSquarePlus, Plus, Search, UserRound } from 'lucide-react'
import {
  DesktopSidebarArchiveDialogs,
  DesktopSidebarProjectEditDialogs,
  DesktopSidebarReleaseNotesDialog,
  DesktopSidebarStandaloneDialog,
} from './DesktopSidebarDialogs'
import { DesktopSidebarProjectCreateMenu } from './DesktopSidebarProjectCreateMenu'

import { ActionMenu } from '@/components/common/ActionMenu'

import { Tooltip } from '@/components/ui/tooltip'

import { DshIcon } from '@/features/dsh-runtime/DshIcon'

import { getRuntimeTaskReminderItemKey } from '@/features/workbench/runtimeTaskReminders'
import { getRuntimeTaskThreadId } from '@/features/workbench/workbenchRuntimeHelpers'

import { prefetchDshSidebarNavigation } from '@/features/dsh-runtime/dshSidebarNavigation'
import { DshSidebarNavigationSurface } from '@/features/dsh-runtime/DshSidebarNavigationSurface'
import { rightWorkspaceDshSidebar } from './workspace-panels/rightWorkspaceDshSidebar'

import { navigateTo } from '@/lib/navigation'

import {
  getRuntimeProjectReorderRequest,
  getRuntimeProjectSidebarStateKey,
} from '@/lib/runtime-project-state'
import { cn } from '@/lib/utils'
import { SidebarWorklistsScroll } from './SidebarWorklistsScroll'

import { DesktopSidebarAccount } from './DesktopSidebarAccount'
import {
  DesktopSidebarHeader,
  DesktopSidebarNavItem,
  DesktopSidebarSectionHeader,
} from './DesktopSidebarPrimitives'
import { DesktopSidebarPrioritySection } from './DesktopSidebarPrioritySection'
import { DesktopSidebarTaskViewControl } from './DesktopSidebarTaskViewControl'
import { DesktopWindowControls } from './DesktopWindowControls'
import { MacOSTitleBarDragRegion } from './MacOSTitleBarDragRegion'
import { SidebarSortableList } from './SidebarSortableList'
import { getWorkbenchPaneKey } from './workbenchPaneIdentity'

import { runtimeSidebarScrollMetrics } from '@/features/workbench/runtimeSidebarDiagnostics'
import { isRuntimeTaskSelected } from './runtimeTaskSidebarHelpers'

import {
  SIDEBAR_HEADER_ICON_BUTTON_CLASS,
  getRuntimeTaskSortableId,
  getRuntimeTaskSplitGroup,
} from './desktopSidebarHelpers'
import { ProjectItem } from './DesktopSidebarProjectItem'
import { RuntimeTaskRow } from './DesktopSidebarTaskRow'
import type { DesktopSidebarProps, OpenSettingsOptions } from './desktopSidebarTypes'
import { LocalHarnessSessionRow, SidebarReleaseNotesCard } from './DesktopSidebarWidgets'
import { useDesktopSidebarModel } from './useDesktopSidebarModel'
export function DesktopSidebar(props: DesktopSidebarProps) {
  const model = useDesktopSidebarModel(props)
  const {
    nowMs,
    containerTestId,
    isWindowsDesktop,
    background,
    collapsed,
    onPointerEnter,
    onPointerLeave,
    resizing,
    sidebarWidth,
    usesOverlayTitlebar,
    onToggleSidebar,
    onOpenSearch,
    t,
    selectedTaskViewAction,
    onToggleMyWork,
    taskView,
    priorityFilterActive,
    priorityNeedsAttention,
    priorityFilterShortcut,
    collapseReadShortcut,
    collapsedReadTaskKeys,
    selectTaskViewAction,
    collapseReadTaskView,
    togglePriorityTaskView,
    expandReadTaskView,
    onNewChat,
    onOpenStandIn,
    standInUnreadCount,
    activeItem,
    sidebarWorklistsScrollRef,
    sidebarScrolled,
    paneDragOutsideSidebar,
    preserveLockedScrollPosition,
    sidebarScrollDiagnosticsRef,
    currentRuntimeTask,
    currentRuntimeTaskKey,
    currentRuntimeTaskRowVisible,
    runtimeWorkLoad,
    setSidebarScrolled,
    sidebarNavigation,
    devices,
    cloudWorkStatus,
    onOpenSettings,
    onSelectStandaloneDevice,
    onOpenStandaloneFolderProject,
    setStandaloneRemoteDialogIntent,
    setStandaloneWorkspaceDialogMode,
    runtimeWorkLoadStatus,
    priorityView,
    priorityShowPinned,
    setPriorityShowPinned,
    onMarkRuntimeTaskRead,
    unreadPriorityTaskItems,
    onArchiveRuntimeTask,
    markAllPriorityTasksRead,
    openPriorityArchiveDialog,
    isArchivingPriority,
    splitGroupMemberships,
    visibleUnreadRuntimeTaskKeys,
    imNotificationSettings,
    onOpenRuntimeTask,
    onRenameRuntimeTask,
    onSetRuntimeTaskPinned,
    setRuntimeTaskPinnedOptimistically,
    onToggleRuntimeTaskNotification,
    pinnedTaskItems,
    pinnedProjects,
    visiblePinnedTaskItems,
    onSetRuntimeProjectPinned,
    sidebarStateDeviceId,
    displayedExpandedProjectIds,
    localHarnessSessionsByProjectId,
    activeLocalHarnessSessionId,
    handleToggleProject,
    onStartNewProjectChat,
    onRemoveProject,
    onCreatePermanentWorktree,
    onReorderRuntimeProjects,
    onSetRuntimeProjectAppearance,
    onReorderRuntimeProjectTasks,
    openProjectEditor,
    onArchiveProjectConversations,
    onOpenLocalHarnessSession,
    onCloseLocalHarnessSession,
    displayedProjectsExpanded,
    sidebarProjects,
    setProjectsExpanded,
    onArchiveProjectsConversations,
    projectSectionArchiveCount,
    isArchivingProjectSection,
    setArchiveSectionMode,
    showOfflineDeviceItems,
    setShowOfflineDeviceItems,
    openProjectCreateDialog,
    projectCreateDialogOpen,
    showEmptyProjectCreateAction,
    regularSortableProjects,
    displayedChatsExpanded,
    standaloneLocalHarnessSessions,
    chatTaskItemsWithPinState,
    handleToggleChats,
    onArchiveChatConversations,
    chatSectionArchiveCount,
    isArchivingChatSection,
    onStartStandaloneChat,
    regularChatTaskItems,
    installedReleaseNotes,
    setReleaseNotesDialogOpen,
    appUpdate,
    user,
    onLogout,
    settingsMenuRef,
    hideResizeHandle,
    handleResizeStart,
  } = model
  return (
    <aside
      data-testid={containerTestId}
      data-sidebar-translucent={
        isWindowsDesktop && !(background.imagePath && background.inSidebar) ? 'false' : undefined
      }
      aria-hidden={collapsed}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      className={cn(
        'group/sidebar relative h-full shrink-0 overflow-visible transition-[width,background-color] duration-[300ms] ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none will-change-[width]',
        background.imagePath && background.inSidebar
          ? 'bg-background/25'
          : 'bg-[rgb(var(--color-sidebar))]',
        resizing && 'transition-none',
        collapsed && 'pointer-events-none'
      )}
      style={{ width: collapsed ? 0 : sidebarWidth }}
    >
      <div className="h-full overflow-hidden">
        <div
          className={cn(
            'relative flex h-full flex-col px-1.5',
            usesOverlayTitlebar ? 'pt-[44px]' : 'pt-1.5'
          )}
          style={{ width: sidebarWidth }}
        >
          {usesOverlayTitlebar && (
            <MacOSTitleBarDragRegion className="absolute inset-x-0 top-0 z-0 h-[38px]" />
          )}
          {usesOverlayTitlebar && onToggleSidebar && (
            <div
              data-testid="desktop-sidebar-chrome-controls"
              className={cn(
                'absolute inset-x-0 top-0 z-chrome flex h-[38px] items-center justify-between pr-2',
                'pl-[92px]'
              )}
            >
              <DesktopWindowControls
                sidebarCollapsed={false}
                onToggleSidebar={onToggleSidebar}
                className="gap-1"
                buttonClassName={SIDEBAR_HEADER_ICON_BUTTON_CLASS}
              />
            </div>
          )}
          <DesktopSidebarHeader
            actions={
              <>
                {onToggleSidebar && (
                  <DesktopWindowControls
                    sidebarCollapsed={false}
                    onToggleSidebar={onToggleSidebar}
                    className="gap-0"
                    buttonClassName={SIDEBAR_HEADER_ICON_BUTTON_CLASS}
                  />
                )}
                {onOpenSearch && (
                  <Tooltip
                    label={t('workbench.search')}
                    side="bottom"
                    align="end"
                    testId="runtime-search-tooltip"
                  >
                    <ControlButton
                      variant="unstyled"
                      type="button"
                      data-testid="runtime-search-button"
                      onClick={onOpenSearch}
                      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-[rgb(var(--color-sidebar-text-primary))] hover:bg-[rgb(var(--color-sidebar-hover))] focus-visible:outline-none keyboard:focus-visible:ring-1 keyboard:focus-visible:ring-focus wework:keyboard:focus-visible:ring-blue-500"
                      aria-label={t('workbench.search')}
                    >
                      <Search className="h-4 w-4" />
                    </ControlButton>
                  </Tooltip>
                )}
                <DesktopSidebarTaskViewControl
                  action={selectedTaskViewAction}
                  boardAvailable={Boolean(onToggleMyWork)}
                  boardActive={taskView === 'default-work-items'}
                  priorityActive={priorityFilterActive}
                  priorityNeedsAttention={priorityNeedsAttention}
                  priorityShortcut={priorityFilterShortcut}
                  collapseReadShortcut={collapseReadShortcut}
                  hasCollapsedReadConversations={collapsedReadTaskKeys.size > 0}
                  onSelect={selectTaskViewAction}
                  onRun={
                    selectedTaskViewAction === 'collapse-read'
                      ? collapseReadTaskView
                      : selectedTaskViewAction === 'board'
                        ? () => onToggleMyWork?.()
                        : togglePriorityTaskView
                  }
                  onExpandReadConversations={expandReadTaskView}
                />
              </>
            }
          />
          <nav className="space-y-0.5">
            <DesktopSidebarNavItem
              icon={Plus}
              label={t('workbench.new_task')}
              testId="new-chat-button"
              onClick={onNewChat}
            />
            {onOpenStandIn && (
              <DesktopSidebarNavItem
                icon={UserRound}
                label={t('standIn.title')}
                testId="personal-stand-in-button"
                badge={
                  <>
                    <BetaBadge testId="personal-stand-in-beta" />
                    {standInUnreadCount > 0 && (
                      <span
                        data-testid="personal-stand-in-unread-count"
                        aria-label={t('notifications.total_unread', { count: standInUnreadCount })}
                        className="ml-auto min-w-5 rounded-full bg-text-primary px-1.5 text-center text-xs tabular-nums text-background"
                      >
                        {standInUnreadCount > 99 ? '99+' : standInUnreadCount}
                      </span>
                    )}
                  </>
                }
                selected={activeItem === 'stand-in'}
                onClick={onOpenStandIn}
              />
            )}
          </nav>

          <SidebarWorklistsScroll
            viewportRef={sidebarWorklistsScrollRef}
            scrolled={sidebarScrolled}
            locked={paneDragOutsideSidebar}
            onScroll={event => {
              const viewport = event.currentTarget
              const scrollLocked = preserveLockedScrollPosition(event)
              sidebarScrollDiagnosticsRef.current.record(
                () =>
                  runtimeSidebarScrollMetrics(
                    viewport,
                    currentRuntimeTask
                      ? document.querySelector(
                          `[data-testid="runtime-local-task-row-${currentRuntimeTask.taskId}"]`
                        )
                      : null
                  ),
                {
                  taskId: currentRuntimeTask?.taskId ?? null,
                  taskKey: currentRuntimeTaskKey,
                  rowVisible: currentRuntimeTaskRowVisible,
                  loadPhase: runtimeWorkLoad?.phase ?? null,
                  scrollLocked,
                }
              )
              if (scrollLocked) return
              setSidebarScrolled(viewport.scrollTop > 0)
            }}
          >
            <nav className="mb-4 space-y-0.5">
              {sidebarNavigation.map(item => {
                if (item.surface === 'module') {
                  return (
                    <DshSidebarNavigationSurface
                      key={item.id}
                      item={item}
                      devices={devices}
                      cloudWorkStatus={cloudWorkStatus}
                      selected={activeItem === (item.activeItem ?? item.id)}
                      onNavigate={navigateTo}
                      onOpenSettings={settingsPage =>
                        onOpenSettings({
                          settingsPage: settingsPage as OpenSettingsOptions['settingsPage'],
                        })
                      }
                      onSelectStandaloneDevice={onSelectStandaloneDevice}
                      onAddRemoteDevice={() => {
                        if (onOpenStandaloneFolderProject) {
                          onOpenStandaloneFolderProject('remote', 'add-device')
                        } else {
                          setStandaloneRemoteDialogIntent('add-device')
                          setStandaloneWorkspaceDialogMode('remote')
                        }
                      }}
                    />
                  )
                }

                return (
                  <DesktopSidebarNavItem
                    key={item.id}
                    iconElement={
                      <DshIcon
                        name={item.icon}
                        aria-hidden="true"
                        className="h-4 w-4 text-current"
                      />
                    }
                    label={t(item.labelKey ?? item.id, item.label)}
                    testId={item.testId ?? `dsh-sidebar-navigation-${item.id}`}
                    selected={activeItem === (item.activeItem ?? item.id)}
                    onClick={() => {
                      if (item.workspaceSidebarTab) {
                        rightWorkspaceDshSidebar.openTab({ type: item.workspaceSidebarTab })
                        return
                      }
                      if (item.path) navigateTo(item.path)
                    }}
                    onPointerEnter={
                      item.prefetch ? () => prefetchDshSidebarNavigation(item) : undefined
                    }
                  />
                )
              })}
            </nav>
            {priorityFilterActive && runtimeWorkLoadStatus}
            {priorityFilterActive ? (
              <DesktopSidebarPrioritySection
                priorityItems={priorityView.priorityItems}
                pinnedItems={priorityView.pinnedItems}
                recentGroups={priorityView.recentGroups}
                getTaskKey={item => getRuntimeTaskSortableId(item.workspace, item.task)}
                showPinned={priorityShowPinned}
                onTogglePinned={() => setPriorityShowPinned(showPinned => !showPinned)}
                canMarkAllAsRead={
                  Boolean(onMarkRuntimeTaskRead) && unreadPriorityTaskItems.length > 0
                }
                canArchivePriority={
                  !isArchivingPriority &&
                  Boolean(onArchiveRuntimeTask) &&
                  priorityView.priorityItems.length > 0
                }
                onMarkAllAsRead={markAllPriorityTasksRead}
                onArchivePriority={openPriorityArchiveDialog}
                renderTaskItem={item => (
                  <RuntimeTaskRow
                    nowMs={nowMs}
                    workspace={item.workspace}
                    devices={devices}
                    task={item.task}
                    projectName={item.projectName}
                    selected={
                      getRuntimeTaskSplitGroup(splitGroupMemberships, item.workspace, item.task)
                        ?.active ||
                      isRuntimeTaskSelected(currentRuntimeTask, item.workspace, item.task)
                    }
                    splitGroup={getRuntimeTaskSplitGroup(
                      splitGroupMemberships,
                      item.workspace,
                      item.task
                    )}
                    unread={visibleUnreadRuntimeTaskKeys.has(
                      getRuntimeTaskReminderItemKey(item.workspace, item.task)
                    )}
                    priorityReason={item.reason ?? undefined}
                    priorityLayout
                    indentClassName="pl-2"
                    imNotificationSettings={imNotificationSettings}
                    showDeviceMarker={false}
                    stateDeviceId={item.projectStateDeviceId}
                    onOpenRuntimeTask={onOpenRuntimeTask}
                    onMarkRuntimeTaskRead={onMarkRuntimeTaskRead}
                    onRenameRuntimeTask={onRenameRuntimeTask}
                    onArchiveRuntimeTask={onArchiveRuntimeTask}
                    onSetRuntimeTaskPinned={
                      onSetRuntimeTaskPinned ? setRuntimeTaskPinnedOptimistically : undefined
                    }
                    onToggleRuntimeTaskNotification={onToggleRuntimeTaskNotification}
                  />
                )}
              />
            ) : (
              <>
                {(pinnedTaskItems.length > 0 || pinnedProjects.length > 0) && (
                  <section data-testid="sidebar-pinned-section" className="mb-5">
                    <div
                      data-testid="sidebar-pinned-section-header"
                      className="mb-1 flex h-[30px] items-center px-2.5 text-xs font-medium leading-4 text-[rgb(var(--color-sidebar-text-muted))] opacity-75"
                    >
                      {t('workbench.pinned')}
                    </div>
                    {visiblePinnedTaskItems.length > 0 && (
                      <SidebarSortableList
                        testId="pinned-runtime-task-sortable-list"
                        accessibleLabel={t('workbench.pinned') + ' · ' + t('workbench.chats')}
                        className="space-y-0.5"
                        items={visiblePinnedTaskItems}
                        getId={({ workspace, task }) => getRuntimeTaskSortableId(workspace, task)}
                        getLabel={({ task }) => task.title}
                        getExternalDragData={({ workspace, task }) => ({
                          paneKey: getWorkbenchPaneKey({
                            currentRuntimeTask: {
                              deviceId: workspace.deviceId,
                              taskId: task.taskId,
                            },
                            currentProject: null,
                          }),
                          title: task.title,
                        })}
                        canDrag={({ task }) =>
                          Boolean(getRuntimeTaskThreadId(task) && onSetRuntimeTaskPinned)
                        }
                        onMove={async (moved, before) => {
                          const movedThreadId = getRuntimeTaskThreadId(moved.task)
                          if (!movedThreadId || !onSetRuntimeTaskPinned) {
                            throw new Error('Pinned task ordering is unavailable')
                          }
                          const movedDeviceId =
                            moved.projectWork?.project.stateDeviceId || moved.workspace.deviceId
                          const beforeDeviceId =
                            before?.projectWork?.project.stateDeviceId || before?.workspace.deviceId
                          if (beforeDeviceId && beforeDeviceId !== movedDeviceId) {
                            throw new Error(
                              'Pinned tasks from different devices cannot be reordered'
                            )
                          }
                          await onSetRuntimeTaskPinned({
                            deviceId: movedDeviceId,
                            threadId: movedThreadId,
                            pinned: true,
                            beforeThreadId: before ? getRuntimeTaskThreadId(before.task) : null,
                          })
                        }}
                        renderItem={({ workspace, task, projectWork }) => (
                          <RuntimeTaskRow
                            nowMs={nowMs}
                            workspace={workspace}
                            devices={devices}
                            task={task}
                            projectName={projectWork?.project.name}
                            selected={
                              getRuntimeTaskSplitGroup(splitGroupMemberships, workspace, task)
                                ?.active ||
                              isRuntimeTaskSelected(currentRuntimeTask, workspace, task)
                            }
                            splitGroup={getRuntimeTaskSplitGroup(
                              splitGroupMemberships,
                              workspace,
                              task
                            )}
                            unread={visibleUnreadRuntimeTaskKeys.has(
                              getRuntimeTaskReminderItemKey(workspace, task)
                            )}
                            marked
                            indentClassName="pl-2.5"
                            imNotificationSettings={imNotificationSettings}
                            showDeviceMarker={false}
                            stateDeviceId={projectWork?.project.stateDeviceId || workspace.deviceId}
                            onOpenRuntimeTask={onOpenRuntimeTask}
                            onMarkRuntimeTaskRead={onMarkRuntimeTaskRead}
                            onSetRuntimeTaskPinned={
                              onSetRuntimeTaskPinned
                                ? setRuntimeTaskPinnedOptimistically
                                : undefined
                            }
                            onRenameRuntimeTask={onRenameRuntimeTask}
                            onArchiveRuntimeTask={onArchiveRuntimeTask}
                            onToggleRuntimeTaskNotification={onToggleRuntimeTaskNotification}
                          />
                        )}
                      />
                    )}
                    {pinnedProjects.length > 0 && (
                      <SidebarSortableList
                        testId="pinned-runtime-project-sortable-list"
                        accessibleLabel={t('workbench.pinned') + ' · ' + t('workbench.projects')}
                        className="mt-1 space-y-1"
                        items={pinnedProjects}
                        getId={({ project }) => `project:${project.id}`}
                        getLabel={({ project }) => project.name}
                        canDrag={({ runtimeProjectWork }) =>
                          Boolean(runtimeProjectWork?.project.key && onSetRuntimeProjectPinned)
                        }
                        onMove={async (moved, before) => {
                          const movedProject = moved.runtimeProjectWork?.project
                          const beforeProject = before?.runtimeProjectWork?.project
                          const deviceId =
                            sidebarStateDeviceId ||
                            movedProject?.stateDeviceId ||
                            moved.runtimeProjectWork?.deviceWorkspaces[0]?.deviceId
                          if (!movedProject || !deviceId || !onSetRuntimeProjectPinned) {
                            throw new Error('Pinned project ordering is unavailable')
                          }
                          await onSetRuntimeProjectPinned({
                            deviceId,
                            projectKey: getRuntimeProjectSidebarStateKey(movedProject),
                            pinned: true,
                            beforeProjectKey: beforeProject
                              ? getRuntimeProjectSidebarStateKey(beforeProject)
                              : null,
                          })
                        }}
                        renderItem={({ project, runtimeProjectWork }) => (
                          <ProjectItem
                            nowMs={nowMs}
                            project={project}
                            expanded={displayedExpandedProjectIds.has(project.id)}
                            localHarnessSessions={
                              localHarnessSessionsByProjectId.get(project.id) ?? []
                            }
                            activeLocalHarnessSessionId={activeLocalHarnessSessionId}
                            devices={devices}
                            runtimeProjectWork={runtimeProjectWork}
                            currentRuntimeTask={currentRuntimeTask}
                            splitGroupMemberships={splitGroupMemberships}
                            unreadTaskKeys={visibleUnreadRuntimeTaskKeys}
                            collapsedReadTaskKeys={collapsedReadTaskKeys}
                            imNotificationSettings={imNotificationSettings}
                            showDeviceMarker={false}
                            sidebarStateDeviceId={sidebarStateDeviceId}
                            onToggleProject={handleToggleProject}
                            onStartNewProjectChat={onStartNewProjectChat}
                            onRemoveProject={onRemoveProject}
                            onCreatePermanentWorktree={onCreatePermanentWorktree}
                            onReorderRuntimeProjects={onReorderRuntimeProjects}
                            onSetRuntimeProjectPinned={onSetRuntimeProjectPinned}
                            onSetRuntimeProjectAppearance={onSetRuntimeProjectAppearance}
                            onReorderRuntimeProjectTasks={onReorderRuntimeProjectTasks}
                            onSetRuntimeTaskPinned={
                              onSetRuntimeTaskPinned
                                ? setRuntimeTaskPinnedOptimistically
                                : undefined
                            }
                            onRenameProject={openProjectEditor}
                            onOpenRuntimeTask={onOpenRuntimeTask}
                            onMarkRuntimeTaskRead={onMarkRuntimeTaskRead}
                            onRenameRuntimeTask={onRenameRuntimeTask}
                            onArchiveRuntimeTask={onArchiveRuntimeTask}
                            onArchiveProjectConversations={onArchiveProjectConversations}
                            onToggleRuntimeTaskNotification={onToggleRuntimeTaskNotification}
                            onOpenLocalHarnessSession={onOpenLocalHarnessSession}
                            onCloseLocalHarnessSession={onCloseLocalHarnessSession}
                          />
                        )}
                      />
                    )}
                  </section>
                )}
                <section>
                  <div>
                    <DesktopSidebarSectionHeader
                      title={t('workbench.sidebar_project_spaces', '项目空间')}
                      expanded={displayedProjectsExpanded}
                      hasContent={sidebarProjects.length > 0}
                      toggleTestId="projects-section-toggle"
                      iconTestId="projects-section-chevron-right"
                      onToggle={() => setProjectsExpanded(expanded => !expanded)}
                    >
                      <div className="flex items-center">
                        <ActionMenu
                          ariaLabel={t('workbench.project_list_actions', '项目列表操作')}
                          testId="projects-section-menu"
                          items={[
                            {
                              label: t('workbench.archive_all_chats', '归档所有聊天'),
                              icon: Archive,
                              testId: 'projects-section-archive-all-chats',
                              disabled:
                                !onArchiveProjectsConversations ||
                                projectSectionArchiveCount === 0 ||
                                isArchivingProjectSection,
                              onSelect: () => setArchiveSectionMode('projects'),
                            },
                            {
                              label: t(
                                'workbench.show_offline_device_items',
                                '显示离线设备中的项目和任务'
                              ),
                              testId: 'projects-section-show-offline-device-items',
                              checked: showOfflineDeviceItems,
                              onSelect: () => setShowOfflineDeviceItems(visible => !visible),
                            },
                          ]}
                          density="compact"
                          triggerClassName="flex items-center justify-center rounded-md text-[rgb(var(--color-sidebar-text-secondary))] hover:bg-[rgb(var(--color-sidebar-hover))] hover:text-[rgb(var(--color-sidebar-text-primary))]"
                        />
                        <Tooltip
                          label={t('workbench.new_project', '新建项目')}
                          testId="projects-create-button-tooltip"
                        >
                          <ControlButton
                            variant="unstyled"
                            type="button"
                            aria-label={t('workbench.new_project', '新建项目')}
                            data-testid="projects-create-button"
                            onClick={event => {
                              event.stopPropagation()
                              openProjectCreateDialog(event)
                            }}
                            className="flex h-8 w-8 items-center justify-center rounded-md text-[rgb(var(--color-sidebar-text-secondary))] hover:bg-[rgb(var(--color-sidebar-hover))] hover:text-[rgb(var(--color-sidebar-text-primary))]"
                            aria-expanded={projectCreateDialogOpen}
                          >
                            <FolderPlus className="h-4 w-4" />
                          </ControlButton>
                        </Tooltip>
                      </div>
                    </DesktopSidebarSectionHeader>
                  </div>
                  <DesktopSidebarProjectCreateMenu {...model.projectCreateMenu} />
                  {displayedProjectsExpanded && (
                    <>
                      {showEmptyProjectCreateAction && (
                        <DesktopSidebarNavItem
                          icon={Plus}
                          label={t('workbench.new_project', '新建项目')}
                          testId="projects-empty-create-button"
                          onClick={openProjectCreateDialog}
                        />
                      )}
                      {sidebarProjects.length > 0 && (
                        <SidebarSortableList
                          testId="runtime-project-sortable-list"
                          accessibleLabel={t('workbench.projects')}
                          className="space-y-1"
                          items={regularSortableProjects}
                          getId={({ project }) => `project:${project.id}`}
                          getLabel={({ project }) => project.name}
                          canDrag={({ runtimeProjectWork }) =>
                            Boolean(runtimeProjectWork?.project.key && onReorderRuntimeProjects)
                          }
                          onMove={async (moved, before) => {
                            const movedRuntimeProject = moved.runtimeProjectWork
                            if (!movedRuntimeProject || !onReorderRuntimeProjects) {
                              throw new Error('Runtime project ordering is unavailable')
                            }
                            const request = getRuntimeProjectReorderRequest(
                              movedRuntimeProject,
                              before?.runtimeProjectWork,
                              sidebarStateDeviceId
                            )
                            if (!request) throw new Error('Runtime project ordering is unavailable')
                            await onReorderRuntimeProjects(request)
                          }}
                          renderItem={({ project, runtimeProjectWork }) => (
                            <ProjectItem
                              nowMs={nowMs}
                              project={project}
                              expanded={displayedExpandedProjectIds.has(project.id)}
                              localHarnessSessions={
                                localHarnessSessionsByProjectId.get(project.id) ?? []
                              }
                              activeLocalHarnessSessionId={activeLocalHarnessSessionId}
                              devices={devices}
                              runtimeProjectWork={runtimeProjectWork}
                              currentRuntimeTask={currentRuntimeTask}
                              splitGroupMemberships={splitGroupMemberships}
                              unreadTaskKeys={visibleUnreadRuntimeTaskKeys}
                              collapsedReadTaskKeys={collapsedReadTaskKeys}
                              imNotificationSettings={imNotificationSettings}
                              showDeviceMarker={false}
                              sidebarStateDeviceId={sidebarStateDeviceId}
                              onToggleProject={handleToggleProject}
                              onStartNewProjectChat={onStartNewProjectChat}
                              onRemoveProject={onRemoveProject}
                              onCreatePermanentWorktree={onCreatePermanentWorktree}
                              onReorderRuntimeProjects={onReorderRuntimeProjects}
                              onSetRuntimeProjectPinned={onSetRuntimeProjectPinned}
                              onSetRuntimeProjectAppearance={onSetRuntimeProjectAppearance}
                              onReorderRuntimeProjectTasks={onReorderRuntimeProjectTasks}
                              onSetRuntimeTaskPinned={
                                onSetRuntimeTaskPinned
                                  ? setRuntimeTaskPinnedOptimistically
                                  : undefined
                              }
                              onRenameProject={openProjectEditor}
                              onOpenRuntimeTask={onOpenRuntimeTask}
                              onMarkRuntimeTaskRead={onMarkRuntimeTaskRead}
                              onRenameRuntimeTask={onRenameRuntimeTask}
                              onArchiveRuntimeTask={onArchiveRuntimeTask}
                              onArchiveProjectConversations={onArchiveProjectConversations}
                              onToggleRuntimeTaskNotification={onToggleRuntimeTaskNotification}
                              onOpenLocalHarnessSession={onOpenLocalHarnessSession}
                              onCloseLocalHarnessSession={onCloseLocalHarnessSession}
                            />
                          )}
                        />
                      )}
                    </>
                  )}
                </section>

                <section data-testid="runtime-chat-section" className="mt-8">
                  <DesktopSidebarSectionHeader
                    title={t('workbench.tasks')}
                    expanded={displayedChatsExpanded}
                    hasContent={
                      standaloneLocalHarnessSessions.length > 0 ||
                      chatTaskItemsWithPinState.length > 0
                    }
                    toggleTestId="runtime-chat-section-toggle"
                    iconTestId="runtime-chat-section-chevron-right"
                    onToggle={handleToggleChats}
                  >
                    <div className="flex items-center">
                      <ActionMenu
                        ariaLabel={t('workbench.chat_list_actions', '对话列表操作')}
                        testId="runtime-chat-section-menu"
                        items={[
                          {
                            label: t('workbench.archive_all_chats', '归档所有聊天'),
                            icon: Archive,
                            testId: 'runtime-chat-section-archive-all-chats',
                            disabled:
                              !onArchiveChatConversations ||
                              chatSectionArchiveCount === 0 ||
                              isArchivingChatSection,
                            onSelect: () => setArchiveSectionMode('chats'),
                          },
                        ]}
                        density="compact"
                        triggerClassName="flex items-center justify-center rounded-md text-[rgb(var(--color-sidebar-text-secondary))] hover:bg-[rgb(var(--color-sidebar-hover))] hover:text-[rgb(var(--color-sidebar-text-primary))]"
                      />
                      <Tooltip
                        label={t('workbench.new_task')}
                        testId="runtime-chat-section-new-chat-tooltip"
                      >
                        <ControlButton
                          variant="unstyled"
                          type="button"
                          aria-label={t('workbench.new_task')}
                          data-testid="runtime-chat-section-new-chat-button"
                          onClick={event => {
                            event.stopPropagation()
                            onStartStandaloneChat()
                          }}
                          className="flex h-8 w-8 items-center justify-center rounded-md text-[rgb(var(--color-sidebar-text-secondary))] hover:bg-[rgb(var(--color-sidebar-hover))] hover:text-[rgb(var(--color-sidebar-text-primary))]"
                        >
                          <MessageSquarePlus className="h-4 w-4" />
                        </ControlButton>
                      </Tooltip>
                    </div>
                  </DesktopSidebarSectionHeader>
                  {runtimeWorkLoadStatus}
                  {displayedChatsExpanded && (
                    <div className="space-y-0.5 pb-2">
                      {standaloneLocalHarnessSessions.length === 0 &&
                      regularChatTaskItems.length === 0 ? (
                        runtimeWorkLoad && props.runtimeWork == null ? null : (
                          <div
                            data-testid="runtime-chat-empty"
                            className="ml-2 rounded-md px-3 py-1.5 text-xs text-[rgb(var(--color-sidebar-text-muted))]"
                          >
                            {chatTaskItemsWithPinState.some(({ task }) => !task.pinned)
                              ? t('workbench.read_conversations_collapsed', '已读会话已收起')
                              : t('workbench.no_chats', '暂无会话')}
                          </div>
                        )
                      ) : regularChatTaskItems.length > 0 ? (
                        <SidebarSortableList
                          testId="runtime-chat-task-sortable-list"
                          accessibleLabel={t('workbench.chats')}
                          className="space-y-0.5"
                          items={regularChatTaskItems}
                          getId={({ workspace, task }) => getRuntimeTaskSortableId(workspace, task)}
                          getLabel={({ task }) => task.title}
                          getExternalDragData={({ workspace, task }) => ({
                            paneKey: getWorkbenchPaneKey({
                              currentRuntimeTask: {
                                deviceId: workspace.deviceId,
                                taskId: task.taskId,
                              },
                              currentProject: null,
                            }),
                            title: task.title,
                          })}
                          canDrag={({ task }) =>
                            Boolean(getRuntimeTaskThreadId(task) && onReorderRuntimeProjectTasks)
                          }
                          onMove={async (moved, before) => {
                            const movedThreadId = getRuntimeTaskThreadId(moved.task)
                            if (!movedThreadId || !onReorderRuntimeProjectTasks) {
                              throw new Error('Runtime task ordering is unavailable')
                            }
                            if (before && before.workspace.deviceId !== moved.workspace.deviceId) {
                              throw new Error(
                                'Tasks from different devices cannot be reordered together'
                              )
                            }
                            const beforeThreadId = before
                              ? getRuntimeTaskThreadId(before.task)
                              : null
                            await onReorderRuntimeProjectTasks({
                              deviceId: moved.workspace.deviceId,
                              projectKey: 'chats',
                              threadId: movedThreadId,
                              beforeThreadId,
                              insertAtEnd: beforeThreadId === null,
                            })
                          }}
                          renderItem={({ workspace, task }) => (
                            <RuntimeTaskRow
                              nowMs={nowMs}
                              workspace={workspace}
                              devices={devices}
                              task={task}
                              projectName={null}
                              selected={
                                getRuntimeTaskSplitGroup(splitGroupMemberships, workspace, task)
                                  ?.active ||
                                isRuntimeTaskSelected(currentRuntimeTask, workspace, task)
                              }
                              splitGroup={getRuntimeTaskSplitGroup(
                                splitGroupMemberships,
                                workspace,
                                task
                              )}
                              unread={visibleUnreadRuntimeTaskKeys.has(
                                getRuntimeTaskReminderItemKey(workspace, task)
                              )}
                              indentClassName="pl-2.5"
                              imNotificationSettings={imNotificationSettings}
                              showDeviceMarker={false}
                              stateDeviceId={workspace.deviceId}
                              onOpenRuntimeTask={onOpenRuntimeTask}
                              onMarkRuntimeTaskRead={onMarkRuntimeTaskRead}
                              onRenameRuntimeTask={onRenameRuntimeTask}
                              onArchiveRuntimeTask={onArchiveRuntimeTask}
                              onSetRuntimeTaskPinned={
                                onSetRuntimeTaskPinned
                                  ? setRuntimeTaskPinnedOptimistically
                                  : undefined
                              }
                              onToggleRuntimeTaskNotification={onToggleRuntimeTaskNotification}
                            />
                          )}
                        />
                      ) : null}
                      {standaloneLocalHarnessSessions.map(session => (
                        <LocalHarnessSessionRow
                          key={session.sessionId}
                          session={session}
                          selected={activeLocalHarnessSessionId === session.sessionId}
                          onOpen={onOpenLocalHarnessSession}
                          onClose={onCloseLocalHarnessSession}
                        />
                      ))}
                    </div>
                  )}
                </section>
              </>
            )}
          </SidebarWorklistsScroll>

          {installedReleaseNotes && (
            <SidebarReleaseNotesCard
              releaseNotes={installedReleaseNotes}
              onOpen={() => setReleaseNotesDialogOpen(true)}
              onDismiss={() => {
                setReleaseNotesDialogOpen(false)
                appUpdate?.dismissInstalledReleaseNotes()
              }}
            />
          )}

          <DesktopSidebarAccount
            user={user}
            onOpenSettings={onOpenSettings}
            onLogout={onLogout}
            containerRef={settingsMenuRef}
          />

          {<DesktopSidebarReleaseNotesDialog {...model.releaseNotesDialog} />}

          <DesktopSidebarStandaloneDialog {...model.standaloneDialog} />
          <DesktopSidebarArchiveDialogs {...model.archiveDialogs} />
          <DesktopSidebarProjectEditDialogs {...model.projectEditDialogs} />
        </div>
      </div>

      {!collapsed && !hideResizeHandle && (
        <ControlButton
          variant="unstyled"
          type="button"
          data-testid="sidebar-resize-handle"
          onPointerDown={handleResizeStart}
          className="absolute right-[-14px] top-0 z-[80] h-full w-[18px] cursor-col-resize touch-none bg-transparent after:absolute after:left-1 after:top-0 after:h-full after:w-px after:bg-transparent after:transition-colors after:duration-150 hover:after:bg-primary/35"
          aria-label={t('workbench.resize_sidebar', '调整侧边栏宽度')}
        />
      )}
    </aside>
  )
}
