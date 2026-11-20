import { preferredEventSubscription } from '@/lib/sidebar-event-state'
import { isRuntimeTaskExecutionRunning } from '@/features/workbench/runtimeTaskLifecycle/projection'
import { SidebarConnectionEventStatus } from './SidebarConnectionEventStatus'
import { connectionEventSubscriptions } from '@/lib/runtime-connection-events'
import {
  subscribePendingRuntimeTaskArchive,
  getPendingRuntimeTaskArchive,
  schedulePendingRuntimeTaskArchive,
  undoPendingRuntimeTaskArchive,
  dismissPendingRuntimeTaskArchiveNotice,
} from './pendingRuntimeTaskArchives'

import {
  Archive,
  AlarmClock,
  ArrowDown,
  ArrowUp,
  CircleHelp,
  Columns2,
  Edit3,
  FolderOpen,
  Laptop,
  Loader2,
  MessageCircle,
  MessageCircleOff,
  Pause,
  Pin,
  RotateCw,
  Sparkles,
  X,
} from 'lucide-react'
import { useCallback, useContext, useMemo, useState, useSyncExternalStore } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import { createPortal } from 'react-dom'
import { ActionMenu } from '@/components/common/ActionMenu'
import { useMoveRuntimeTaskMenu } from './useMoveRuntimeTaskMenu'
import { CompositedSpinner } from '@/components/common/CompositedSpinner'
import { TextInputDialog } from '@/components/common/TextInputDialog'

import { Tooltip } from '@/components/ui/tooltip'

import { DshContributionSlotSurface } from '@/features/dsh-runtime/DshContributionSlotSurface'
import { WEWORK_DSH_SLOTS } from '@/features/dsh-runtime/dshUiSlots'

import { executeDshCommand } from '@/features/dsh-runtime/dshExtensions'
import { useDshMenuCommands } from '@/features/dsh-runtime/useDshMenuCommands'

import { getRuntimeTaskThreadId } from '@/features/workbench/workbenchRuntimeHelpers'
import { useRuntimeTaskRateLimitWait } from '@/features/workbench/useRuntimeTaskRateLimitWait'
import { WorkbenchContext } from '@/features/workbench/workbenchContexts'
import {
  getRuntimeConversationQueuePaused,
  subscribeRuntimeConversation,
} from '@/features/workbench/runtimeConversationCache'
import {
  getRuntimeTaskLifecycleKey,
  useRuntimeTaskLifecycle,
  useRuntimeTaskLifecycleStore,
} from '@/features/workbench/runtimeTaskLifecycle'

import { useExperimentalFeaturesEnabled } from '@/features/experimental-features/useExperimentalFeaturesEnabled'

import { useTranslation } from '@/hooks/useTranslation'

import { cn } from '@/lib/utils'
import { SidebarTaskTitle } from './SidebarTaskTitle'

import type {
  DeviceInfo,
  RuntimeTaskSummary,
  RuntimeDeviceWorkspace,
  RuntimeIMNotificationSettingsResponse,
  RuntimeTaskPinRequest,
  RuntimeTaskAddress,
} from '@/types/api'

import type {
  ArchiveRuntimeTaskOptions,
  ArchiveRuntimeTaskResult,
} from '@/features/workbench/workbenchContextTypes'

import { SidebarHoverCard } from './SidebarHoverCard'

import { TaskSidebarHoverCardContent } from './TaskSidebarHoverCardContent'

import {
  getRuntimeTaskAddress,
  getRuntimeTaskTime,
  getRuntimeTaskWorkspaceTitle,
  shortenSidebarHomePath,
  isRuntimeTaskQueued,
  isRuntimeWorktreeTask,
} from './runtimeTaskSidebarHelpers'

import { formatRelativeSidebarTime } from './runtimeSidebarTime'

