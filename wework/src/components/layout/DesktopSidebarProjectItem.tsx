import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import {
  Archive,
  ChevronDown,
  ChevronRight,
  Edit3,
  FolderOpen,
  GitCompareArrows,
  MessageSquarePlus,
  Pin,
  Sparkles,
  X,
} from 'lucide-react'
import { useContext, useMemo, useState } from 'react'

import { ActionMenu } from '@/components/common/ActionMenu'

import { TextInputDialog } from '@/components/common/TextInputDialog'

import { ProjectFolderIcon } from '@/components/projects/ProjectFolderIcon'
import { Tooltip } from '@/components/ui/tooltip'

import { getRuntimeTaskReminderItemKey } from '@/features/workbench/runtimeTaskReminders'
import { getRuntimeTaskThreadId } from '@/features/workbench/workbenchRuntimeHelpers'

import { WorkbenchContext } from '@/features/workbench/workbenchContexts'

import {
  getRuntimeTaskLifecycleKey,
  useRuntimeTaskLifecycleStoreSnapshot,
} from '@/features/workbench/runtimeTaskLifecycle'

import { useTranslation } from '@/hooks/useTranslation'

import { fileManagerRevealLabel } from '@/lib/file-manager'
import { openLocalWorkspace } from '@/lib/local-terminal'

import { getRuntimeProjectSidebarStateKey } from '@/lib/runtime-project-state'
import { cn } from '@/lib/utils'

import type {
  DeviceInfo,
  ProjectWithTasks,
  RuntimeIMNotificationSettingsResponse,
  RuntimeProjectAppearanceRequest,
  RuntimeProjectPinRequest,
  RuntimeProjectReorderRequest,
  RuntimeProjectTaskReorderRequest,
  RuntimeProjectWork,
  RuntimeTaskAddress,
  RuntimeTaskPinRequest,
} from '@/types/api'

import type {
  ArchiveRuntimeConversationsResult,
  ArchiveRuntimeTaskOptions,
  ArchiveRuntimeTaskResult,
} from '@/features/workbench/workbenchContextTypes'
import { getWorkbenchPaneKey } from './workbenchPaneIdentity'

import { SidebarHoverCard } from './SidebarHoverCard'
import { SidebarSortableList } from './SidebarSortableList'

import { ProjectSidebarHoverCardContent } from './ProjectSidebarHoverCardContent'

import {
  RUNTIME_PROJECT_TASK_PREVIEW_LIMIT,
  getNextRuntimeSidebarTaskVisibleLimit,
  getRuntimeSidebarTaskItems,
  getRuntimeTaskAddress,
  getVisibleRuntimeSidebarTaskItems,
  hasExpandedRuntimeSidebarTaskItems,
  hasHiddenRuntimeSidebarTaskItems,
  isRuntimeTaskSelected,
  shortenSidebarHomePath,
} from './runtimeTaskSidebarHelpers'

