import { useDraggable, useDroppable } from '@dnd-kit/core'
import { CSS } from '@dnd-kit/utilities'
import { Archive, Bot, CalendarDays, Ellipsis, Flag, ListTodo } from 'lucide-react'
import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import type { CloudLoopItem } from '@/api/deliveries'
import type { TaskChangeRequestSnapshot, TaskChangeRequestTarget } from '@/api/changeRequests'
import { ChangeRequestStatusIcon } from '@/components/common/ChangeRequestStatusIcon'
import { AssistantThinkingIndicator } from '@/components/chat/AssistantThinkingIndicator'
import { ToolBlocksDisplay } from '@/components/chat/blocks/ToolBlocksDisplay'
import {
  getToolActivityFilePaths,
  getToolActivityKind,
  getToolActivitySearchItem,
} from '@/components/chat/blocks/toolBlockActivity'
import { getInputField } from '@/components/chat/blocks/toolBlockKinds'
import { Tooltip } from '@/components/ui/tooltip'
import { HoverCard } from '@/components/ui/hover-card'
import {
  getRuntimeConversationLiveActivitySnapshot,
  getRuntimeConversationMessages,
  subscribeRuntimeConversation,
} from '@/features/workbench/runtimeConversationCache'
import {
  runtimeLiveActivityFromSnapshot,
  type RuntimeLiveActivity,
  type RuntimeLiveToolActivity,
} from '@/features/workbench/runtimeThinking'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import type { RuntimeTaskAddress } from '@/types/api'
import type { ProcessingBlock, WorkbenchMessage } from '@/types/workbench'
import type { ChangeRequestMonitor } from '@/features/workbench/changeRequestMonitor'
import { useTaskChangeRequest } from '@/features/workbench/changeRequestMonitor'
import {
  autoRepairStatus,
  stoppedTaskNeedsAttention,
} from '@/features/workbench/changeRequestStatus'
import { isLoopItemExecutionActive } from './cloudMyWorkModel'
import {
  finalAssistantMessagesText,
  latestResponseLine,
  latestAssistantMessage,
} from './runtimeTaskResponsePreview'
import { priorityBadgeClasses } from './todoShared'

export interface BoardCardDisplaySettings {
  showAssignee: boolean
  showPriority: boolean
  showTags: boolean
  showDate: boolean
}

const priorityLabels: Record<CloudLoopItem['priority'], string> = {
  none: '普通',
  low: '低',
  medium: '中',
  high: '高',
  urgent: '紧急',
}

interface CloudTodoCardContentProps {
  item: CloudLoopItem
  display: BoardCardDisplaySettings
  /** Active robot names for the current project, used when the item only
   * carries `assignee_agent_id` (local projects do not resolve the name). */
  agentNames?: Record<string, string>
}

