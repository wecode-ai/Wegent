import {
  AlarmClock,
  ArrowDown,
  ArrowUp,
  Edit3,
  Folder,
  FolderOpen,
  FolderPlus,
  GitCompareArrows,
  Loader2,
  Monitor,
  RotateCw,
  Search,
  Sparkles,
  SquarePen,
  X,
} from 'lucide-react'
import { useContext, useMemo, useRef, useState } from 'react'
import { CompositedSpinner } from '@/components/common/CompositedSpinner'
import { ProjectCreateDialog } from '@/components/projects/ProjectCreateDialog'
import { useTranslation } from '@/hooks/useTranslation'
import { usePullToRefresh } from '@/hooks/usePullToRefresh'
import { isImeEnterEvent } from '@/lib/ime'
import { cn } from '@/lib/utils'
import { getRuntimeTaskReminderItemKey } from '@/features/workbench/runtimeTaskReminders'
import {
  getRuntimeTaskLifecycleKey,
  useRuntimeTaskLifecycleStoreSnapshot,
} from '@/features/workbench/runtimeTaskLifecycle'
import { WorkbenchContext } from '@/features/workbench/workbenchContexts'
import { runtimeProjectUiId } from '@/lib/runtime-project'
import type {
  CreateGitWorkspaceProjectRequest,
  CreateProjectRequest,
  DeleteDeviceWorkspaceRequest,
  DeviceWorkspacePrepareRequest,
  DeviceWorkspacePrepareResponse,
  DeviceInfo,
  GitBranch,
  GitRepoInfo,
  ProjectWithTasks,
  RuntimeTaskAddress,
  RuntimeWorkListResponse,
  User,
} from '@/types/api'
import type { RefreshWorkLists } from '@/features/workbench/workbenchContextTypes'
import {
  getRuntimeChatSidebarTaskItems,
  getNextRuntimeSidebarTaskVisibleLimit,
  getRuntimeTaskAddress,
  getRuntimeTaskTime,
  getRuntimeTaskWorkspaceTitle,
  getRuntimeSidebarTaskItems,
  getVisibleRuntimeSidebarTaskItems,
  hasExpandedRuntimeSidebarTaskItems,
  hasHiddenRuntimeSidebarTaskItems,
  isRuntimeTaskQueued,
  isRuntimeTaskSelected,
  isRuntimeWorktreeTask,
  RUNTIME_PROJECT_TASK_PREVIEW_LIMIT,
} from './runtimeTaskSidebarHelpers'
import { formatRelativeSidebarTime, useSidebarRelativeTimeRefresh } from './runtimeSidebarTime'

type ProjectCreateMode = 'scratch' | 'existing' | 'git'

interface MobileDrawerProps {
  open: boolean
  user: User | null
  devices?: DeviceInfo[]
  projects: ProjectWithTasks[]
  runtimeWork?: RuntimeWorkListResponse | null
  currentProjectId?: number
  currentRuntimeTask?: RuntimeTaskAddress | null
  unreadRuntimeTaskKeys?: ReadonlySet<string>
  activeItem?: 'chat' | 'plugins' | 'sites' | 'cloud-work' | 'automation'
  onClose: () => void
  onNewChat?: () => void
  onStartStandaloneChat?: () => void
  onOpenSettings?: () => void
  onCreateProject?: (data: CreateProjectRequest) => Promise<ProjectWithTasks>
  onCreateGitWorkspaceProject?: (
    data: CreateGitWorkspaceProjectRequest
  ) => Promise<ProjectWithTasks>
  onPrepareDeviceWorkspace?: (
    data: DeviceWorkspacePrepareRequest
  ) => Promise<DeviceWorkspacePrepareResponse>
  onDeleteDeviceWorkspace?: (data: DeleteDeviceWorkspaceRequest) => Promise<void>
  onListGitRepositories?: () => Promise<GitRepoInfo[]>
  onListGitBranches?: (repo: GitRepoInfo) => Promise<GitBranch[]>
  onGetDeviceHomeDirectory?: (deviceId: string) => Promise<string>
  onGetProjectWorkspaceRoot?: (deviceId: string) => Promise<string>
  onListDeviceDirectories?: (deviceId: string, path: string) => Promise<string[]>
  onCreateDeviceDirectory?: (deviceId: string, path: string) => Promise<void>
  onUpdateProjectName?: (projectId: number, name: string) => Promise<void>
  onRemoveProject?: (projectId: number) => Promise<void>
  onSelectProject: (projectId: number) => void
  onOpenRuntimeTask?: (address: RuntimeTaskAddress) => Promise<void> | void
  onRefreshWorkLists?: RefreshWorkLists
}