import {
  PROJECT_APPEARANCE_COLORS,
  PROJECT_APPEARANCE_COLOR_VALUES,
  formatSidebarTemplate,
  getDeviceUnavailableActionTitle,
  getProjectDeviceId,
  getProjectFinderWorkspacePath,
  getProjectHoverSources,
  getRuntimeProjectDeviceState,
  getRuntimeTaskSortableId,
  getRuntimeTaskSplitGroup,
  getSidebarDeviceState,
  isRuntimeRemoteProject,
  isRuntimeTaskWaiting,
  isSidebarDeviceOnline,
  shouldShowProjectDeviceStatus,
} from './desktopSidebarHelpers'
import { RuntimeTaskRow } from './DesktopSidebarTaskRow'
import type { ProjectCreateMenuPosition } from './desktopSidebarTypes'
import {
  ArchiveConversationsConfirmDialog,
  LocalHarnessSessionRow,
  ProjectDeviceInlineStatus,
} from './DesktopSidebarWidgets'
import type { LocalHarnessWorkbenchSession } from './localHarnessWorkbench'
import type { WorkbenchSplitGroupMembership } from './workbenchSplitGroups'
export function ProjectItem({
  nowMs,
  project,
  expanded,
  localHarnessSessions,
  activeLocalHarnessSessionId,
  onToggleProject,
  devices,
  runtimeProjectWork,
  currentRuntimeTask,
  splitGroupMemberships,
  unreadTaskKeys,
  collapsedReadTaskKeys,
  imNotificationSettings,
  showDeviceMarker,
  sidebarStateDeviceId,
  onStartNewProjectChat,
  onRemoveProject,
  onCreatePermanentWorktree,
  onSetRuntimeProjectPinned,
  onSetRuntimeProjectAppearance,
  onReorderRuntimeProjectTasks,
  onSetRuntimeTaskPinned,
  onRenameProject,
  onOpenRuntimeTask,
  onMarkRuntimeTaskRead,
  onRenameRuntimeTask,
  onArchiveRuntimeTask,
  onArchiveProjectConversations,
  onToggleRuntimeTaskNotification,
  onOpenLocalHarnessSession,
  onCloseLocalHarnessSession,
}: {
  nowMs?: number
  project: ProjectWithTasks
  expanded: boolean
  localHarnessSessions: LocalHarnessWorkbenchSession[]
  activeLocalHarnessSessionId: string | null
  onToggleProject: (projectId: number) => void
  devices: DeviceInfo[]
  runtimeProjectWork?: RuntimeProjectWork
  currentRuntimeTask?: RuntimeTaskAddress | null
  splitGroupMemberships: Readonly<Record<string, WorkbenchSplitGroupMembership>>
  unreadTaskKeys: ReadonlySet<string>
  collapsedReadTaskKeys: ReadonlySet<string>
  imNotificationSettings?: RuntimeIMNotificationSettingsResponse | null
  showDeviceMarker: boolean
  sidebarStateDeviceId?: string | null
  onStartNewProjectChat: (projectId: number) => void
  onRemoveProject: (projectId: number) => Promise<void>
  onCreatePermanentWorktree?: (data: {
    deviceId: string
    sourcePath: string
    name: string
  }) => Promise<void>
  onReorderRuntimeProjects?: (data: RuntimeProjectReorderRequest) => Promise<void>
  onSetRuntimeProjectPinned?: (data: RuntimeProjectPinRequest) => Promise<void>
  onSetRuntimeProjectAppearance?: (data: RuntimeProjectAppearanceRequest) => Promise<void>
  onReorderRuntimeProjectTasks?: (data: RuntimeProjectTaskReorderRequest) => Promise<void>
  onSetRuntimeTaskPinned?: (data: RuntimeTaskPinRequest) => Promise<void>
  onRenameProject: (project: ProjectWithTasks, projectWork?: RuntimeProjectWork) => void
  onOpenRuntimeTask?: (address: RuntimeTaskAddress) => Promise<void> | void
  onMarkRuntimeTaskRead?: (address: RuntimeTaskAddress) => void
  onRenameRuntimeTask?: (address: RuntimeTaskAddress, title: string) => Promise<void> | void
  onArchiveRuntimeTask?: (
    address: RuntimeTaskAddress,
    options?: ArchiveRuntimeTaskOptions
  ) => Promise<ArchiveRuntimeTaskResult | void> | ArchiveRuntimeTaskResult | void
  onArchiveProjectConversations?: (
    runtimeProjectKey: string,
    options?: ArchiveRuntimeTaskOptions
  ) => Promise<ArchiveRuntimeConversationsResult | void> | ArchiveRuntimeConversationsResult | void
  onToggleRuntimeTaskNotification?: (
    address: RuntimeTaskAddress,
    subscribed: boolean
  ) => Promise<void> | void
  onOpenLocalHarnessSession?: (sessionId: string) => void
  onCloseLocalHarnessSession?: (sessionId: string) => void | Promise<void>
}) {
  const { t } = useTranslation('common')
  const workbench = useContext(WorkbenchContext)
  const lifecycleSnapshot = useRuntimeTaskLifecycleStoreSnapshot()
  const waitingTaskKeys = useMemo(
    () =>
      new Set(
        [...lifecycleSnapshot.tasks.entries()]
          .filter(([, lifecycle]) => lifecycle.derived.shouldShowSidebarWaiting)
          .map(([key]) => key)
      ),
    [lifecycleSnapshot.tasks]
  )
  const runtimeWorkspaces = runtimeProjectWork?.deviceWorkspaces
  const allRuntimeTaskItems = useMemo(
    () => getRuntimeSidebarTaskItems(runtimeWorkspaces ?? []),
    [runtimeWorkspaces]
  )
  const runtimeTaskItems = useMemo(
    () =>
      allRuntimeTaskItems.filter(
        ({ workspace, task }) =>
          !task.pinned && !collapsedReadTaskKeys.has(getRuntimeTaskReminderItemKey(workspace, task))
      ),
    [allRuntimeTaskItems, collapsedReadTaskKeys]
  )
  const [runtimeTaskVisibleLimit, setRuntimeTaskVisibleLimit] = useState(
    RUNTIME_PROJECT_TASK_PREVIEW_LIMIT
  )
  const [projectArchiving, setProjectArchiving] = useState(false)
  const [archiveConfirmOpen, setArchiveConfirmOpen] = useState(false)
  const [forceArchiveConfirmOpen, setForceArchiveConfirmOpen] = useState(false)
  const [removeConfirmOpen, setRemoveConfirmOpen] = useState(false)
  const [createPermanentWorktreeOpen, setCreatePermanentWorktreeOpen] = useState(false)
  const [removingProject, setRemovingProject] = useState(false)
  const [optimisticProjectPinned, setOptimisticProjectPinned] = useState<{
    base: boolean
    value: boolean
  } | null>(null)
  const [projectMenuPosition, setProjectMenuPosition] = useState<ProjectCreateMenuPosition | null>(
    null
  )
  const prioritizedRuntimeTaskItems = runtimeTaskItems
  const visibleRuntimeTaskItems = useMemo(
    () =>
      getVisibleRuntimeSidebarTaskItems(
        prioritizedRuntimeTaskItems,
        runtimeTaskVisibleLimit,
        currentRuntimeTask?.taskId,
        ({ workspace, task }) =>
          lifecycleSnapshot.runningTaskKeys.has(
            getRuntimeTaskLifecycleKey(getRuntimeTaskAddress(workspace, task))
          )
      ),
    [
      currentRuntimeTask?.taskId,
      lifecycleSnapshot.runningTaskKeys,
      prioritizedRuntimeTaskItems,
      runtimeTaskVisibleLimit,
    ]
  )
  const hasHiddenRuntimeTasks = hasHiddenRuntimeSidebarTaskItems(
    prioritizedRuntimeTaskItems,
    visibleRuntimeTaskItems
  )
  const canCollapseRuntimeTasks = hasExpandedRuntimeSidebarTaskItems(
    prioritizedRuntimeTaskItems,
    runtimeTaskVisibleLimit
  )
  const projectDeviceState =
    getRuntimeProjectDeviceState(runtimeProjectWork, devices) ??
    getSidebarDeviceState(getProjectDeviceId(project), devices)
  const showProjectDeviceStatus = shouldShowProjectDeviceStatus(
    projectDeviceState,
    devices,
    isRuntimeRemoteProject(runtimeProjectWork)
  )
  const canStartProjectChat = isSidebarDeviceOnline(projectDeviceState)
  const canArchiveProjectConversations =
    Boolean(runtimeProjectWork?.project.key) &&
    allRuntimeTaskItems.length > 0 &&
    Boolean(onArchiveProjectConversations) &&
    !projectArchiving
  const finderWorkspacePath = getProjectFinderWorkspacePath(project, runtimeProjectWork, devices)
  const permanentWorktreeSource = runtimeWorkspaces?.find(
    workspace => workspace.deviceId.trim() && workspace.workspacePath.trim()
  )
  const newProjectChatTitle =
    projectDeviceState && !canStartProjectChat
      ? getDeviceUnavailableActionTitle(t, projectDeviceState)
      : t('workbench.new_project_chat', '问AI')
  const archiveConversationCount = allRuntimeTaskItems.length
  const archiveProjectName = runtimeProjectWork?.project.name ?? project.name
  const persistedProjectPinned = runtimeProjectWork?.project.pinned ?? false
  const projectPinned =
    optimisticProjectPinned?.base === persistedProjectPinned
      ? optimisticProjectPinned.value
      : persistedProjectPinned
  const projectStateDeviceId =
    sidebarStateDeviceId ??
    runtimeProjectWork?.project.stateDeviceId ??
    runtimeWorkspaces?.[0]?.deviceId ??
    null
  const projectSidebarStateKey = runtimeProjectWork
    ? getRuntimeProjectSidebarStateKey(runtimeProjectWork.project)
    : null
  const projectAppearance = runtimeProjectWork?.project.appearance
  const projectMarker = projectAppearance?.marker
  const projectAppearanceColor = projectAppearance?.color
    ? PROJECT_APPEARANCE_COLOR_VALUES[projectAppearance.color]
    : undefined
  const projectHoverSources = getProjectHoverSources(
    runtimeProjectWork,
    devices,
    t('todo.workflow_execution_local_device', '本机'),
    finderWorkspacePath,
    path => {
      void openLocalWorkspace({ opener: 'file-manager', path })
    },
    path =>
      formatSidebarTemplate(t('workbench.open_project_source'), {
        source: shortenSidebarHomePath(path),
      })
  )
  const projectActiveTaskCount = allRuntimeTaskItems.filter(({ workspace, task }) =>
    lifecycleSnapshot.runningTaskKeys.has(
      getRuntimeTaskLifecycleKey(getRuntimeTaskAddress(workspace, task))
    )
  ).length
  const projectWaitingTaskCount = allRuntimeTaskItems.filter(({ workspace, task }) => {
    const key = getRuntimeTaskLifecycleKey(getRuntimeTaskAddress(workspace, task))
    return waitingTaskKeys.has(key) || isRuntimeTaskWaiting(task)
  }).length
  const projectUnreadTaskCount = allRuntimeTaskItems.filter(({ workspace, task }) =>
    unreadTaskKeys.has(getRuntimeTaskReminderItemKey(workspace, task))
  ).length
  const toggleProjectPinned = async () => {
    const projectKey = projectSidebarStateKey
    if (!projectKey || !projectStateDeviceId || !onSetRuntimeProjectPinned) return
    const nextPinned = !projectPinned
    setOptimisticProjectPinned({ base: persistedProjectPinned, value: nextPinned })
    try {
      await onSetRuntimeProjectPinned({
        deviceId: projectStateDeviceId,
        projectKey,
        pinned: nextPinned,
      })
    } catch {
      setOptimisticProjectPinned(null)
    }
  }
  const cycleProjectAppearance = async () => {
    const projectKey = projectSidebarStateKey
    if (!projectKey || !projectStateDeviceId || !onSetRuntimeProjectAppearance) return
    const currentIndex = PROJECT_APPEARANCE_COLORS.indexOf(
      projectAppearance?.color as (typeof PROJECT_APPEARANCE_COLORS)[number]
    )
    const color = PROJECT_APPEARANCE_COLORS[(currentIndex + 1) % PROJECT_APPEARANCE_COLORS.length]
    try {
      await onSetRuntimeProjectAppearance({
        deviceId: projectStateDeviceId,
        projectKey,
        appearance: { ...projectAppearance, color },
      })
    } catch (error) {
      console.error('[Wework] Failed to update project appearance', error)
      workbench?.setWorkbenchError(
        error instanceof Error ? error.message : t('workbench.change_project_appearance')
      )
    }
  }
  const closeArchiveConfirm = () => {
    setArchiveConfirmOpen(false)
  }
  const runArchiveProjectConversations = async (options?: ArchiveRuntimeTaskOptions) => {
    const runtimeProjectKey = runtimeProjectWork?.project.key
    if (projectArchiving || !runtimeProjectKey || !onArchiveProjectConversations) return
    setArchiveConfirmOpen(false)
    setForceArchiveConfirmOpen(false)
    setProjectArchiving(true)
    try {
      const result = await onArchiveProjectConversations(runtimeProjectKey, options)
      if (result?.status === 'dirty_worktree') {
        setForceArchiveConfirmOpen(true)
      }
    } finally {
      setProjectArchiving(false)
    }
  }
  const confirmArchiveProjectConversations = () => runArchiveProjectConversations()
  const closeForceArchiveConfirm = () => {
    setForceArchiveConfirmOpen(false)
  }
  const confirmForceArchiveProjectConversations = () =>
    runArchiveProjectConversations({ force: true })
  const closeRemoveConfirm = () => {
    if (!removingProject) {
      setRemoveConfirmOpen(false)
    }
  }
  const confirmRemoveProject = async () => {
    setRemovingProject(true)
    try {
      await onRemoveProject(project.id)
      setRemoveConfirmOpen(false)
    } catch (error) {
      console.error('[Wework project removal] failed', error)
    } finally {
      setRemovingProject(false)
    }
  }

  return (
    <div data-testid="project-item" className="space-y-0.5">
      <SidebarHoverCard
        testId={`project-hover-card-${project.id}`}
        interactive
        cardClassName="w-[320px]"
        content={
          <ProjectSidebarHoverCardContent
            project={project}
            remote={isRuntimeRemoteProject(runtimeProjectWork)}
            marker={
              projectMarker?.kind === 'emoji' && 'emoji' in projectMarker ? (
                <span className="text-sm">{String(projectMarker.emoji)}</span>
              ) : undefined
            }
            markerColor={projectAppearanceColor}
            taskCount={allRuntimeTaskItems.length}
            activeCount={projectActiveTaskCount}
            waitingCount={projectWaitingTaskCount}
            unreadCount={projectUnreadTaskCount}
            pinned={projectPinned}
            canPin={Boolean(
              runtimeProjectWork?.project.key && projectStateDeviceId && onSetRuntimeProjectPinned
            )}
            sources={projectHoverSources}
            onTogglePin={() => void toggleProjectPinned()}
            onRename={() => onRenameProject(project)}
          />
        }
      >
        <div
          data-testid={`project-row-${project.id}`}
          onContextMenu={event => {
            event.preventDefault()
            event.stopPropagation()
            setProjectMenuPosition({ left: event.clientX, top: event.clientY })
          }}
          className="group/project relative flex h-[30px] min-w-0 items-center gap-1 rounded-[10px] pl-2.5 pr-1 text-base leading-5 text-[rgb(var(--color-sidebar-text-primary))] hover:bg-[rgb(var(--color-sidebar-hover))]"
        >
          <ControlButton
            variant="unstyled"
            type="button"
            data-testid="project-item-button"
            data-sidebar-drag-activator
            onClick={() => {
              onToggleProject(project.id)
            }}
            aria-expanded={expanded}
            className={cn(
              'flex min-w-0 flex-1 items-center gap-2.5 text-left',
              showProjectDeviceStatus ? 'pr-[132px]' : 'pr-[58px]'
            )}
          >
            <span
              data-testid={`project-drag-activator-${project.id}`}
              className="flex min-w-0 max-w-full items-center gap-2.5"
            >
              <span
                className="flex h-4 w-4 shrink-0 items-center justify-center"
                style={projectAppearanceColor ? { color: projectAppearanceColor } : undefined}
              >
                {projectMarker?.kind === 'emoji' && 'emoji' in projectMarker ? (
                  <span data-testid={`project-appearance-emoji-${project.id}`} className="text-sm">
                    {String(projectMarker.emoji)}
                  </span>
                ) : (
                  <ProjectFolderIcon
                    project={project}
                    remote={isRuntimeRemoteProject(runtimeProjectWork)}
                    open={expanded}
                    className="h-3.5 w-3.5 shrink-0"
                  />
                )}
              </span>
              <span className="flex min-w-0 items-center gap-1.5">
                <span data-testid={`project-title-${project.id}`} className="min-w-0 truncate">
                  {project.name}
                </span>
                <ChevronRight
                  data-testid={`project-collapsed-hover-indicator-${project.id}`}
                  className={cn(
                    'hidden h-3.5 w-3.5 shrink-0 text-[rgb(var(--color-sidebar-text-primary))] opacity-0 transition-opacity',
                    !expanded &&
                      'group-hover/project:block group-hover/project:opacity-100 group-focus-within/project:block group-focus-within/project:opacity-100'
                  )}
                />
                <ChevronDown
                  data-testid={`project-expanded-hover-indicator-${project.id}`}
                  className={cn(
                    'hidden h-3.5 w-3.5 shrink-0 text-[rgb(var(--color-sidebar-text-primary))] opacity-0 transition-opacity',
                    expanded &&
                      'group-hover/project:block group-hover/project:opacity-100 group-focus-within/project:block group-focus-within/project:opacity-100'
                  )}
                />
              </span>
            </span>
          </ControlButton>
          {showProjectDeviceStatus && (
            <ProjectDeviceInlineStatus
              deviceState={projectDeviceState}
              testId={`project-device-status-${project.id}`}
              className="pointer-events-auto absolute right-2 top-1/2 max-w-[124px] -translate-y-1/2 justify-end text-right transition-opacity group-hover/project:opacity-0 group-focus-within/project:opacity-0"
            />
          )}
          <div className="pointer-events-none absolute right-1 top-1/2 z-[70] flex w-[58px] shrink-0 -translate-y-1/2 items-center justify-end opacity-0 transition-opacity group-hover/project:pointer-events-auto group-hover/project:opacity-100 hover:pointer-events-auto hover:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100">
            <ActionMenu
              ariaLabel={t('workbench.project_actions', '项目操作')}
              testId={`project-menu-${project.id}`}
              contextMenuPosition={projectMenuPosition}
              onContextMenuClose={() => setProjectMenuPosition(null)}
              items={[
                {
                  label: projectPinned ? t('workbench.unpin_project') : t('workbench.pin_project'),
                  icon: Pin,
                  testId: `pin-project-${project.id}`,
                  disabled:
                    !runtimeProjectWork?.project.key ||
                    !projectStateDeviceId ||
                    !onSetRuntimeProjectPinned,
                  onSelect: toggleProjectPinned,
                },
                {
                  label: runtimeProjectWork
                    ? t('workbench.edit_project', '编辑项目')
                    : t('workbench.rename_project', '重命名项目'),
                  icon: Edit3,
                  testId:
                    runtimeProjectWork?.project.stateDeviceId === sidebarStateDeviceId &&
                    runtimeProjectWork?.project.source !== 'remote_project'
                      ? `edit-project-${project.id}`
                      : `rename-project-${project.id}`,
                  onSelect: () => onRenameProject(project, runtimeProjectWork),
                },
                {
                  label: t('workbench.change_project_appearance'),
                  icon: Sparkles,
                  testId: `change-project-appearance-${project.id}`,
                  disabled:
                    !runtimeProjectWork?.project.key ||
                    !projectStateDeviceId ||
                    !onSetRuntimeProjectAppearance,
                  onSelect: cycleProjectAppearance,
                },
                ...(finderWorkspacePath
                  ? [
                      {
                        label: fileManagerRevealLabel(t),
                        icon: FolderOpen,
                        testId: `show-project-in-finder-${project.id}`,
                        onSelect: () =>
                          openLocalWorkspace({
                            opener: 'file-manager',
                            path: finderWorkspacePath,
                          }),
                      },
                    ]
                  : []),
                {
                  label: t('workbench.create_permanent_worktree'),
                  icon: GitCompareArrows,
                  testId: `create-permanent-worktree-${project.id}`,
                  disabled: !permanentWorktreeSource || !onCreatePermanentWorktree,
                  onSelect: () => setCreatePermanentWorktreeOpen(true),
                },
                {
                  label: projectArchiving
                    ? t('workbench.archiving_conversations', '归档中...')
                    : t('workbench.archive_all_chats', '归档所有聊天'),
                  icon: Archive,
                  testId: `archive-project-conversations-${project.id}`,
                  disabled: !canArchiveProjectConversations,
                  onSelect: () => setArchiveConfirmOpen(true),
                },
                {
                  label: t('workbench.remove_project', '移除'),
                  icon: X,
                  testId: `remove-project-${project.id}`,
                  danger: true,
                  onSelect: () => setRemoveConfirmOpen(true),
                },
              ]}
              triggerClassName="flex h-7 w-7 items-center justify-center rounded-lg text-[rgb(var(--color-sidebar-text-secondary))] hover:bg-[rgb(var(--color-sidebar-hover))] hover:text-[rgb(var(--color-sidebar-text-primary))]"
            />
            <Tooltip
              label={newProjectChatTitle}
              testId={`project-new-conversation-${project.id}-tooltip`}
            >
              <ControlButton
                variant="unstyled"
                type="button"
                data-testid="project-new-conversation-button"
                disabled={!canStartProjectChat}
                onClick={event => {
                  event.stopPropagation()
                  if (!canStartProjectChat) return
                  onStartNewProjectChat(project.id)
                }}
                className="flex h-7 w-7 items-center justify-center rounded-lg text-[rgb(var(--color-sidebar-text-secondary))] hover:bg-[rgb(var(--color-sidebar-hover))] hover:text-[rgb(var(--color-sidebar-text-primary))] disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent disabled:hover:text-[rgb(var(--color-sidebar-text-secondary))]"
                aria-label={newProjectChatTitle}
              >
                <MessageSquarePlus className="h-4 w-4" />
              </ControlButton>
            </Tooltip>
          </div>
        </div>
      </SidebarHoverCard>
      <TextInputDialog
        open={createPermanentWorktreeOpen}
        title={t('workbench.create_permanent_worktree_title')}
        description={t('workbench.create_permanent_worktree_description')}
        label={t('workbench.project_name')}
        initialValue={`${project.name}_2`}
        confirmLabel={t('workbench.create')}
        cancelLabel={t('workbench.cancel')}
        inputTestId={`permanent-worktree-name-${project.id}`}
        confirmTestId={`confirm-create-permanent-worktree-${project.id}`}
        onClose={() => setCreatePermanentWorktreeOpen(false)}
        onSubmit={async name => {
          if (!permanentWorktreeSource || !onCreatePermanentWorktree) return
          await onCreatePermanentWorktree({
            deviceId: permanentWorktreeSource.deviceId,
            sourcePath: permanentWorktreeSource.workspacePath,
            name,
          })
        }}
      />
      <div
        data-testid={`project-local-tasks-panel-${project.id}`}
        aria-hidden={!expanded}
        className={cn(!expanded && 'hidden')}
      >
        <div>
          <div className="space-y-0.5">
            {runtimeTaskItems.length === 0 && localHarnessSessions.length === 0 ? (
              <div
                data-testid={`project-local-tasks-empty-${project.id}`}
                className="ml-9 rounded-md px-2 py-1.5 text-xs text-[rgb(var(--color-sidebar-text-muted))]"
              >
                {allRuntimeTaskItems.some(({ task }) => !task.pinned)
                  ? t('workbench.read_conversations_collapsed', '已读会话已收起')
                  : t('workbench.no_chats', '暂无会话')}
              </div>
            ) : (
              <>
                <SidebarSortableList
                  testId={`project-runtime-task-sortable-${project.id}`}
                  accessibleLabel={project.name + ' · ' + t('workbench.chats')}
                  className="space-y-0.5"
                  items={visibleRuntimeTaskItems}
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
                    Boolean(
                      getRuntimeTaskThreadId(task) &&
                      runtimeProjectWork?.project.key &&
                      onReorderRuntimeProjectTasks
                    )
                  }
                  onMove={async (moved, before) => {
                    const projectKey = runtimeProjectWork?.project.key
                    const deviceId =
                      runtimeProjectWork?.project.stateDeviceId || moved.workspace.deviceId
                    const movedThreadId = getRuntimeTaskThreadId(moved.task)
                    if (!projectKey || !movedThreadId || !onReorderRuntimeProjectTasks) {
                      throw new Error('Runtime task ordering is unavailable')
                    }
                    const firstHiddenTask = prioritizedRuntimeTaskItems.at(
                      visibleRuntimeTaskItems.length
                    )?.task
                    const beforeThreadId =
                      (before ? getRuntimeTaskThreadId(before.task) : null) ||
                      (firstHiddenTask ? getRuntimeTaskThreadId(firstHiddenTask) : null)
                    await onReorderRuntimeProjectTasks({
                      deviceId,
                      projectKey,
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
                      projectName={runtimeProjectWork?.project.name ?? project.name}
                      selected={
                        getRuntimeTaskSplitGroup(splitGroupMemberships, workspace, task)?.active ||
                        isRuntimeTaskSelected(currentRuntimeTask, workspace, task)
                      }
                      splitGroup={getRuntimeTaskSplitGroup(splitGroupMemberships, workspace, task)}
                      unread={unreadTaskKeys.has(getRuntimeTaskReminderItemKey(workspace, task))}
                      marked={task.pinned}
                      indentClassName="pl-9"
                      statusInIndent
                      imNotificationSettings={imNotificationSettings}
                      showDeviceMarker={showDeviceMarker}
                      onOpenRuntimeTask={onOpenRuntimeTask}
                      onMarkRuntimeTaskRead={onMarkRuntimeTaskRead}
                      stateDeviceId={runtimeProjectWork?.project.stateDeviceId}
                      onSetRuntimeTaskPinned={onSetRuntimeTaskPinned}
                      onRenameRuntimeTask={onRenameRuntimeTask}
                      onArchiveRuntimeTask={onArchiveRuntimeTask}
                      onToggleRuntimeTaskNotification={onToggleRuntimeTaskNotification}
                    />
                  )}
                />
                {localHarnessSessions.map(session => (
                  <LocalHarnessSessionRow
                    key={session.sessionId}
                    session={session}
                    selected={activeLocalHarnessSessionId === session.sessionId}
                    indentClassName="pl-9"
                    onOpen={onOpenLocalHarnessSession}
                    onClose={onCloseLocalHarnessSession}
                  />
                ))}
                {(hasHiddenRuntimeTasks || canCollapseRuntimeTasks) && (
                  <div className="ml-9 flex h-8 items-center gap-2">
                    {hasHiddenRuntimeTasks && (
                      <ControlButton
                        variant="unstyled"
                        type="button"
                        data-testid={`project-runtime-tasks-expand-${project.id}`}
                        onClick={() =>
                          setRuntimeTaskVisibleLimit(currentLimit =>
                            getNextRuntimeSidebarTaskVisibleLimit(
                              currentLimit,
                              prioritizedRuntimeTaskItems.length
                            )
                          )
                        }
                        aria-controls={`project-local-tasks-panel-${project.id}`}
                        className="flex h-[30px] items-center rounded-md px-2 text-left text-base leading-5 text-[rgb(var(--color-sidebar-text-muted))] hover:bg-[rgb(var(--color-sidebar-hover))] hover:text-[rgb(var(--color-sidebar-text-secondary))]"
                      >
                        {t('workbench.show_more', '显示更多')}
                      </ControlButton>
                    )}
                    {canCollapseRuntimeTasks && (
                      <ControlButton
                        variant="unstyled"
                        type="button"
                        data-testid={`project-runtime-tasks-collapse-${project.id}`}
                        onClick={() =>
                          setRuntimeTaskVisibleLimit(RUNTIME_PROJECT_TASK_PREVIEW_LIMIT)
                        }
                        aria-controls={`project-local-tasks-panel-${project.id}`}
                        className="flex h-[30px] items-center rounded-md px-2 text-left text-base leading-5 text-[rgb(var(--color-sidebar-text-muted))] hover:bg-[rgb(var(--color-sidebar-hover))] hover:text-[rgb(var(--color-sidebar-text-secondary))]"
                      >
                        {t('workbench.show_less', '收起')}
                      </ControlButton>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>
      <ArchiveConversationsConfirmDialog
        open={archiveConfirmOpen}
        title={t('workbench.archive_project_dialog_title', {
          defaultValue: '归档 {{count}} 个对话?',
          count: archiveConversationCount,
        })}
        description={t('workbench.archive_project_dialog_desc', {
          defaultValue: '这会将 {{projectName}} 中的对话归档。之后你可以在已归档对话中找到它们',
          projectName: archiveProjectName,
        })}
        confirmLabel={t('workbench.archive_project_dialog_confirm', '全部归档')}
        cancelLabel={t('workbench.cancel', '取消')}
        testId={`archive-project-conversations-dialog-${project.id}`}
        onClose={closeArchiveConfirm}
        onConfirm={confirmArchiveProjectConversations}
      />
      <ArchiveConversationsConfirmDialog
        open={removeConfirmOpen}
        title={t('workbench.remove_project_dialog_title', {
          projectName: project.name,
          defaultValue: '移除 {{projectName}}?',
        })}
        description={t('workbench.remove_project_dialog_desc', {
          defaultValue: '这将从 Wework 中移除该项目。磁盘上的文件不会被删除。',
        })}
        confirmLabel={t('workbench.remove_project_dialog_confirm', '移除')}
        cancelLabel={t('workbench.cancel', '取消')}
        submitting={removingProject}
        testId={`remove-project-dialog-${project.id}`}
        onClose={closeRemoveConfirm}
        onConfirm={confirmRemoveProject}
      />
      <ArchiveConversationsConfirmDialog
        open={forceArchiveConfirmOpen}
        title={t('workbench.archive_runtime_task_dirty_worktree_title')}
        description={t('workbench.archive_runtime_task_dirty_worktree_force_desc')}
        confirmLabel={t('workbench.archive_runtime_task_force_confirm')}
        cancelLabel={t('workbench.cancel', '取消')}
        testId={`archive-project-force-dialog-${project.id}`}
        onClose={closeForceArchiveConfirm}
        onConfirm={confirmForceArchiveProjectConversations}
      />
    </div>
  )
}