import type { WorkbenchSplitGroupMembership } from './workbenchSplitGroups'
import type { ProjectCreateMenuPosition, RuntimeTaskPriorityReason } from './desktopSidebarTypes'
import {
  SIDEBAR_ROW_METADATA_CLASS,
  handleSidebarRowKeyDown,
  getSidebarDeviceState,
  getRuntimeTaskRepositoryLabel,
  getRuntimeTaskBranch,
  hasRuntimeTaskBranchWarning,
  getRuntimeWorkspaceDeviceColor,
  isRuntimeTaskNotificationSubscribed,
  dshMenuItemIcon,
} from './desktopSidebarHelpers'
import { ArchiveConversationsConfirmDialog } from './DesktopSidebarWidgets'
export function RuntimeTaskRow({
  nowMs,
  workspace,
  devices,
  task,
  projectName,
  selected,
  unread,
  marked: controlledMarked,
  indentClassName = 'pl-12',
  imNotificationSettings,
  showDeviceMarker,
  stateDeviceId,
  onOpenRuntimeTask,
  onMarkRuntimeTaskRead,
  onSetRuntimeTaskPinned,
  onRenameRuntimeTask,
  onArchiveRuntimeTask,
  onToggleRuntimeTaskNotification,
  priorityReason,
  priorityLayout = false,
  statusInIndent = false,
  splitGroup,
}: {
  nowMs?: number
  workspace: RuntimeDeviceWorkspace
  devices: DeviceInfo[]
  task: RuntimeTaskSummary
  projectName?: string | null
  selected: boolean
  unread?: boolean
  marked?: boolean
  indentClassName?: string
  imNotificationSettings?: RuntimeIMNotificationSettingsResponse | null
  showDeviceMarker: boolean
  stateDeviceId?: string | null
  onOpenRuntimeTask?: (address: RuntimeTaskAddress) => Promise<void> | void
  onMarkRuntimeTaskRead?: (address: RuntimeTaskAddress) => void
  onSetRuntimeTaskPinned?: (data: RuntimeTaskPinRequest) => Promise<void>
  onRenameRuntimeTask?: (address: RuntimeTaskAddress, title: string) => Promise<void> | void
  onArchiveRuntimeTask?: (
    address: RuntimeTaskAddress,
    options?: ArchiveRuntimeTaskOptions
  ) => Promise<ArchiveRuntimeTaskResult | void> | ArchiveRuntimeTaskResult | void
  onToggleRuntimeTaskNotification?: (
    address: RuntimeTaskAddress,
    subscribed: boolean
  ) => Promise<void> | void
  priorityReason?: RuntimeTaskPriorityReason
  priorityLayout?: boolean
  statusInIndent?: boolean
  splitGroup?: WorkbenchSplitGroupMembership
}) {
  const { t } = useTranslation('common')
  const experimentalFeaturesEnabled = useExperimentalFeaturesEnabled()
  const [optimisticMarked, setOptimisticMarked] = useState<{
    base: boolean
    value: boolean
  } | null>(null)
  const [archiving, setArchiving] = useState(false)
  const [forceArchiveConfirmOpen, setForceArchiveConfirmOpen] = useState(false)
  const [renameOpen, setRenameOpen] = useState(false)
  const [forceStarting, setForceStarting] = useState(false)
  const [queueReordering, setQueueReordering] = useState(false)
  const workbench = useContext(WorkbenchContext)
  const [taskMenuPosition, setTaskMenuPosition] = useState<ProjectCreateMenuPosition | null>(null)
  const worktreeTask = isRuntimeWorktreeTask(task)
  const workspaceTitle = getRuntimeTaskWorkspaceTitle(workspace)
  const projectLabel = projectName?.trim() || t('workbench.task')
  const repositoryLabel = getRuntimeTaskRepositoryLabel(workspace, task)
  const branchLabel = getRuntimeTaskBranch(task)
  const taskWorkspacePath = task.workspacePath || workspace.workspacePath
  const taskDevice = getSidebarDeviceState(workspace.deviceId, devices)?.device
  const hostLabel =
    taskDevice?.device_type === 'local'
      ? t('todo.workflow_execution_local_device', '本机')
      : taskDevice?.name?.trim() || workspace.deviceName?.trim() || null
  const hostId =
    workspace.remoteHostId?.trim() || taskDevice?.device_id?.trim() || workspace.deviceId.trim()
  const deviceColor = getRuntimeWorkspaceDeviceColor(workspace)
  const disabled = !workspace.available || !onOpenRuntimeTask
  const splitGroupLabel = splitGroup
    ? t('workbench.split_group_badge', '分屏 {{number}}', {
        number: splitGroup.displayNumber,
      })
    : null
  const taskAddress = getRuntimeTaskAddress(workspace, task)
  const runArchive = useCallback(
    async (options?: ArchiveRuntimeTaskOptions) => {
      setArchiving(true)
      try {
        const result = await Promise.resolve(
          options
            ? onArchiveRuntimeTask?.(taskAddress, options)
            : onArchiveRuntimeTask?.(taskAddress)
        )
        if (result?.status === 'dirty_worktree') {
          setForceArchiveConfirmOpen(true)
        }
      } finally {
        setArchiving(false)
      }
    },
    [onArchiveRuntimeTask, taskAddress]
  )

  const lifecycleOwner = useRuntimeTaskLifecycleStore()
  const archiveKey = `${lifecycleOwner.notificationScope}:${getRuntimeTaskLifecycleKey(taskAddress)}`
  const subscribeArchive = useCallback(
    (listener: () => void) => subscribePendingRuntimeTaskArchive(archiveKey, listener, runArchive),
    [archiveKey, runArchive]
  )
  const getArchiveSnapshot = useCallback(
    () => getPendingRuntimeTaskArchive(archiveKey),
    [archiveKey]
  )
  const pendingArchive = useSyncExternalStore(
    subscribeArchive,
    getArchiveSnapshot,
    getArchiveSnapshot
  )
  const archivePending = pendingArchive !== null
  const archiveNoticeOpen = pendingArchive?.noticeOpen === true
  const archiveDisabled =
    !workspace.available || !onArchiveRuntimeTask || archiving || archivePending
  const conversationMenuActions = useDshMenuCommands('conversation.context')
  const taskLifecycle = useRuntimeTaskLifecycle(taskAddress)
  const eventTask = taskLifecycle?.task ?? task
  const eventSubscriptions = eventTask.runtimeHandle?.connectionEventSubscriptions
  const eventRunning = isRuntimeTaskExecutionRunning(eventTask)
  const eventSubscription = useMemo(() => {
    const subscriptions = connectionEventSubscriptions(eventSubscriptions)
    return preferredEventSubscription(
      eventRunning
        ? subscriptions.filter(item => item.status === 'pending' || item.status === 'resuming_goal')
        : subscriptions
    )
  }, [eventRunning, eventSubscriptions])
  const rateLimitWaiting = useRuntimeTaskRateLimitWait(taskAddress)
  const hasActiveGoal = taskLifecycle?.goalStatus === 'active'
  const queuePaused = useRuntimeTaskQueuePaused(taskAddress)
  const queued = isRuntimeTaskQueued(task)
  const showQueuePausedStatus =
    queuePaused && !(queued && taskLifecycle?.derived.shouldShowSidebarRunning)
  const showQueuedStatus = queued && !taskLifecycle?.derived.shouldShowSidebarRunning
  const showWaitingStatus =
    !showQueuedStatus &&
    !showQueuePausedStatus &&
    (taskLifecycle?.derived.shouldShowSidebarWaiting || priorityReason === 'waiting')
  const queuePosition =
    queued && Number.isInteger(task.queuePosition) && Number(task.queuePosition) > 0
      ? Number(task.queuePosition)
      : null
  const threadId = getRuntimeTaskThreadId(task)
  const moveTaskMenu = useMoveRuntimeTaskMenu(workspace, task, threadId, stateDeviceId)
  const notificationsSubscribed = isRuntimeTaskNotificationSubscribed(
    imNotificationSettings,
    taskAddress
  )
  const persistedMarked = controlledMarked ?? task.pinned ?? false
  const marked =
    optimisticMarked?.base === persistedMarked ? optimisticMarked.value : persistedMarked
  const notificationsDisabled = !workspace.available || !onToggleRuntimeTaskNotification
  const handleOpen = () => {
    if (disabled) return
    onMarkRuntimeTaskRead?.(taskAddress)
    void onOpenRuntimeTask?.(taskAddress)
  }
  const toggleTaskPinned = async () => {
    if (!workspace.available || !threadId || !onSetRuntimeTaskPinned) return
    const nextMarked = !marked
    setOptimisticMarked({ base: persistedMarked, value: nextMarked })
    try {
      await onSetRuntimeTaskPinned({
        deviceId: stateDeviceId || workspace.deviceId,
        threadId,
        pinned: nextMarked,
      })
    } catch {
      setOptimisticMarked(null)
    }
  }
  const handleToggleMark = (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.stopPropagation()
    event.currentTarget.blur()
    void toggleTaskPinned()
  }
  const scheduleArchive = () => {
    if (archiveDisabled) return
    schedulePendingRuntimeTaskArchive(archiveKey, () => {
      void runArchive()
    })
  }
  const handleArchive = (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.stopPropagation()
    event.currentTarget.blur()
    scheduleArchive()
  }
  const handleUndoArchive = () => {
    undoPendingRuntimeTaskArchive(archiveKey)
  }
  const handleDismissArchiveNotice = () => {
    dismissPendingRuntimeTaskArchiveNotice(archiveKey)
  }
  const handleCloseForceArchiveConfirm = () => {
    if (!archiving) {
      setForceArchiveConfirmOpen(false)
    }
  }
  const handleConfirmForceArchive = async () => {
    await runArchive({ force: true })
    setForceArchiveConfirmOpen(false)
  }
  const handleToggleNotification = (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.stopPropagation()
    event.currentTarget.blur()
    if (notificationsDisabled) return
    void onToggleRuntimeTaskNotification?.(taskAddress, notificationsSubscribed)
  }
  const forceStartTask = async () => {
    if (!queued || !workbench || forceStarting) return
    setForceStarting(true)
    try {
      await workbench.forceStartRuntimeTask(taskAddress)
    } catch (forceStartError) {
      console.error('[Wework] Failed to force start queued runtime task', forceStartError)
      workbench.setWorkbenchError(t('workbench.runtime_task_force_start_failed'))
    } finally {
      setForceStarting(false)
    }
  }
  const reorderQueuedTask = async (nextPosition: number) => {
    if (!queued || !workbench || queueReordering) return
    setQueueReordering(true)
    try {
      await workbench.reorderQueuedRuntimeTask({
        ...taskAddress,
        queuePosition: Math.max(1, nextPosition),
      })
    } catch (queueReorderError) {
      console.error('[Wework] Failed to reorder queued runtime task', queueReorderError)
      workbench.setWorkbenchError(t('workbench.runtime_task_queue_reorder_failed'))
    } finally {
      setQueueReordering(false)
    }
  }
  const notificationActionLabel = notificationsSubscribed
    ? t('workbench.unsubscribe_runtime_task_notifications', '取消任务通知')
    : t('workbench.subscribe_runtime_task_notifications', '订阅任务通知')
  const NotificationIcon = notificationsSubscribed ? MessageCircle : MessageCircleOff
  const renderNotificationButton = (testId: string, iconTestId: string) => (
    <Tooltip label={notificationActionLabel} testId={`${testId}-tooltip`}>
      <button
        type="button"
        data-testid={testId}
        disabled={notificationsDisabled}
        aria-pressed={notificationsSubscribed}
        onClick={handleToggleNotification}
        className={cn(
          'flex h-5 w-5 items-center justify-center text-[rgb(var(--color-sidebar-text-muted))] hover:text-[rgb(var(--color-sidebar-text-primary))] disabled:cursor-not-allowed disabled:opacity-45',
          notificationsSubscribed && 'text-primary'
        )}
        aria-label={notificationActionLabel}
      >
        <NotificationIcon
          data-testid={iconTestId}
          className={cn('h-[15px] w-[15px]', notificationsSubscribed && 'fill-current')}
        />
      </button>
    </Tooltip>
  )

  return (
    <>
      <SidebarHoverCard
        testId={`runtime-local-task-hover-card-${task.taskId}`}
        interactive
        content={
          <TaskSidebarHoverCardContent
            taskId={task.taskId}
            title={task.title}
            projectLabel={projectLabel}
            repositoryLabel={repositoryLabel}
            branchLabel={branchLabel}
            workspacePath={taskWorkspacePath ? shortenSidebarHomePath(taskWorkspacePath) : null}
            hostLabel={hostLabel}
            hostId={hostId && hostId !== hostLabel ? hostId : null}
            updatedLabel={task.updatedAt ? formatRelativeSidebarTime(task.updatedAt, nowMs) : null}
            branchWarning={hasRuntimeTaskBranchWarning(task)}
            worktree={worktreeTask}
          />
        }
      >
        <div
          data-testid={`runtime-local-task-row-${task.taskId}`}
          data-sidebar-task-row
          data-marked={marked ? 'true' : undefined}
          role="button"
          tabIndex={disabled ? -1 : 0}
          aria-disabled={disabled}
          aria-label={
            worktreeTask ? `${task.title} · ${t('workbench.git_worktree_session')}` : undefined
          }
          aria-current={
            splitGroup?.active
              ? splitGroup.focused
                ? 'page'
                : undefined
              : selected
                ? 'page'
                : undefined
          }
          onClick={event => {
            if (event.detail > 1) return
            handleOpen()
          }}
          onContextMenu={event => {
            event.preventDefault()
            event.stopPropagation()
            setTaskMenuPosition({ left: event.clientX, top: event.clientY })
          }}
          onDoubleClick={event => {
            event.stopPropagation()
            if (!disabled && onRenameRuntimeTask) {
              setRenameOpen(true)
            }
          }}
          onKeyDown={event => handleSidebarRowKeyDown(event, handleOpen)}
          className={cn(
            'group/task relative flex min-w-0 items-center rounded-[10px] pr-2 text-base leading-5',
            priorityLayout ? 'min-h-[48px] py-1.5' : 'h-[30px]',
            indentClassName,
            disabled ? 'cursor-not-allowed opacity-55' : 'cursor-default',
            selected
              ? 'bg-[rgb(var(--color-sidebar-active))] text-text-primary'
              : 'text-[rgb(var(--color-sidebar-text-primary))] hover:bg-[rgb(var(--color-sidebar-hover))]',
            splitGroup?.focused && 'shadow-[inset_2px_0_0_hsl(var(--primary))]',
            (archivePending || archiving) && 'hidden'
          )}
        >
          <DshContributionSlotSurface
            attachedClassName="contents"
            props={{ priorityLayout, statusInIndent, task, workspace }}
            slot={WEWORK_DSH_SLOTS.taskStatus}
          />
          {priorityLayout ? (
            <span className="flex min-w-0 flex-1 flex-col justify-center gap-0.5">
              <SidebarTaskTitle
                text={task.title}
                testId={`runtime-local-task-title-${task.taskId}`}
                textTestId={`runtime-local-task-drag-activator-${task.taskId}`}
                shimmerTestId={`runtime-local-task-title-shimmer-${task.taskId}`}
                className="flex-none"
              />
              <span
                data-testid={`runtime-local-task-source-${task.taskId}`}
                className="flex min-w-0 items-center gap-1 text-sm leading-[18px] text-[rgb(var(--color-sidebar-text-muted))]"
              >
                {projectName ? (
                  <FolderOpen className="h-3 w-3 shrink-0" aria-hidden="true" />
                ) : (
                  <Laptop className="h-3 w-3 shrink-0" aria-hidden="true" />
                )}
                <span className="truncate">
                  {projectName || t('workbench.app_wework', 'Wework')}
                </span>
              </span>
            </span>
          ) : (
            <SidebarTaskTitle
              text={task.title}
              testId={`runtime-local-task-title-${task.taskId}`}
              textTestId={`runtime-local-task-drag-activator-${task.taskId}`}
              shimmerTestId={`runtime-local-task-title-shimmer-${task.taskId}`}
            />
          )}
          {splitGroup && splitGroupLabel ? (
            <span
              data-testid={`runtime-local-task-split-group-${task.taskId}`}
              data-split-group={splitGroup.groupId}
              data-split-group-active={splitGroup.active ? 'true' : undefined}
              title={splitGroupLabel}
              aria-label={splitGroupLabel}
              className="ml-1 inline-flex h-5 shrink-0 items-center gap-0.5 rounded-md bg-[rgb(var(--color-sidebar-hover))] px-1.5 text-xs font-medium leading-none text-[rgb(var(--color-sidebar-text-secondary))] group-hover/task:invisible group-focus-visible/task:invisible group-has-[:focus-visible]/task:invisible"
            >
              <Columns2 className="h-3 w-3" aria-hidden="true" />
              <span>{splitGroup.displayNumber}</span>
            </span>
          ) : null}
          <span
            data-testid={`runtime-local-task-trailing-${task.taskId}`}
            className={cn(
              'relative ml-1 flex min-w-[30px] shrink-0 items-center justify-end',
              priorityLayout ? 'self-stretch' : 'h-[30px]'
            )}
          >
            <span
              data-testid={`runtime-local-task-time-${task.taskId}`}
              className={SIDEBAR_ROW_METADATA_CLASS}
            >
              {experimentalFeaturesEnabled &&
                notificationsSubscribed &&
                renderNotificationButton(
                  `runtime-local-task-notify-${task.taskId}`,
                  `runtime-local-task-notify-icon-${task.taskId}`
                )}
              <span className="flex h-[30px] w-[30px] items-center justify-center">
                {showQueuedStatus ? (
                  <span
                    data-testid={`runtime-local-task-queued-${task.taskId}`}
                    role="status"
                    title={
                      queuePosition
                        ? `${t('workbench.runtime_task_queued')} · ${t(
                            'workbench.runtime_task_queue_position',
                            'Position {{position}}',
                            { position: queuePosition }
                          )}`
                        : t('workbench.runtime_task_queued')
                    }
                    aria-label={
                      queuePosition
                        ? `${t('workbench.runtime_task_queued')} · ${t(
                            'workbench.runtime_task_queue_position',
                            'Position {{position}}',
                            { position: queuePosition }
                          )}`
                        : t('workbench.runtime_task_queued')
                    }
                    className="flex h-[30px] min-w-[30px] items-center justify-center gap-0.5"
                  >
                    <AlarmClock className="h-3.5 w-3.5 text-[rgb(var(--color-sidebar-text-muted))]" />
                    {queuePosition ? (
                      <span
                        data-testid={`runtime-local-task-queue-position-${task.taskId}`}
                        className="text-xs tabular-nums text-[rgb(var(--color-sidebar-text-muted))]"
                      >
                        {queuePosition}
                      </span>
                    ) : null}
                  </span>
                ) : showQueuePausedStatus ? (
                  <span
                    data-testid={`runtime-local-task-queue-paused-${task.taskId}`}
                    role="status"
                    title={t('workbench.runtime_task_queue_paused')}
                    aria-label={t('workbench.runtime_task_queue_paused')}
                    className="flex h-[30px] w-[30px] items-center justify-center"
                  >
                    <Pause
                      className="h-3.5 w-3.5 text-[rgb(var(--color-sidebar-text-muted))]"
                      aria-hidden="true"
                    />
                  </span>
                ) : showWaitingStatus ? (
                  <Tooltip
                    label={t('workbench.priority_filter_waiting')}
                    testId={`runtime-local-task-waiting-tooltip-${task.taskId}`}
                    className="visible"
                  >
                    <span
                      data-testid={`runtime-local-task-waiting-${task.taskId}`}
                      role="status"
                      aria-label={t('workbench.priority_filter_waiting')}
                      className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[rgb(var(--color-sidebar-attention))]"
                    >
                      <CircleHelp className="h-4 w-4" aria-hidden="true" />
                    </span>
                  </Tooltip>
                ) : eventSubscription ? (
                  <SidebarConnectionEventStatus
                    subscription={eventSubscription}
                    taskId={task.taskId}
                  />
                ) : taskLifecycle?.derived.shouldShowSidebarRunning && rateLimitWaiting ? (
                  <span
                    data-testid={`runtime-local-task-rate-limit-wait-${task.taskId}`}
                    role="status"
                    title={t('workbench.runtime_task_rate_limit_wait')}
                    aria-label={t('workbench.runtime_task_rate_limit_wait')}
                    className="flex h-[30px] w-[30px] items-center justify-center"
                  >
                    <AlarmClock
                      className="h-4 w-4 text-[rgb(var(--color-sidebar-text-muted))]"
                      aria-hidden="true"
                    />
                  </span>
                ) : taskLifecycle?.derived.shouldShowSidebarRunning ? (
                  <span
                    data-testid={`runtime-local-task-running-${task.taskId}`}
                    role="status"
                    title={
                      hasActiveGoal
                        ? t('workbench.runtime_task_running_with_goal')
                        : t('workbench.runtime_task_running')
                    }
                    aria-label={
                      hasActiveGoal
                        ? t('workbench.runtime_task_running_with_goal')
                        : t('workbench.runtime_task_running')
                    }
                    className="flex h-[30px] w-[30px] items-center justify-center"
                  >
                    {hasActiveGoal ? (
                      <span
                        data-testid={`runtime-local-task-goal-dot-${task.taskId}`}
                        className="relative flex h-4 w-4 items-center justify-center text-[rgb(var(--color-sidebar-text-muted))]"
                        aria-hidden="true"
                      >
                        <CompositedSpinner icon={Loader2} className="absolute inset-0 h-4 w-4" />
                        <span
                          data-testid={`runtime-local-task-goal-center-${task.taskId}`}
                          className="h-1 w-1 rounded-full bg-current"
                        />
                      </span>
                    ) : (
                      <CompositedSpinner
                        icon={Loader2}
                        className="h-4 w-4 text-[rgb(var(--color-sidebar-text-muted))]"
                      />
                    )}
                  </span>
                ) : unread ? (
                  <span
                    data-testid={`runtime-local-task-unread-dot-${task.taskId}`}
                    aria-label={t('workbench.runtime_task_unread', '未读')}
                    title={t('workbench.runtime_task_unread', '未读')}
                    className="h-1.5 w-1.5 rounded-full bg-primary"
                  />
                ) : (
                  formatRelativeSidebarTime(getRuntimeTaskTime(task), nowMs)
                )}
              </span>
              {showDeviceMarker && (
                <span
                  data-testid={`runtime-local-task-device-marker-${task.taskId}`}
                  title={workspaceTitle}
                  aria-label={workspaceTitle}
                  className="h-3.5 w-0.5 shrink-0 rounded-full"
                  style={{ backgroundColor: deviceColor }}
                />
              )}
            </span>
            <span
              data-testid={`runtime-local-task-hover-actions-${task.taskId}`}
              data-sidebar-title-actions
              className={cn(
                'pointer-events-none absolute top-1/2 z-[70] flex -translate-y-1/2 items-center justify-end gap-1 opacity-0 transition-opacity group-hover/task:pointer-events-auto group-hover/task:opacity-100 group-focus-visible/task:pointer-events-auto group-focus-visible/task:opacity-100 group-has-[:focus-visible]/task:pointer-events-auto group-has-[:focus-visible]/task:opacity-100 hover:pointer-events-auto hover:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100',
                showWaitingStatus ? 'right-full mr-1' : 'right-0',
                queued ? 'w-[96px]' : 'w-[72px]'
              )}
            >
              {experimentalFeaturesEnabled &&
                renderNotificationButton(
                  notificationsSubscribed
                    ? `runtime-local-task-notify-hover-${task.taskId}`
                    : `runtime-local-task-notify-${task.taskId}`,
                  notificationsSubscribed
                    ? `runtime-local-task-notify-hover-icon-${task.taskId}`
                    : `runtime-local-task-notify-icon-${task.taskId}`
                )}
              {queued ? (
                <>
                  <Tooltip
                    label={t('workbench.runtime_task_queue_move_up')}
                    testId={`runtime-local-task-queue-up-${task.taskId}-tooltip`}
                  >
                    <button
                      type="button"
                      data-testid={`runtime-local-task-queue-up-${task.taskId}`}
                      onClick={event => {
                        event.stopPropagation()
                        void reorderQueuedTask((queuePosition ?? 1) - 1)
                      }}
                      disabled={
                        !workspace.available ||
                        !workbench ||
                        queueReordering ||
                        queuePosition === null ||
                        queuePosition <= 1
                      }
                      className="flex h-5 w-5 items-center justify-center text-[rgb(var(--color-sidebar-text-muted))] hover:text-[rgb(var(--color-sidebar-text-primary))] disabled:cursor-not-allowed disabled:opacity-45"
                      aria-label={t('workbench.runtime_task_queue_move_up')}
                    >
                      <ArrowUp className="h-[15px] w-[15px]" />
                    </button>
                  </Tooltip>
                  <Tooltip
                    label={t('workbench.runtime_task_queue_move_down')}
                    testId={`runtime-local-task-queue-down-${task.taskId}-tooltip`}
                  >
                    <button
                      type="button"
                      data-testid={`runtime-local-task-queue-down-${task.taskId}`}
                      onClick={event => {
                        event.stopPropagation()
                        void reorderQueuedTask((queuePosition ?? 1) + 1)
                      }}
                      disabled={
                        !workspace.available ||
                        !workbench ||
                        queueReordering ||
                        queuePosition === null
                      }
                      className="flex h-5 w-5 items-center justify-center text-[rgb(var(--color-sidebar-text-muted))] hover:text-[rgb(var(--color-sidebar-text-primary))] disabled:cursor-not-allowed disabled:opacity-45"
                      aria-label={t('workbench.runtime_task_queue_move_down')}
                    >
                      <ArrowDown className="h-[15px] w-[15px]" />
                    </button>
                  </Tooltip>
                  <Tooltip
                    label={t('workbench.runtime_task_force_start')}
                    testId={`runtime-local-task-force-start-${task.taskId}-tooltip`}
                  >
                    <button
                      type="button"
                      data-testid={`runtime-local-task-force-start-${task.taskId}`}
                      onClick={event => {
                        event.stopPropagation()
                        void forceStartTask()
                      }}
                      disabled={!workspace.available || !workbench || forceStarting}
                      className="flex h-5 w-5 items-center justify-center text-[rgb(var(--color-sidebar-text-muted))] hover:text-[rgb(var(--color-sidebar-text-primary))] disabled:cursor-not-allowed disabled:opacity-45"
                      aria-label={t('workbench.runtime_task_force_start')}
                    >
                      {forceStarting ? (
                        <RotateCw className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Sparkles className="h-[15px] w-[15px]" />
                      )}
                    </button>
                  </Tooltip>
                </>
              ) : (
                <Tooltip
                  label={
                    marked ? t('workbench.unmark_runtime_task') : t('workbench.mark_runtime_task')
                  }
                  testId={`runtime-local-task-mark-${task.taskId}-tooltip`}
                >
                  <button
                    type="button"
                    data-testid={`runtime-local-task-mark-${task.taskId}`}
                    onClick={handleToggleMark}
                    disabled={!workspace.available || !threadId || !onSetRuntimeTaskPinned}
                    className={cn(
                      'flex h-5 w-5 items-center justify-center text-[rgb(var(--color-sidebar-text-muted))] hover:text-[rgb(var(--color-sidebar-text-primary))]',
                      marked && 'text-[rgb(var(--color-sidebar-marked-accent))]'
                    )}
                    aria-label={
                      marked ? t('workbench.unmark_runtime_task') : t('workbench.mark_runtime_task')
                    }
                  >
                    <Pin
                      data-testid={`runtime-local-task-pin-icon-${task.taskId}`}
                      className={cn('h-[15px] w-[15px]', marked && 'fill-current')}
                    />
                  </button>
                </Tooltip>
              )}
              <Tooltip
                label={t('workbench.archive_runtime_task', '归档')}
                testId={`runtime-local-task-archive-${task.taskId}-tooltip`}
              >
                <button
                  type="button"
                  data-testid={`runtime-local-task-archive-${task.taskId}`}
                  disabled={archiveDisabled}
                  onClick={handleArchive}
                  className="flex h-5 w-5 items-center justify-center text-[rgb(var(--color-sidebar-text-muted))] hover:text-[rgb(var(--color-sidebar-text-primary))] disabled:cursor-not-allowed disabled:opacity-45"
                  aria-label={t('workbench.archive_runtime_task', '归档')}
                >
                  {archiving ? (
                    <RotateCw className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Archive
                      data-testid={`runtime-local-task-archive-icon-${task.taskId}`}
                      className="h-[15px] w-[15px]"
                    />
                  )}
                </button>
              </Tooltip>
            </span>
          </span>
        </div>
      </SidebarHoverCard>
      <ActionMenu
        ariaLabel={t('workbench.task_actions')}
        testId={`runtime-local-task-menu-${task.taskId}`}
        contextMenuPosition={taskMenuPosition}
        onContextMenuClose={() => setTaskMenuPosition(null)}
        triggerClassName="hidden"
        showTriggerTooltip={false}
        items={[
          ...(queued
            ? [
                {
                  label: t('workbench.runtime_task_force_start'),
                  icon: Sparkles,
                  testId: `runtime-local-task-menu-force-start-${task.taskId}`,
                  disabled: !workspace.available || !workbench || forceStarting,
                  onSelect: forceStartTask,
                },
                {
                  label: t('workbench.runtime_task_queue_move_first'),
                  icon: ArrowUp,
                  testId: `runtime-local-task-menu-queue-first-${task.taskId}`,
                  disabled:
                    !workspace.available ||
                    !workbench ||
                    queueReordering ||
                    queuePosition === null ||
                    queuePosition <= 1,
                  onSelect: () => reorderQueuedTask(1),
                },
                {
                  label: t('workbench.runtime_task_queue_move_up'),
                  icon: ArrowUp,
                  testId: `runtime-local-task-menu-queue-up-${task.taskId}`,
                  disabled:
                    !workspace.available ||
                    !workbench ||
                    queueReordering ||
                    queuePosition === null ||
                    queuePosition <= 1,
                  onSelect: () => reorderQueuedTask((queuePosition ?? 1) - 1),
                },
                {
                  label: t('workbench.runtime_task_queue_move_down'),
                  icon: ArrowDown,
                  testId: `runtime-local-task-menu-queue-down-${task.taskId}`,
                  disabled:
                    !workspace.available || !workbench || queueReordering || queuePosition === null,
                  onSelect: () => reorderQueuedTask((queuePosition ?? 1) + 1),
                },
              ]
            : []),
          {
            label: marked ? t('workbench.unmark_runtime_task') : t('workbench.mark_runtime_task'),
            icon: Pin,
            testId: `runtime-local-task-menu-pin-${task.taskId}`,
            disabled: !workspace.available || !threadId || !onSetRuntimeTaskPinned,
            onSelect: toggleTaskPinned,
          },
          {
            label: t('workbench.rename_chat', '重命名任务'),
            icon: Edit3,
            testId: `runtime-local-task-menu-rename-${task.taskId}`,
            disabled: !workspace.available || !onRenameRuntimeTask,
            onSelect: () => setRenameOpen(true),
          },
          moveTaskMenu,
          ...conversationMenuActions.map(action => ({
            label: action.title,
            icon: dshMenuItemIcon(action.icon),
            testId: `runtime-local-task-menu-extension-${action.id}-${task.taskId}`,
            disabled: !workspace.available || !action.enabled,
            onSelect: async () => {
              await executeDshCommand(
                action.command,
                {
                  deviceId: taskAddress.deviceId,
                  taskId: taskAddress.taskId,
                  workspacePath: taskAddress.workspacePath,
                },
                {
                  menuId: action.id,
                  menuLocation: 'conversation.context',
                  source: 'menu',
                }
              )
            },
          })),
          ...(experimentalFeaturesEnabled
            ? [
                {
                  label: notificationActionLabel,
                  icon: NotificationIcon,
                  testId: `runtime-local-task-menu-notify-${task.taskId}`,
                  disabled: notificationsDisabled,
                  onSelect: () =>
                    onToggleRuntimeTaskNotification?.(taskAddress, notificationsSubscribed),
                },
              ]
            : []),
          {
            label: t('workbench.archive_runtime_task', '归档'),
            icon: Archive,
            testId: `runtime-local-task-menu-archive-${task.taskId}`,
            disabled: archiveDisabled,
            onSelect: scheduleArchive,
          },
        ]}
      />
      <TextInputDialog
        open={renameOpen}
        title={t('workbench.rename_chat', '重命名会话')}
        label={t('workbench.chat_name', '会话名称')}
        description={t('workbench.rename_chat_description', '保持简短且易于识别')}
        initialValue={task.title}
        confirmLabel={t('workbench.save', '保存')}
        cancelLabel={t('workbench.cancel', '取消')}
        inputTestId={`rename-runtime-local-task-input-${task.taskId}`}
        confirmTestId={`confirm-rename-runtime-local-task-${task.taskId}`}
        onClose={() => setRenameOpen(false)}
        onSubmit={title => {
          if (workspace.available) return onRenameRuntimeTask?.(taskAddress, title)
        }}
      />
      {archiveNoticeOpen &&
        createPortal(
          <div
            data-testid={`runtime-local-task-archive-toast-${task.taskId}`}
            role="status"
            aria-live="polite"
            className="electron-titlebar-interactive-region pointer-events-auto fixed left-1/2 top-5 z-[200] flex max-w-[calc(100vw-32px)] -translate-x-1/2 items-center gap-1 rounded-2xl border border-border bg-surface px-4 py-2 text-sm text-text-primary shadow-lg"
          >
            <button
              type="button"
              data-testid={`runtime-local-task-archive-undo-${task.taskId}`}
              onClick={handleUndoArchive}
              className="font-medium text-primary hover:underline"
            >
              {t('workbench.archive_runtime_task_undo', '撤销')}
            </button>
            <span>{t('workbench.archive_runtime_task_pending', '，稍后将归档')}</span>
            <Tooltip
              label={t('workbench.archive_runtime_task_notice_close', '关闭归档提示')}
              testId={`runtime-local-task-archive-toast-close-${task.taskId}-tooltip`}
              className="ml-2"
            >
              <button
                type="button"
                data-testid={`runtime-local-task-archive-toast-close-${task.taskId}`}
                onClick={handleDismissArchiveNotice}
                className="flex h-5 w-5 items-center justify-center rounded-full text-text-muted hover:bg-muted hover:text-text-primary"
                aria-label={t('workbench.archive_runtime_task_notice_close', '关闭归档提示')}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </Tooltip>
          </div>,
          document.body
        )}
      <ArchiveConversationsConfirmDialog
        open={forceArchiveConfirmOpen}
        title={t('workbench.archive_runtime_task_dirty_worktree_title')}
        description={t('workbench.archive_runtime_task_dirty_worktree_force_desc')}
        confirmLabel={t('workbench.archive_runtime_task_force_confirm')}
        cancelLabel={t('workbench.cancel')}
        submitting={archiving}
        testId={`runtime-local-task-force-archive-dialog-${task.taskId}`}
        onClose={handleCloseForceArchiveConfirm}
        onConfirm={handleConfirmForceArchive}
      />
    </>
  )
}

function useRuntimeTaskQueuePaused(address: RuntimeTaskAddress): boolean {
  const stableAddress = useMemo<RuntimeTaskAddress>(
    () => ({
      deviceId: address.deviceId,
      taskId: address.taskId,
    }),
    [address.deviceId, address.taskId]
  )
  const subscribe = useCallback(
    (listener: () => void) => subscribeRuntimeConversation(stableAddress, listener),
    [stableAddress]
  )
  const getSnapshot = useCallback(
    () => getRuntimeConversationQueuePaused(stableAddress),
    [stableAddress]
  )

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