export function MobileDrawer({
  open,
  user,
  devices = [],
  projects,
  runtimeWork,
  currentProjectId,
  currentRuntimeTask,
  unreadRuntimeTaskKeys,
  onClose,
  onNewChat,
  onStartStandaloneChat,
  onOpenSettings,
  onCreateProject,
  onCreateGitWorkspaceProject,
  onPrepareDeviceWorkspace,
  onDeleteDeviceWorkspace,
  onListGitRepositories,
  onListGitBranches,
  onGetDeviceHomeDirectory,
  onGetProjectWorkspaceRoot,
  onListDeviceDirectories,
  onCreateDeviceDirectory,
  onUpdateProjectName,
  onRemoveProject,
  onSelectProject,
  onOpenRuntimeTask,
  onRefreshWorkLists,
}: MobileDrawerProps) {
  useSidebarRelativeTimeRefresh()
  const { t } = useTranslation('common')
  const lifecycleSnapshot = useRuntimeTaskLifecycleStoreSnapshot()
  const workbench = useContext(WorkbenchContext)
  const [forceStartingTaskId, setForceStartingTaskId] = useState<string | null>(null)
  const [queueReordering, setQueueReordering] = useState<{
    taskId: string
    direction: 'up' | 'down'
  } | null>(null)
  const visibleUnreadRuntimeTaskKeys = unreadRuntimeTaskKeys ?? new Set<string>()
  const {
    scrollRef,
    pullDistance,
    refreshing,
    threshold,
    handlers: pullHandlers,
  } = usePullToRefresh(onRefreshWorkLists ?? (async () => {}))
  const [searchOpen, setSearchOpen] = useState(false)
  const [projectCreateMode, setProjectCreateMode] = useState<ProjectCreateMode | null>(null)
  const [projectActionTarget, setProjectActionTarget] = useState<ProjectWithTasks | null>(null)
  const [renamingProjectId, setRenamingProjectId] = useState<number | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [actionMenuPosition, setActionMenuPosition] = useState({
    left: 12,
    top: 12,
  })
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const longPressStartRef = useRef({ x: 0, y: 0 })
  const longPressTriggeredRef = useRef(false)
  const [expandedProjectIds, setExpandedProjectIds] = useState<Set<number>>(() => new Set())
  const [runtimeProjectTaskVisibleLimits, setRuntimeProjectTaskVisibleLimits] = useState<
    Record<number, number>
  >({})
  const runtimeWorkByProjectId = useMemo(() => {
    const items = runtimeWork?.projects ?? []
    return new Map(items.map(item => [runtimeProjectUiId(item.project), item]))
  }, [runtimeWork])
  const chatWorkspaces = useMemo(() => runtimeWork?.chats ?? [], [runtimeWork])
  const chatTaskItems = useMemo(
    () => getRuntimeChatSidebarTaskItems(chatWorkspaces),
    [chatWorkspaces]
  )

  if (!open) return null

  const renderRuntimeTaskRunningStatus = (testId: string) => {
    const label = t('workbench.runtime_task_running')
    return (
      <span
        data-testid={testId}
        role="status"
        aria-label={label}
        title={label}
        className="ml-2 inline-flex h-7 w-7 shrink-0 items-center justify-center text-text-secondary"
      >
        <CompositedSpinner icon={Loader2} className="h-3.5 w-3.5" />
      </span>
    )
  }

  const closeAfter = (action?: () => void) => {
    action?.()
    onClose()
  }

  const forceStartRuntimeTask = async (address: RuntimeTaskAddress) => {
    if (!workbench || forceStartingTaskId) return
    setForceStartingTaskId(address.taskId)
    try {
      await workbench.forceStartRuntimeTask(address)
    } catch (error) {
      console.error('[Wework] Failed to force start queued runtime task on mobile', error)
      workbench.setWorkbenchError(t('workbench.runtime_task_force_start_failed'))
    } finally {
      setForceStartingTaskId(null)
    }
  }

  const reorderQueuedRuntimeTask = async (
    address: RuntimeTaskAddress,
    queuePosition: number,
    direction: 'up' | 'down'
  ) => {
    if (!workbench || queueReordering) return
    setQueueReordering({ taskId: address.taskId, direction })
    try {
      await workbench.reorderQueuedRuntimeTask({
        ...address,
        queuePosition: Math.max(1, queuePosition),
      })
    } catch (error) {
      console.error('[Wework] Failed to reorder queued runtime task on mobile', error)
      workbench.setWorkbenchError(t('workbench.runtime_task_queue_reorder_failed'))
    } finally {
      setQueueReordering(null)
    }
  }

  const renderQueuedTaskActions = (
    address: RuntimeTaskAddress,
    queuePosition: number | null | undefined,
    testIdPrefix: string,
    available: boolean
  ) => (
    <div className="flex shrink-0 items-center">
      <button
        type="button"
        data-testid={`${testIdPrefix}-queue-up-${address.taskId}`}
        disabled={
          !available ||
          !workbench ||
          Boolean(queueReordering) ||
          queuePosition === null ||
          queuePosition === undefined ||
          queuePosition <= 1
        }
        onClick={() => void reorderQueuedRuntimeTask(address, (queuePosition ?? 1) - 1, 'up')}
        className="flex h-12 w-11 items-center justify-center rounded-[14px] text-text-secondary hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
        title={t('workbench.runtime_task_queue_move_up')}
        aria-label={t('workbench.runtime_task_queue_move_up')}
      >
        {queueReordering?.taskId === address.taskId && queueReordering.direction === 'up' ? (
          <RotateCw className="h-4 w-4 animate-spin" />
        ) : (
          <ArrowUp className="h-4 w-4" />
        )}
      </button>
      <button
        type="button"
        data-testid={`${testIdPrefix}-queue-down-${address.taskId}`}
        disabled={
          !available ||
          !workbench ||
          Boolean(queueReordering) ||
          queuePosition === null ||
          queuePosition === undefined
        }
        onClick={() => void reorderQueuedRuntimeTask(address, (queuePosition ?? 1) + 1, 'down')}
        className="flex h-12 w-11 items-center justify-center rounded-[14px] text-text-secondary hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
        title={t('workbench.runtime_task_queue_move_down')}
        aria-label={t('workbench.runtime_task_queue_move_down')}
      >
        {queueReordering?.taskId === address.taskId && queueReordering.direction === 'down' ? (
          <RotateCw className="h-4 w-4 animate-spin" />
        ) : (
          <ArrowDown className="h-4 w-4" />
        )}
      </button>
      <button
        type="button"
        data-testid={`${testIdPrefix}-force-start-${address.taskId}`}
        disabled={!available || !workbench || Boolean(forceStartingTaskId)}
        onClick={() => void forceStartRuntimeTask(address)}
        className="flex h-12 w-11 items-center justify-center rounded-[14px] text-text-secondary hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
        title={t('workbench.runtime_task_force_start')}
        aria-label={t('workbench.runtime_task_force_start')}
      >
        {forceStartingTaskId === address.taskId ? (
          <RotateCw className="h-4 w-4 animate-spin" />
        ) : (
          <Sparkles className="h-4 w-4" />
        )}
      </button>
    </div>
  )

  const canOpenProjectSheet = devices.length > 0
  const unavailableProjectAction = async () => {
    throw new Error(t('workbench.project_create_failed', '项目创建失败'))
  }

  const getUserInitials = () => {
    const name = user?.user_name?.trim()
    if (!name) return t('workbench.user_fallback', '我')
    return name.slice(0, 2).toUpperCase()
  }

  const toggleProject = (projectId: number) => {
    setExpandedProjectIds(previous => {
      const next = new Set(previous)
      if (next.has(projectId)) {
        next.delete(projectId)
      } else {
        next.add(projectId)
      }
      return next
    })
    onSelectProject(projectId)
  }

  const openProjectCreateDialog = () => {
    setProjectCreateMode('scratch')
  }

  const cancelLongPress = () => {
    if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current)
    longPressTimerRef.current = null
  }

  const positionActionMenu = (clientX: number, clientY: number, rowCount: number) => {
    const menuWidth = 240
    const menuHeight = rowCount * 56 + 16
    setActionMenuPosition({
      left: Math.min(Math.max(12, clientX - 24), window.innerWidth - menuWidth - 12),
      top: Math.min(Math.max(12, clientY + 12), window.innerHeight - menuHeight - 12),
    })
  }

  const startLongPress = (
    clientX: number,
    clientY: number,
    rowCount: number,
    onTrigger: () => void
  ) => {
    cancelLongPress()
    longPressTriggeredRef.current = false
    longPressStartRef.current = { x: clientX, y: clientY }
    longPressTimerRef.current = setTimeout(() => {
      longPressTriggeredRef.current = true
      positionActionMenu(clientX, clientY, rowCount)
      onTrigger()
    }, 500)
  }

  const handleAction = async (action: () => Promise<void> | void) => {
    setProjectActionTarget(null)
    await action()
  }

  const submitProjectRename = async (projectId: number) => {
    const name = renameValue.trim()
    if (name && onUpdateProjectName) await onUpdateProjectName(projectId, name)
    setRenamingProjectId(null)
  }

  return (
    <div className="fixed inset-0 z-critical isolate flex h-dvh select-none flex-col overflow-hidden bg-background pb-[max(24px,env(safe-area-inset-bottom))] pt-[max(20px,env(safe-area-inset-top))] text-text-primary">
      <header className="flex shrink-0 items-center justify-between gap-4 px-6">
        <h1 className="text-xl font-bold leading-8 tracking-normal text-text-primary">
          {t('workbench.brand', 'Wework')}
        </h1>
        <div className="flex items-center gap-5">
          <button
            type="button"
            data-testid="mobile-search-icon-button"
            onClick={() => setSearchOpen(open => !open)}
            className="flex h-11 min-w-[44px] items-center justify-center rounded-full text-text-primary hover:bg-muted"
            aria-label={t('workbench.search', '搜索')}
          >
            <Search className="h-7 w-7 stroke-[2.5]" />
          </button>
          <button
            type="button"
            data-testid="mobile-settings-button"
            onClick={() => closeAfter(onOpenSettings)}
            className="flex h-10 w-10 items-center justify-center rounded-full bg-[#8E5BBE] text-sm font-semibold text-white"
            aria-label={t('workbench.settings', '设置')}
          >
            {getUserInitials()}
          </button>
        </div>
      </header>

      {searchOpen && (
        <div className="relative mx-6 mt-6 shrink-0">
          <Search className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-text-secondary" />
          <input
            data-testid="mobile-search-input"
            type="search"
            placeholder={t('workbench.search', '搜索')}
            className="h-12 w-full select-text rounded-2xl border border-border bg-background pl-12 pr-4 text-base leading-5 text-text-primary outline-none placeholder:text-text-secondary focus:bg-muted"
            autoFocus
          />
        </div>
      )}

      <div className="mx-6 mt-7 h-px shrink-0 bg-border" />

      <div
        ref={scrollRef}
        onTouchStart={pullHandlers.onTouchStart}
        onTouchMove={pullHandlers.onTouchMove}
        onTouchEnd={pullHandlers.onTouchEnd}
        className="relative min-h-0 flex-1 overflow-y-auto pb-28 pt-2 scrollbar-none"
        data-testid="mobile-drawer-scroll"
      >
        {onRefreshWorkLists && (pullDistance > 0 || refreshing) && (
          <div
            data-testid="mobile-pull-refresh-indicator"
            className="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-center justify-center"
            style={{ height: refreshing ? threshold : pullDistance }}
          >
            <RotateCw
              className={cn('h-5 w-5 text-text-secondary', refreshing && 'animate-spin')}
              style={
                refreshing
                  ? undefined
                  : {
                      opacity: Math.min(1, pullDistance / threshold),
                      transform: `rotate(${(pullDistance / threshold) * 270}deg)`,
                    }
              }
            />
          </div>
        )}
        <div
          style={{
            transform: pullDistance ? `translateY(${pullDistance}px)` : undefined,
            transition: refreshing || pullDistance === 0 ? 'transform 0.2s ease' : undefined,
          }}
        >
          <section>
            <div className="space-y-1">
              <div className="relative">
                <button
                  type="button"
                  data-testid="mobile-new-project-button"
                  onClick={() => openProjectCreateDialog()}
                  className="mx-3 flex h-[54px] min-w-[44px] w-[calc(100%-24px)] items-center gap-[18px] rounded-[14px] px-3 text-left text-heading-sm font-normal leading-6 text-text-primary hover:bg-muted disabled:cursor-not-allowed disabled:text-text-secondary"
                  disabled={!canOpenProjectSheet}
                >
                  <FolderPlus className="h-6 w-6 shrink-0 stroke-[2.4]" />
                  <span className="min-w-0 truncate">{t('workbench.new_project', '新建项目')}</span>
                </button>
              </div>
              <section className="mt-5" data-testid="mobile-runtime-chat-section">
                <div className="mb-2 px-6 text-heading-sm font-bold leading-6 text-text-primary">
                  {t('workbench.chats', '对话')}
                </div>
                <div className="space-y-1">
                  {chatTaskItems.length === 0 ? (
                    <div
                      data-testid="mobile-runtime-chat-empty"
                      className="mx-3 flex h-10 items-center rounded-lg px-3 text-left text-base text-text-secondary"
                    >
                      {t('workbench.no_chats', '暂无会话')}
                    </div>
                  ) : (
                    chatTaskItems.map(({ workspace, task }) => {
                      const selectedTask = isRuntimeTaskSelected(
                        currentRuntimeTask,
                        workspace,
                        task
                      )
                      const disabled = !workspace.available || !onOpenRuntimeTask
                      const workspaceTitle = getRuntimeTaskWorkspaceTitle(workspace)
                      const queued = isRuntimeTaskQueued(task)
                      const taskAddress = getRuntimeTaskAddress(workspace, task)
                      return (
                        <div
                          key={`${workspace.deviceId}:${task.workspacePath}:${task.taskId}`}
                          className="mx-3 flex w-[calc(100%-24px)] items-center gap-1"
                        >
                          <button
                            type="button"
                            data-testid="mobile-chat-runtime-task-button"
                            disabled={disabled}
                            onClick={() => {
                              if (disabled) return
                              void onOpenRuntimeTask?.(taskAddress)
                              onClose()
                            }}
                            className={[
                              'flex h-12 min-w-[44px] flex-1 items-center rounded-[14px] px-3 text-left text-heading-sm font-normal leading-6 disabled:cursor-not-allowed disabled:opacity-50',
                              selectedTask
                                ? 'bg-muted text-text-primary'
                                : 'text-text-primary hover:bg-muted',
                            ].join(' ')}
                          >
                            <span className="min-w-0 flex-1 truncate">{task.title}</span>
                            {queued ? (
                              <span
                                data-testid={`mobile-chat-runtime-task-queued-${task.taskId}`}
                                role="status"
                                title={t('workbench.runtime_task_queued')}
                                aria-label={t('workbench.runtime_task_queued')}
                                className="ml-2 flex h-7 min-w-7 shrink-0 items-center justify-center gap-1 text-sm text-text-secondary"
                              >
                                <AlarmClock className="h-3.5 w-3.5" />
                                {task.queuePosition ?? null}
                              </span>
                            ) : lifecycleSnapshot.runningTaskKeys.has(
                                getRuntimeTaskLifecycleKey(taskAddress)
                              ) ? (
                              renderRuntimeTaskRunningStatus(
                                `mobile-chat-runtime-task-running-${task.taskId}`
                              )
                            ) : visibleUnreadRuntimeTaskKeys.has(
                                getRuntimeTaskReminderItemKey(workspace, task)
                              ) ? (
                              <span
                                data-testid={`mobile-chat-runtime-task-unread-dot-${task.taskId}`}
                                aria-label={t('workbench.runtime_task_unread', '未读')}
                                title={t('workbench.runtime_task_unread', '未读')}
                                className="ml-2 h-2 w-2 shrink-0 rounded-full bg-primary"
                              />
                            ) : (
                              <span className="ml-2 flex shrink-0 items-center gap-1 text-sm text-text-secondary">
                                <span
                                  title={workspaceTitle}
                                  aria-label={workspaceTitle}
                                  role="img"
                                  className="flex h-3.5 w-3.5 shrink-0 items-center justify-center"
                                >
                                  <Monitor className="h-3.5 w-3.5" aria-hidden="true" />
                                </span>
                                <span>{formatRelativeSidebarTime(getRuntimeTaskTime(task))}</span>
                              </span>
                            )}
                          </button>
                          {queued
                            ? renderQueuedTaskActions(
                                taskAddress,
                                task.queuePosition,
                                'mobile-chat-runtime-task',
                                workspace.available
                              )
                            : null}
                        </div>
                      )
                    })
                  )}
                </div>
              </section>
              {projects.map(project => {
                const runtimeProjectWork = runtimeWorkByProjectId.get(project.id)
                const workspaces = runtimeProjectWork?.deviceWorkspaces ?? []
                const selected = currentProjectId === project.id
                const expanded = expandedProjectIds.has(project.id)

                return (
                  <div key={project.id}>
                    <button
                      type="button"
                      data-testid="mobile-project-item-button"
                      onClick={() => {
                        if (longPressTriggeredRef.current) {
                          longPressTriggeredRef.current = false
                          return
                        }
                        toggleProject(project.id)
                      }}
                      onPointerDown={event =>
                        startLongPress(event.clientX, event.clientY, 2, () =>
                          setProjectActionTarget(project)
                        )
                      }
                      onPointerMove={event => {
                        const { x, y } = longPressStartRef.current
                        if (Math.abs(event.clientX - x) > 10 || Math.abs(event.clientY - y) > 10) {
                          cancelLongPress()
                        }
                      }}
                      onPointerUp={cancelLongPress}
                      onPointerCancel={cancelLongPress}
                      onContextMenu={event => {
                        event.preventDefault()
                        cancelLongPress()
                        longPressTriggeredRef.current = true
                        positionActionMenu(event.clientX, event.clientY, 2)
                        setProjectActionTarget(project)
                      }}
                      aria-expanded={expanded}
                      className={[
                        'mx-3 flex h-[54px] min-w-[44px] w-[calc(100%-24px)] items-center gap-[18px] rounded-[14px] px-3 text-left text-heading-sm font-normal leading-6',
                        selected
                          ? 'bg-muted text-text-primary'
                          : 'text-text-primary hover:bg-muted',
                      ].join(' ')}
                    >
                      {expanded ? (
                        <FolderOpen className="h-6 w-6 shrink-0 stroke-[2.4]" />
                      ) : (
                        <Folder className="h-6 w-6 shrink-0 stroke-[2.4]" />
                      )}
                      {renamingProjectId === project.id ? (
                        <input
                          data-testid="mobile-inline-project-name-input"
                          value={renameValue}
                          autoFocus
                          onFocus={event => event.currentTarget.select()}
                          onClick={event => event.stopPropagation()}
                          onPointerDown={event => event.stopPropagation()}
                          onChange={event => setRenameValue(event.target.value)}
                          onBlur={() => void submitProjectRename(project.id)}
                          onKeyDown={event => {
                            if (isImeEnterEvent(event)) return
                            if (event.key === 'Enter') {
                              event.preventDefault()
                              void submitProjectRename(project.id)
                            } else if (event.key === 'Escape') {
                              event.preventDefault()
                              setRenamingProjectId(null)
                            }
                          }}
                          className="min-w-0 flex-1 select-text rounded-lg border border-border bg-background px-2 py-1 text-heading-sm leading-6 text-text-primary outline-none focus:border-focus"
                        />
                      ) : (
                        <span className="min-w-0 flex-1 truncate">{project.name}</span>
                      )}
                    </button>
                    {expanded && (
                      <div className="ml-[66px] mr-6 mt-1 space-y-1">
                        {(() => {
                          const taskItems = getRuntimeSidebarTaskItems(workspaces)
                          if (taskItems.length === 0) {
                            return (
                              <div className="flex h-10 items-center rounded-lg px-2 text-left text-base text-text-secondary">
                                {t('workbench.no_chats', '暂无会话')}
                              </div>
                            )
                          }

                          const runtimeTaskVisibleLimit =
                            runtimeProjectTaskVisibleLimits[project.id] ??
                            RUNTIME_PROJECT_TASK_PREVIEW_LIMIT
                          const visibleTaskItems = getVisibleRuntimeSidebarTaskItems(
                            taskItems,
                            runtimeTaskVisibleLimit,
                            currentRuntimeTask?.taskId,
                            ({ workspace, task }) =>
                              lifecycleSnapshot.runningTaskKeys.has(
                                getRuntimeTaskLifecycleKey(getRuntimeTaskAddress(workspace, task))
                              )
                          )
                          const hasHiddenTasks = hasHiddenRuntimeSidebarTaskItems(
                            taskItems,
                            runtimeTaskVisibleLimit
                          )
                          const canCollapseTasks = hasExpandedRuntimeSidebarTaskItems(
                            taskItems,
                            runtimeTaskVisibleLimit
                          )

                          return (
                            <>
                              {visibleTaskItems.map(({ workspace, task }) => {
                                const selectedTask = isRuntimeTaskSelected(
                                  currentRuntimeTask,
                                  workspace,
                                  task
                                )
                                const disabled = !workspace.available || !onOpenRuntimeTask
                                const workspaceTitle = getRuntimeTaskWorkspaceTitle(workspace)
                                const queued = isRuntimeTaskQueued(task)
                                const taskAddress = getRuntimeTaskAddress(workspace, task)
                                return (
                                  <div
                                    key={`${workspace.deviceId}:${task.workspacePath}:${task.taskId}`}
                                    className="flex w-full items-center gap-1"
                                  >
                                    <button
                                      type="button"
                                      data-testid="mobile-runtime-task-button"
                                      disabled={disabled}
                                      onClick={() => {
                                        if (disabled) return
                                        void onOpenRuntimeTask?.(taskAddress)
                                        onClose()
                                      }}
                                      className={[
                                        'flex h-12 min-w-[44px] flex-1 items-center rounded-[14px] px-2 text-left text-heading-sm font-normal leading-6 disabled:cursor-not-allowed disabled:opacity-50',
                                        selectedTask
                                          ? 'bg-muted text-text-primary'
                                          : 'text-text-primary hover:bg-muted',
                                      ].join(' ')}
                                    >
                                      <span className="min-w-0 flex-1 truncate">{task.title}</span>
                                      {queued ? (
                                        <span
                                          data-testid={`mobile-runtime-task-queued-${task.taskId}`}
                                          role="status"
                                          title={t('workbench.runtime_task_queued')}
                                          aria-label={t('workbench.runtime_task_queued')}
                                          className="ml-2 flex h-7 min-w-7 shrink-0 items-center justify-center gap-1 text-sm text-text-secondary"
                                        >
                                          <AlarmClock className="h-3.5 w-3.5" />
                                          {task.queuePosition ?? null}
                                        </span>
                                      ) : lifecycleSnapshot.runningTaskKeys.has(
                                          getRuntimeTaskLifecycleKey(taskAddress)
                                        ) ? (
                                        renderRuntimeTaskRunningStatus(
                                          `mobile-runtime-task-running-${task.taskId}`
                                        )
                                      ) : visibleUnreadRuntimeTaskKeys.has(
                                          getRuntimeTaskReminderItemKey(workspace, task)
                                        ) ? (
                                        <span
                                          data-testid={`mobile-runtime-task-unread-dot-${task.taskId}`}
                                          aria-label={t('workbench.runtime_task_unread', '未读')}
                                          title={t('workbench.runtime_task_unread', '未读')}
                                          className="ml-2 h-2 w-2 shrink-0 rounded-full bg-primary"
                                        />
                                      ) : (
                                        <span className="ml-2 flex shrink-0 items-center gap-1 text-sm text-text-secondary">
                                          <span
                                            title={workspaceTitle}
                                            aria-label={workspaceTitle}
                                            role="img"
                                            className="flex h-3.5 w-3.5 shrink-0 items-center justify-center"
                                          >
                                            <Monitor className="h-3.5 w-3.5" aria-hidden="true" />
                                          </span>
                                          {isRuntimeWorktreeTask(task) && (
                                            <GitCompareArrows
                                              className="h-3.5 w-3.5 shrink-0"
                                              aria-label="Worktree"
                                            />
                                          )}
                                          <span>
                                            {formatRelativeSidebarTime(getRuntimeTaskTime(task))}
                                          </span>
                                        </span>
                                      )}
                                    </button>
                                    {queued
                                      ? renderQueuedTaskActions(
                                          taskAddress,
                                          task.queuePosition,
                                          'mobile-runtime-task',
                                          workspace.available
                                        )
                                      : null}
                                  </div>
                                )
                              })}
                              {(hasHiddenTasks || canCollapseTasks) && (
                                <div className="flex h-10 items-center gap-2">
                                  {hasHiddenTasks ? (
                                    <button
                                      type="button"
                                      data-testid={`mobile-project-runtime-tasks-expand-${project.id}`}
                                      onClick={() =>
                                        setRuntimeProjectTaskVisibleLimits(previous => ({
                                          ...previous,
                                          [project.id]: getNextRuntimeSidebarTaskVisibleLimit(
                                            runtimeTaskVisibleLimit,
                                            taskItems.length
                                          ),
                                        }))
                                      }
                                      className="flex h-10 min-w-[44px] items-center rounded-lg px-2 text-left text-base font-semibold text-text-secondary hover:bg-muted"
                                    >
                                      {t('workbench.expand_display', '展开显示')}
                                    </button>
                                  ) : (
                                    <button
                                      type="button"
                                      data-testid={`mobile-project-runtime-tasks-collapse-${project.id}`}
                                      onClick={() =>
                                        setRuntimeProjectTaskVisibleLimits(previous => {
                                          const next = { ...previous }
                                          delete next[project.id]
                                          return next
                                        })
                                      }
                                      className="flex h-10 min-w-[44px] items-center rounded-lg px-2 text-left text-base font-semibold text-text-secondary hover:bg-muted"
                                    >
                                      {t('workbench.collapse_display', '折叠显示')}
                                    </button>
                                  )}
                                </div>
                              )}
                            </>
                          )
                        })()}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </section>
        </div>
      </div>

      <button
        type="button"
        data-testid="mobile-new-chat-button"
        onClick={() => closeAfter(onNewChat ?? onStartStandaloneChat)}
        className="absolute bottom-[max(32px,env(safe-area-inset-bottom))] right-8 z-10 flex h-14 items-center gap-3 rounded-full bg-text-primary px-6 text-heading-sm font-semibold text-background shadow-[0_12px_32px_rgba(0,0,0,0.18)] hover:bg-text-primary/90"
        aria-label={t('workbench.new_chat', '新对话')}
      >
        <SquarePen className="h-6 w-6" />
        <span>{t('workbench.chat', '聊天')}</span>
      </button>
      {projectCreateMode && (
        <ProjectCreateDialog
          open={projectCreateMode !== null}
          mode={projectCreateMode}
          devices={devices}
          onClose={() => setProjectCreateMode(null)}
          onOpenCloudDeviceSettings={() => {
            setProjectCreateMode(null)
            closeAfter(onOpenSettings)
          }}
          onCreateProject={onCreateProject ?? unavailableProjectAction}
          onCreateGitWorkspaceProject={onCreateGitWorkspaceProject}
          onPrepareDeviceWorkspace={onPrepareDeviceWorkspace ?? unavailableProjectAction}
          onDeleteDeviceWorkspace={onDeleteDeviceWorkspace ?? unavailableProjectAction}
          preferredDeviceId={user?.preferences?.default_execution_target}
          onGetDeviceHomeDirectory={onGetDeviceHomeDirectory ?? unavailableProjectAction}
          onGetProjectWorkspaceRoot={onGetProjectWorkspaceRoot ?? unavailableProjectAction}
          onListDeviceDirectories={onListDeviceDirectories ?? unavailableProjectAction}
          onCreateDeviceDirectory={onCreateDeviceDirectory ?? unavailableProjectAction}
          onListGitRepositories={onListGitRepositories}
          onListGitBranches={onListGitBranches}
          presentation="mobileSheet"
        />
      )}
      {projectActionTarget && (
        <div
          className="fixed inset-0 z-30"
          data-testid="mobile-project-actions-backdrop"
          onClick={() => setProjectActionTarget(null)}
        >
          <div
            data-testid="mobile-project-actions-menu"
            className="absolute w-[240px] overflow-hidden rounded-2xl border border-border bg-popover p-2 text-text-primary shadow-[0_12px_36px_rgba(0,0,0,0.18)]"
            style={actionMenuPosition}
            onClick={event => event.stopPropagation()}
          >
            <button
              type="button"
              data-testid="mobile-rename-project-button"
              onClick={() => {
                setRenameValue(projectActionTarget.name)
                setRenamingProjectId(projectActionTarget.id)
                setProjectActionTarget(null)
              }}
              className="flex h-14 min-w-[44px] w-full items-center gap-4 rounded-xl px-4 text-left text-heading-sm text-text-primary hover:bg-muted"
            >
              <Edit3 className="h-6 w-6 shrink-0" />
              <span>{t('workbench.rename_project', '重命名项目')}</span>
            </button>
            <button
              type="button"
              data-testid="mobile-remove-project-button"
              onClick={() => handleAction(() => onRemoveProject?.(projectActionTarget.id))}
              className="flex h-14 min-w-[44px] w-full items-center gap-4 rounded-xl px-4 text-left text-heading-sm text-red-500 hover:bg-red-500/10"
            >
              <X className="h-6 w-6 shrink-0" />
              <span>{t('workbench.remove_project', '移除')}</span>
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