export function CloudTodoCardContent({ item, display, agentNames }: CloudTodoCardContentProps) {
  const tags = item.tags ?? []
  const showFooter = display.showPriority || display.showDate || display.showAssignee
  const assigneeName =
    item.assignee_name ||
    item.assignee_team_name ||
    (item.assignee_agent_id
      ? item.assignee_agent_name || agentNames?.[item.assignee_agent_id] || null
      : null)

  return (
    <>
      <span className="flex min-w-0 items-center gap-2 pr-5 text-base font-medium leading-5 text-text-primary">
        {item.is_unread ? (
          <span
            data-testid={`cloud-todo-card-unread-${item.id}`}
            className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary"
            aria-hidden="true"
          />
        ) : null}
        <span className="line-clamp-1 min-w-0">{item.title}</span>
      </span>
      {display.showTags && tags.length > 0 ? (
        <span className="mt-2 flex min-w-0 items-center gap-1.5 overflow-hidden">
          {tags.slice(0, 2).map((tag, index) => (
            <span
              key={tag}
              className={cn(
                'inline-flex h-5 max-w-28 shrink-0 items-center truncate rounded-md px-2 text-xs',
                index === 0
                  ? 'bg-violet-500/10 text-violet-700 dark:text-violet-300'
                  : 'bg-sky-500/10 text-sky-700 dark:text-sky-300'
              )}
            >
              {tag}
            </span>
          ))}
          {tags.length > 2 ? (
            <span className="shrink-0 text-xs text-text-muted">+{tags.length - 2}</span>
          ) : null}
        </span>
      ) : null}

      {showFooter ? (
        <span className="mt-2.5 flex min-h-6 items-center gap-3 text-xs text-text-muted">
          {display.showPriority ? (
            <span
              className={cn(
                'inline-flex items-center gap-1 rounded-md px-1.5 py-0.5',
                priorityBadgeClasses[item.priority]
              )}
            >
              <Flag className="h-3 w-3" />
              {priorityLabels[item.priority]}
            </span>
          ) : null}
          {display.showDate ? (
            <span className="inline-flex items-center gap-1">
              <CalendarDays className="h-3 w-3" />
              {(item.due_at ?? item.updated_at).slice(5, 10)}
            </span>
          ) : null}
          {display.showAssignee ? (
            assigneeName ? (
              <Tooltip label={assigneeName} align="end" className="ml-auto min-w-0 shrink">
                <span
                  data-testid={`cloud-todo-card-assignee-${item.id}`}
                  className="inline-flex min-w-0 items-center gap-1.5"
                >
                  <span className="sr-only">负责人</span>
                  {item.assignee_agent_id || item.assignee_team_id ? (
                    <Bot className="h-3.5 w-3.5 shrink-0" />
                  ) : null}
                  <span className="truncate">{assigneeName}</span>
                </span>
              </Tooltip>
            ) : (
              <span className="ml-auto">未指定</span>
            )
          ) : null}
        </span>
      ) : null}
    </>
  )
}

export interface CloudTodoBoardTaskBinding {
  id: number
  device_id: string
  task_id: string
  task_title: string | null
  running: boolean
  changeRequestTarget?: TaskChangeRequestTarget | null
  finalResponsePreview?: string | null
  finalResponseLoaded?: boolean
}

interface CloudTodoBoardCardProps {
  item: CloudLoopItem
  taskBindings?: CloudTodoBoardTaskBinding[]
  onClick: () => void
  onArchive: () => void
  onOpenActivity?: () => void
  display: BoardCardDisplaySettings
  agentNames?: Record<string, string>
  dragDisabled?: boolean
  archiveDisabled?: boolean
  changeRequestMonitor?: ChangeRequestMonitor | null
  onContinueChangeRequestRepair?: (
    binding: CloudTodoBoardTaskBinding,
    snapshot: TaskChangeRequestSnapshot
  ) => Promise<void>
}

