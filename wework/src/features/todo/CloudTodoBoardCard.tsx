import { useDraggable, useDroppable } from '@dnd-kit/core'
import { CSS } from '@dnd-kit/utilities'
import { AlertTriangle, Archive, Bot, CalendarDays, Ellipsis, Flag, ListTodo } from 'lucide-react'
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
import {
  getToolActivityFilePaths,
  getToolActivityKind,
  getToolActivitySearchItem,
} from '@/components/chat/blocks/toolBlockActivity'
import { getInputField } from '@/components/chat/blocks/toolBlockKinds'
import { Tooltip } from '@/components/ui/tooltip'
import {
  getRuntimeConversationLiveActivitySnapshot,
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
import type { ChangeRequestMonitor } from '@/features/workbench/changeRequestMonitor'
import { useTaskChangeRequest } from '@/features/workbench/changeRequestMonitor'
import {
  autoRepairStatus,
  stoppedTaskNeedsAttention,
} from '@/features/workbench/changeRequestStatus'
import { isLoopItemExecutionActive } from './cloudMyWorkModel'
import { priorityBadgeClasses } from './todoShared'
import { itemNeedsExecutionConfiguration } from './workflowExecutionConfig'

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
  const needsExecutionConfiguration = itemNeedsExecutionConfiguration(item)

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
      {item.description ? (
        <span className="mt-1 line-clamp-2 text-sm leading-[18px] text-text-secondary">
          {item.description}
        </span>
      ) : null}
      {needsExecutionConfiguration ? (
        <span
          data-testid={`cloud-todo-card-needs-execution-config-${item.id}`}
          className="mt-2 inline-flex w-fit items-center gap-1 rounded-md bg-amber-500/10 px-2 py-1 text-xs font-medium text-amber-700 dark:text-amber-300"
        >
          <AlertTriangle className="h-3.5 w-3.5" />
          待配置
        </span>
      ) : null}

      {display.showTags && tags.length > 0 ? (
        <span className="mt-3 flex min-w-0 items-center gap-1.5 overflow-hidden">
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
        <span className="mt-3 flex min-h-6 items-center gap-3 border-t border-border/60 pt-2.5 text-xs text-text-muted">
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
  const hasActiveTask = isLoopItemExecutionActive(item)
  const runningTaskBinding = taskBindings.find(binding => binding.running)
  const currentTaskBinding = runningTaskBinding ?? taskBindings[0]
  const changeRequestSnapshot = useTaskChangeRequest(
    changeRequestMonitor,
    currentTaskBinding?.changeRequestTarget ?? null
  )
  const showCurrentTask = Boolean(
    currentTaskBinding &&
    (currentTaskBinding.running ||
      hasActiveTask ||
      stoppedTaskNeedsAttention(changeRequestSnapshot?.changeRequest ?? null))
  )
  const [repairingChangeRequest, setRepairingChangeRequest] = useState(false)
  const currentTaskAddress = useMemo<RuntimeTaskAddress | null>(
    () =>
      currentTaskBinding && (currentTaskBinding.running || hasActiveTask)
        ? {
            deviceId: currentTaskBinding.device_id,
            taskId: currentTaskBinding.task_id,
          }
        : null,
    [currentTaskBinding, hasActiveTask]
  )
  const currentActivity = useRuntimeTaskActivity(currentTaskAddress)
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
    <article
      ref={node => {
        setDragRef(node)
        setDropRef(node)
      }}
      data-testid={`cloud-todo-card-drop-${item.id}`}
      style={{ transform: CSS.Translate.toString(transform) }}
      className={cn(
        'group relative h-fit w-full touch-none overflow-hidden rounded-xl border border-border bg-background text-left shadow-sm transition hover:-translate-y-px hover:border-text-primary/15 hover:shadow-md',
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

      {currentTaskBinding && showCurrentTask ? (
        <div
          role={onOpenActivity ? 'button' : undefined}
          tabIndex={onOpenActivity ? 0 : undefined}
          aria-label={
            onOpenActivity
              ? `${t('todo.current_running_task', '正在执行')} ${
                  currentTaskBinding.task_title || currentTaskBinding.task_id
                }`
              : undefined
          }
          data-testid={`cloud-todo-card-tasks-${item.id}`}
          onClick={onOpenActivity}
          onKeyDown={event => {
            if (!onOpenActivity || (event.key !== 'Enter' && event.key !== ' ')) return
            event.preventDefault()
            onOpenActivity()
          }}
          className={cn(
            'w-full border-t border-border/60 px-3.5 py-2 text-left transition',
            onOpenActivity
              ? 'cursor-pointer hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus/30'
              : 'cursor-default'
          )}
        >
          <div className="flex min-w-0 items-center gap-2 text-xs text-text-secondary">
            {changeRequestSnapshot?.changeRequest ? (
              <ChangeRequestStatusIcon
                snapshot={changeRequestSnapshot}
                testId={`cloud-todo-card-change-request-${item.id}-${currentTaskBinding.id}`}
                repairing={repairingChangeRequest}
                onContinueRepair={
                  autoRepairStatus(changeRequestSnapshot.changeRequest) &&
                  onContinueChangeRequestRepair
                    ? async () => {
                        setRepairingChangeRequest(true)
                        try {
                          await onContinueChangeRequestRepair(
                            currentTaskBinding,
                            changeRequestSnapshot
                          )
                        } finally {
                          setRepairingChangeRequest(false)
                        }
                      }
                    : undefined
                }
              />
            ) : (
              <ListTodo className="h-3.5 w-3.5" />
            )}
            {currentTaskBinding.running || hasActiveTask ? (
              <span className="shrink-0 text-text-muted">
                {t('todo.current_running_task', '正在执行')}
              </span>
            ) : null}
            <span
              data-testid={`cloud-todo-card-task-${item.id}-${currentTaskBinding.id}`}
              className="min-w-0 truncate"
            >
              {currentTaskBinding.task_title || currentTaskBinding.task_id}
            </span>
          </div>
          {currentActivity.active ? (
            <RuntimeTaskLiveActivity itemId={item.id} activity={currentActivity} />
          ) : null}
        </div>
      ) : null}
    </article>
  )
}

function RuntimeTaskLiveActivity({
  itemId,
  activity,
}: {
  itemId: string
  activity: RuntimeLiveActivity
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const lastTool = activity.tools.at(-1)
  const completedTools = activity.tools.filter(
    block => block.status === 'done' || block.status === 'error'
  )
  const activeTools = activity.tools.filter(
    block => block.status !== 'done' && block.status !== 'error'
  )

  useLayoutEffect(() => {
    const scrollArea = scrollRef.current
    if (scrollArea) scrollArea.scrollTop = scrollArea.scrollHeight
  }, [activity.thinking, activity.tools.length, lastTool?.status, lastTool?.toolInput])

  return (
    <div
      ref={scrollRef}
      data-testid={`cloud-todo-card-activity-${itemId}`}
      className="scrollbar-none ml-5 mt-1.5 h-5 min-w-0 overflow-y-auto border-l border-border/70 pl-2 text-xs leading-5 text-text-muted"
    >
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