export function CloudTodoBoardCard({
  item,
  taskBindings = [],
  onClick,
  onArchive,
  onOpenActivity,
  display,
  agentNames,
  dragDisabled = false,
  archiveDisabled = false,
  changeRequestMonitor = null,
  onContinueChangeRequestRepair,
}: CloudTodoBoardCardProps) {
  const { t } = useTranslation('common')
  const [menuOpen, setMenuOpen] = useState(false)
  const [hoveredTaskBindingId, setHoveredTaskBindingId] = useState<number | null>(null)
  const hasActiveTask = isLoopItemExecutionActive(item)
  const runningTaskBindings = taskBindings.filter(binding => binding.running)
  const runningTaskBinding = runningTaskBindings[0]
  const currentTaskBinding = runningTaskBinding ?? taskBindings[0]
  const changeRequestSnapshot = useTaskChangeRequest(
    changeRequestMonitor,
    currentTaskBinding?.changeRequestTarget ?? null
  )
  const showCurrentTask = Boolean(
    currentTaskBinding &&
    (currentTaskBinding.running ||
      hasActiveTask ||
      item.status === 'in_review' ||
      stoppedTaskNeedsAttention(changeRequestSnapshot?.changeRequest ?? null))
  )
  const [repairingChangeRequest, setRepairingChangeRequest] = useState(false)
  const progressTaskBindings =
    runningTaskBindings.length > 0
      ? runningTaskBindings
      : showCurrentTask && currentTaskBinding
        ? [currentTaskBinding]
        : []
  const {
    attributes,
    listeners,
    setNodeRef: setDragRef,
    transform,
    isDragging,
  } = useDraggable({
    id: item.id,
    disabled: item.can_edit === false || dragDisabled,
  })
  const { isOver, setNodeRef: setDropRef } = useDroppable({ id: `todo-card:${item.id}` })

  return (
    <HoverCard
      testId={`cloud-todo-card-progress-popup-${item.id}`}
      interactive
      openOnFocus
      estimatedWidth={440}
      estimatedHeight={360}
      cardClassName="w-[440px] max-w-[calc(100vw-1rem)]"
      content={
        <RuntimeTaskProgressPopup
          item={item}
          bindings={progressTaskBindings}
          activeBindingId={hasActiveTask ? (currentTaskBinding?.id ?? null) : null}
          focusedBindingId={hoveredTaskBindingId}
          onFocusBinding={setHoveredTaskBindingId}
        />
      }
    >
      <article
        ref={node => {
          setDragRef(node)
          setDropRef(node)
        }}
        data-testid={`cloud-todo-card-drop-${item.id}`}
        style={{ transform: CSS.Translate.toString(transform) }}
        className={cn(
          'group relative h-fit w-full touch-none overflow-hidden rounded-xl border text-left shadow-sm transition hover:-translate-y-px hover:border-text-primary/15 hover:shadow-md',
          item.is_unread ? 'border-blue-500/15 bg-blue-500/[0.04]' : 'border-border bg-background',
          isDragging && 'opacity-25 shadow-none',
          isOver && !isDragging && 'border-focus ring-1 ring-focus/50'
        )}
      >
        {item.can_edit !== false && !archiveDisabled ? (
          <div className="absolute right-2 top-2 z-20">
            <Tooltip label={t('todo.project_actions', '项目操作')} side="bottom" align="end">
              <button
                type="button"
                data-testid={`cloud-todo-card-more-${item.id}`}
                onClick={event => {
                  event.stopPropagation()
                  setMenuOpen(current => !current)
                }}
                className="flex h-7 w-7 items-center justify-center rounded-md bg-background/90 text-text-muted opacity-0 shadow-sm transition hover:text-text-primary focus:opacity-100 group-hover:opacity-100"
                aria-label={t('todo.project_actions', '项目操作')}
                aria-expanded={menuOpen}
              >
                <Ellipsis className="h-3.5 w-3.5" />
              </button>
            </Tooltip>
            {menuOpen ? (
              <div
                data-testid={`cloud-todo-card-menu-${item.id}`}
                className="absolute right-0 top-8 w-32 rounded-lg border border-border bg-background p-1 shadow-md"
              >
                <button
                  type="button"
                  data-testid={`cloud-todo-card-archive-${item.id}`}
                  onClick={event => {
                    event.stopPropagation()
                    setMenuOpen(false)
                    onArchive()
                  }}
                  className="flex h-7 w-full items-center gap-2 rounded-md px-2 text-xs text-red-600 hover:bg-muted"
                >
                  <Archive className="h-3.5 w-3.5" />
                  归档任务
                </button>
              </div>
            ) : null}
          </div>
        ) : null}
        <button
          type="button"
          data-testid={`cloud-todo-card-${item.id}`}
          disabled={item.can_view_detail === false}
          onClick={onClick}
          className="w-full px-3.5 pb-3 pt-3.5 text-left disabled:cursor-default"
          {...listeners}
          {...attributes}
        >
          <CloudTodoCardContent item={item} display={display} agentNames={agentNames} />
        </button>

        {progressTaskBindings.length > 0 ? (
          <div
            role={onOpenActivity ? 'button' : undefined}
            tabIndex={onOpenActivity ? 0 : undefined}
            aria-label={
              onOpenActivity
                ? currentTaskBinding?.task_title || currentTaskBinding?.task_id
                : undefined
            }
            data-testid={`cloud-todo-card-tasks-${item.id}`}
            onClick={onOpenActivity}
            onKeyDown={event => {
              if (!onOpenActivity || (event.key !== 'Enter' && event.key !== ' ')) return
              event.preventDefault()
              onOpenActivity()
            }}
            className="w-full px-3.5 pb-3"
          >
            {progressTaskBindings.map(binding => (
              <RuntimeTaskProgressSummary
                key={binding.id}
                item={item}
                binding={binding}
                compact
                active={binding.running || (binding.id === currentTaskBinding?.id && hasActiveTask)}
                changeRequestSnapshot={
                  binding.id === currentTaskBinding?.id ? changeRequestSnapshot : null
                }
                repairingChangeRequest={repairingChangeRequest}
                onContinueChangeRequestRepair={
                  binding.id === currentTaskBinding?.id &&
                  changeRequestSnapshot?.changeRequest &&
                  autoRepairStatus(changeRequestSnapshot.changeRequest) &&
                  onContinueChangeRequestRepair
                    ? async () => {
                        setRepairingChangeRequest(true)
                        try {
                          await onContinueChangeRequestRepair(binding, changeRequestSnapshot!)
                        } finally {
                          setRepairingChangeRequest(false)
                        }
                      }
                    : undefined
                }
              />
            ))}
          </div>
        ) : null}
      </article>
    </HoverCard>
  )
}

function RuntimeTaskLiveActivity({
  itemId,
  activity,
  expanded = false,
}: {
  itemId: string
  activity: RuntimeLiveActivity
  expanded?: boolean
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const lastTool = activity.tools.at(-1)
  const completedTools = activity.tools.filter(
    block => block.status === 'done' || block.status === 'error'
  )
  const activeTools = activity.tools.filter(
    block => block.status !== 'done' && block.status !== 'error'
  )
  const processingBlocks = useMemo<ProcessingBlock[]>(
    () =>
      activity.tools.map(block => ({
        ...block,
        type: 'tool',
        subtaskId: `board:${itemId}`,
      })),
    [activity.tools, itemId]
  )

  useLayoutEffect(() => {
    const scrollArea = scrollRef.current
    if (scrollArea) scrollArea.scrollTop = scrollArea.scrollHeight
  }, [activity.thinking, activity.tools.length, lastTool?.status, lastTool?.toolInput])

  return (
    <div
      ref={scrollRef}
      data-testid={
        expanded ? `cloud-todo-card-popup-activity-${itemId}` : `cloud-todo-card-activity-${itemId}`
      }
      className={cn(
        'scrollbar-none min-w-0 overflow-y-auto',
        expanded
          ? 'max-h-44 text-chat text-text-primary'
          : 'ml-5 mt-1.5 h-[60px] border-l border-border/70 pl-2 text-xs leading-5 text-text-muted'
      )}
    >
      {expanded ? (
        processingBlocks.length > 0 ? (
          <ToolBlocksDisplay
            blocks={processingBlocks}
            isStreaming={activity.active}
            processingPhase="live"
            showInterToolThinking
            thinkingContent={activity.thinking}
            stateKey={`cloud-todo-card:${itemId}:progress-popup`}
          />
        ) : activity.thinking ? (
          <AssistantThinkingIndicator
            content={activity.thinking}
            testId={`cloud-todo-card-popup-thinking-${itemId}`}
          />
        ) : null
      ) : (
        <>
          {completedTools.map(block => (
            <RuntimeTaskToolActivity key={block.id} itemId={itemId} block={block} />
          ))}
          {activity.thinking ? (
            <div className="flex h-5 min-w-0 items-center">
              <AssistantThinkingIndicator
                content={activity.thinking}
                testId={`cloud-todo-card-thinking-${itemId}`}
                className="text-xs leading-5"
              />
            </div>
          ) : null}
          {activeTools.map(block => (
            <RuntimeTaskToolActivity key={block.id} itemId={itemId} block={block} />
          ))}
        </>
      )}
    </div>
  )
}

function RuntimeTaskCompactActivity({
  itemId,
  activity,
  responsePreview,
  reserveTrailingAction,
}: {
  itemId: string
  activity: RuntimeLiveActivity
  responsePreview: string | null
  reserveTrailingAction: boolean
}) {
  const latestTool = activity.tools.at(-1)

  return (
    <div data-testid={`cloud-todo-card-activity-${itemId}`} className="min-w-0 text-xs">
      {responsePreview ? (
        <div
          data-testid={`cloud-todo-card-response-${itemId}`}
          className={cn('h-5 truncate leading-5 text-text-muted', reserveTrailingAction && 'pr-7')}
        >
          {responsePreview}
        </div>
      ) : activity.thinking ? (
        <div className={cn('flex h-5 min-w-0 items-center', reserveTrailingAction && 'pr-7')}>
          <AssistantThinkingIndicator
            content={activity.thinking}
            testId={`cloud-todo-card-thinking-${itemId}`}
            className="text-xs leading-5"
          />
        </div>
      ) : null}
      {latestTool ? (
        <div
          data-testid={`cloud-todo-card-tool-line-${itemId}`}
          className="ml-2 min-w-0 border-l border-border pl-3 text-text-muted"
        >
          <RuntimeTaskToolActivity itemId={itemId} block={latestTool} />
        </div>
      ) : null}
    </div>
  )
}

function RuntimeTaskProgressSummary({
  item,
  binding,
  compact,
  active,
  changeRequestSnapshot,
  repairingChangeRequest,
  onContinueChangeRequestRepair,
}: {
  item: CloudLoopItem
  binding: CloudTodoBoardTaskBinding
  compact: boolean
  active: boolean
  changeRequestSnapshot: TaskChangeRequestSnapshot | null
  repairingChangeRequest: boolean
  onContinueChangeRequestRepair?: () => Promise<void>
}) {
  const activityAddress = useMemo<RuntimeTaskAddress | null>(
    () =>
      active
        ? {
            deviceId: binding.device_id,
            taskId: binding.task_id,
          }
        : null,
    [active, binding.device_id, binding.task_id]
  )
  const taskAddress = useMemo<RuntimeTaskAddress>(
    () => ({
      deviceId: binding.device_id,
      taskId: binding.task_id,
    }),
    [binding.device_id, binding.task_id]
  )
  const activity = useRuntimeTaskActivity(activityAddress)
  const message = useRuntimeTaskLatestAssistantMessage(taskAddress)
  const cachedFinalResponse = useRuntimeTaskFinalResponse(
    item.status === 'in_review' ? taskAddress : null
  )
  const finalResponseText = binding.finalResponseLoaded
    ? (binding.finalResponsePreview ?? null)
    : cachedFinalResponse
  const responseText =
    activity.active && message?.content?.trim() ? message.content : finalResponseText
  const responsePreview = responseText
    ? compact
      ? latestResponseLine(responseText)
      : responseText.trim()
    : null
  const taskTitle = binding.task_title || binding.task_id
  const showCompactChangeRequest = compact && Boolean(changeRequestSnapshot?.changeRequest)

  return (
    <div
      data-testid={`cloud-todo-card-task-summary-${item.id}-${binding.id}`}
      className={cn('min-w-0 text-left', compact && 'relative rounded-md px-1 py-0.5')}
    >
      {showCompactChangeRequest ? (
        <ChangeRequestStatusIcon
          snapshot={changeRequestSnapshot}
          testId={`cloud-todo-card-change-request-${item.id}-${binding.id}`}
          className="absolute right-0 top-0 z-10"
          popoverAlign="left"
          repairing={repairingChangeRequest}
          onContinueRepair={onContinueChangeRequestRepair}
        />
      ) : null}
      {!compact ? (
        <div className="flex min-w-0 items-center gap-2 text-xs text-text-secondary">
          {changeRequestSnapshot?.changeRequest ? (
            <ChangeRequestStatusIcon
              snapshot={changeRequestSnapshot}
              testId={`cloud-todo-card-change-request-${item.id}-${binding.id}`}
              popoverAlign="left"
              repairing={repairingChangeRequest}
              onContinueRepair={onContinueChangeRequestRepair}
            />
          ) : (
            <ListTodo className="h-3.5 w-3.5" />
          )}
          <span
            data-testid={`cloud-todo-card-task-${item.id}-${binding.id}`}
            className="min-w-0 flex-1 truncate"
            title={taskTitle}
          >
            {taskTitle}
          </span>
        </div>
      ) : null}
      {compact && activity.active ? (
        <RuntimeTaskCompactActivity
          itemId={item.id}
          activity={activity}
          responsePreview={responsePreview}
          reserveTrailingAction={showCompactChangeRequest}
        />
      ) : responsePreview ? (
        <div
          data-testid={
            activity.active
              ? `cloud-todo-card-response-${item.id}-${binding.id}`
              : compact
                ? `cloud-todo-card-final-response-${item.id}`
                : `cloud-todo-card-progress-response-${item.id}-${binding.id}`
          }
          className={cn(
            'text-xs leading-5 text-text-muted',
            compact
              ? cn('h-5 truncate', showCompactChangeRequest && 'pr-7')
              : 'ml-5 mt-1.5 max-h-60 overflow-y-auto whitespace-pre-wrap break-words border-l border-border/70 pl-2 pr-1'
          )}
        >
          {responsePreview}
        </div>
      ) : activity.active ? (
        <RuntimeTaskLiveActivity itemId={item.id} activity={activity} />
      ) : null}
    </div>
  )
}

function RuntimeTaskProgressPopup({
  item,
  bindings,
  activeBindingId,
  focusedBindingId,
  onFocusBinding,
}: {
  item: CloudLoopItem
  bindings: CloudTodoBoardTaskBinding[]
  activeBindingId: number | null
  focusedBindingId: number | null
  onFocusBinding: (bindingId: number | null) => void
}) {
  const { t } = useTranslation('common')
  const visibleBindings = focusedBindingId
    ? bindings.filter(binding => binding.id === focusedBindingId)
    : bindings

  return (
    <div
      data-testid={`cloud-todo-card-progress-popup-content-${item.id}`}
      className="min-w-0 space-y-2"
    >
      <div className="min-w-0 border-b border-border/60 pb-2">
        <div className="text-sm font-medium leading-5 text-text-primary">
          {t('todo.task_progress_details', '当前任务进展')}
        </div>
        <div className="mt-0.5 text-xs leading-5 text-text-secondary">
          {focusedBindingId
            ? t('todo.task_progress_details', '当前任务进展')
            : `${t('todo.task_progress_details', '当前任务进展')} · ${bindings.length}`}
        </div>
      </div>
      {visibleBindings.length > 0 ? (
        <div data-testid={`cloud-todo-card-progress-list-${item.id}`} className="space-y-1">
          {visibleBindings.map(binding => (
            <div
              key={binding.id}
              data-testid={`cloud-todo-card-progress-task-${item.id}-${binding.id}`}
              onMouseEnter={() => onFocusBinding(binding.id)}
              onMouseLeave={() => onFocusBinding(null)}
              onFocus={() => onFocusBinding(binding.id)}
              onBlur={() => onFocusBinding(null)}
              className="rounded-lg p-1 transition hover:bg-muted/50"
            >
              <RuntimeTaskProgressSummary
                item={item}
                binding={binding}
                compact={false}
                active={binding.running || binding.id === activeBindingId}
                changeRequestSnapshot={null}
                repairingChangeRequest={false}
              />
            </div>
          ))}
        </div>
      ) : (
        <p
          data-testid={`cloud-todo-card-progress-empty-${item.id}`}
          className="text-xs leading-5 text-text-muted"
        >
          {t('todo.task_progress_empty', '暂无任务进展详情')}
        </p>
      )}
    </div>
  )
}

function RuntimeTaskToolActivity({
  itemId,
  block,
}: {
  itemId: string
  block: RuntimeLiveActivity['tools'][number]
}) {
  const { t } = useTranslation('chat')
  const running = block.status !== 'done' && block.status !== 'error'

  return (
    <div
      data-testid={`cloud-todo-card-tool-${itemId}-${block.id}`}
      className="flex h-5 min-w-0 items-center"
    >
      <span className={cn('min-w-0 truncate', running && 'waiting-thinking-text')}>
        {runtimeToolActivityText(block, t)}
      </span>
    </div>
  )
}

function useRuntimeTaskActivity(address: RuntimeTaskAddress | null): RuntimeLiveActivity {
  const subscribe = useCallback(
    (listener: () => void) =>
      address ? subscribeRuntimeConversation(address, listener) : () => undefined,
    [address]
  )
  const getSnapshot = useCallback(
    () => (address ? getRuntimeConversationLiveActivitySnapshot(address) : ''),
    [address]
  )
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

  return useMemo(() => runtimeLiveActivityFromSnapshot(snapshot), [snapshot])
}

function useRuntimeTaskFinalResponse(address: RuntimeTaskAddress | null): string | null {
  const subscribe = useCallback(
    (listener: () => void) =>
      address ? subscribeRuntimeConversation(address, listener) : () => undefined,
    [address]
  )
  const getSnapshot = useCallback(
    () => (address ? finalAssistantMessagesText(getRuntimeConversationMessages(address)) : null),
    [address]
  )
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

function useRuntimeTaskLatestAssistantMessage(
  address: RuntimeTaskAddress | null
): WorkbenchMessage | null {
  const subscribe = useCallback(
    (listener: () => void) =>
      address ? subscribeRuntimeConversation(address, listener) : () => undefined,
    [address]
  )
  const getSnapshot = useCallback(
    () =>
      address
        ? JSON.stringify(latestAssistantMessage(getRuntimeConversationMessages(address)))
        : '',
    [address]
  )
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

  return useMemo(
    () => (snapshot ? (JSON.parse(snapshot) as WorkbenchMessage | null) : null),
    [snapshot]
  )
}

function runtimeToolActivityText(
  block: RuntimeLiveToolActivity,
  t: ReturnType<typeof useTranslation>['t']
): string {
  const kind = getToolActivityKind(block)
  const paths = getToolActivityFilePaths(block)
  const path = paths[0] ? displayActivityPath(paths[0]) : ''
  const command = getInputField(block, 'command', 'cmd', 'commandLine')?.replace(/\s+/g, ' ').trim()
  const search = getToolActivitySearchItem(block)
  const running = block.status !== 'done' && block.status !== 'error'

  if (kind === 'command') {
    return activityLabel(t('tool_activity.command_action'), command)
  }
  if (kind === 'file') {
    return activityLabel(t('tool_activity.file_action'), path)
  }
  if (kind === 'search') {
    return activityLabel(
      t(running ? 'tool_activity.search_running' : 'tool_activity.search_done'),
      search?.query
    )
  }
  if (kind === 'edit') {
    return activityLabel(t('tool_activity.edit_action'), path)
  }
  if (kind === 'create') {
    return activityLabel(t('tool_activity.create_action'), path)
  }
  return activityLabel(t('tool_activity.other_action'), block.toolName)
}

function activityLabel(label: string, detail: string | undefined): string {
  return detail ? `${label} · ${detail}` : label
}

function displayActivityPath(path: string): string {
  return path.replaceAll('\\', '/').split('/').filter(Boolean).at(-1) ?? path
}
