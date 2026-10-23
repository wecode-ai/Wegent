import { useId, useRef, useState, type ReactNode } from 'react'
import { ChevronRight, Package, Plus } from 'lucide-react'
import type { CollaborationTranslate } from '../i18n'
import type { CollaborationIssue, CollaborationStatus } from '../types'
import { isExecutionActive } from './executionStatus'
import {
  taskDeviceLabel,
  taskExecutionStatusLabel,
  taskExecutionDotClass,
} from './taskBindingPresentation'
import type {
  SharedIssueDetailDelivery,
  SharedIssueDetailTaskBinding,
  SharedIssueDetailTaskExecutionState,
} from './createSharedIssueDetailPort'

const PREVIEW_LIMIT = 2

function ExecutionListSection({
  title,
  count,
  testId,
  listTestId,
  toggleTestId,
  countTestId,
  actions,
  translate,
  children,
}: {
  title: string
  count: number
  testId: string
  listTestId: string
  toggleTestId: string
  countTestId?: string
  actions?: ReactNode
  translate: CollaborationTranslate
  children(expanded: boolean): ReactNode
}) {
  const id = useId()
  const [expanded, setExpanded] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  const canExpand = count > PREVIEW_LIMIT

  if (count === 0) return null

  return (
    <section className="task-detail-workspace-section" data-testid={testId}>
      <div className="task-detail-workspace-section-head">
        <h3 id={`${id}-title`} className="task-detail-workspace-section-title">
          {title}
        </h3>
        <span className="task-detail-workspace-count" data-testid={countTestId}>
          {count}
        </span>
        <div className="task-detail-workspace-section-actions">
          {canExpand ? (
            <button
              type="button"
              data-testid={toggleTestId}
              aria-controls={id}
              aria-expanded={expanded}
              onClick={() => {
                if (listRef.current) listRef.current.scrollTop = 0
                setExpanded(current => !current)
              }}
              className="task-detail-workspace-ghost-action"
            >
              {expanded
                ? translate('todo.collapse', '收起')
                : translate('todo.view_all_count', '查看全部 {{count}} 个', { count })}
            </button>
          ) : null}
          {actions}
        </div>
      </div>
      <div
        id={id}
        ref={listRef}
        role="region"
        aria-labelledby={`${id}-title`}
        tabIndex={expanded ? 0 : undefined}
        data-testid={listTestId}
        className="task-detail-flat-task-list"
      >
        {children(expanded)}
      </div>
    </section>
  )
}

type LinkedEntry =
  | { kind: 'task'; task: SharedIssueDetailTaskBinding }
  | { kind: 'child'; child: CollaborationIssue }

export function IssueLinkedTasks({
  tasks,
  childItems,
  statusOptions,
  statusDotClasses,
  taskExecutionStates,
  deviceNamesById,
  selectedTaskId,
  showCurrentTaskOnly,
  onCreateTask,
  onOpenTaskConversation,
  onOpenChildTask,
  translate,
}: {
  tasks: SharedIssueDetailTaskBinding[]
  childItems: CollaborationIssue[]
  statusOptions: CollaborationStatus[]
  statusDotClasses: Readonly<Record<string, string>>
  taskExecutionStates?: Readonly<Record<string, SharedIssueDetailTaskExecutionState>>
  deviceNamesById?: Readonly<Record<string, string>>
  selectedTaskId?: string | null
  showCurrentTaskOnly?: boolean
  onCreateTask?: () => void
  onOpenTaskConversation?: (task: SharedIssueDetailTaskBinding) => void
  onOpenChildTask?: (child: CollaborationIssue) => void
  translate: CollaborationTranslate
}) {
  const activeTasks = tasks.filter(task =>
    isExecutionActive(taskExecutionStates?.[String(task.id)]?.status)
  )
  const activeIds = new Set(activeTasks.map(task => task.id))
  const recentTasks = tasks
    .filter(task => !activeIds.has(task.id))
    .sort((left, right) => Date.parse(right.linked_at ?? '') - Date.parse(left.linked_at ?? ''))
  const entries: LinkedEntry[] = [
    ...activeTasks.map(task => ({ kind: 'task' as const, task })),
    ...childItems.map(child => ({ kind: 'child' as const, child })),
    ...recentTasks.map(task => ({ kind: 'task' as const, task })),
  ]

  return (
    <ExecutionListSection
      title={
        showCurrentTaskOnly
          ? translate('todo.current_running_task')
          : translate('todo.linked_tasks', '关联任务')
      }
      count={entries.length}
      testId="cloud-todo-tasks"
      listTestId="cloud-todo-task-list"
      toggleTestId="cloud-todo-toggle-tasks"
      countTestId="cloud-todo-execution-task-count"
      translate={translate}
      actions={
        onCreateTask ? (
          <button
            type="button"
            data-testid="cloud-todo-create-task"
            onClick={onCreateTask}
            className="task-detail-workspace-ghost-action"
          >
            <Plus aria-hidden="true" className="h-3.5 w-3.5" />
            {translate('todo.new_task', '新建任务')}
          </button>
        ) : null
      }
    >
      {expanded =>
        (expanded ? entries : entries.slice(0, PREVIEW_LIMIT)).map(entry => {
          if (entry.kind === 'child') {
            const { child } = entry
            const assignee =
              child.assignee_agent_name ?? child.assignee_team_name ?? child.assignee_name
            const status =
              statusOptions.find(option => option.id === child.status)?.name ?? child.status
            const canOpen = Boolean(onOpenChildTask) && child.can_view_detail !== false
            return (
              <button
                key={`child-${child.id}`}
                type="button"
                data-testid={`cloud-todo-open-child-task-${child.id}`}
                disabled={!canOpen}
                onClick={() => onOpenChildTask?.(child)}
                className="task-detail-flat-task-row"
              >
                <span
                  className={`task-detail-flat-task-dot ${statusDotClasses[child.status] ?? ''}`}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-text-primary">
                    {child.title}
                  </span>
                  <span className="mt-0.5 block truncate text-xs text-text-muted">
                    {status}
                    {assignee ? ` · ${assignee}` : ''}
                  </span>
                </span>
                {canOpen ? <ChevronRight className="h-4 w-4 shrink-0 text-text-muted" /> : null}
              </button>
            )
          }
          const { task } = entry
          const selected = selectedTaskId === task.task_id
          const state = taskExecutionStates?.[String(task.id)]
          const deviceLabel = taskDeviceLabel(task, deviceNamesById)
          return (
            <button
              key={`task-${task.id}`}
              type="button"
              data-testid={`cloud-todo-open-task-conversation-${task.id}`}
              data-selected={selected ? 'true' : 'false'}
              onClick={() => onOpenTaskConversation?.(task)}
              className="task-detail-flat-task-row"
            >
              <span
                className={`task-detail-flat-task-dot ${state ? taskExecutionDotClass(state.status) : selected ? 'is-selected' : 'is-idle'}`}
              />
              <span className="min-w-0 flex-1">
                <span
                  className="block truncate text-sm font-medium text-text-primary"
                  title={task.task_title || task.task_id}
                >
                  {task.task_title || task.task_id}
                </span>
                <span className="mt-0.5 block truncate text-xs text-text-muted" title={deviceLabel}>
                  {deviceLabel} ·{' '}
                  {selected
                    ? translate('todo.current_conversation', '当前会话')
                    : translate('todo.expand_conversation', '点击展开会话')}
                </span>
              </span>
              {state ? (
                <span
                  className="task-detail-flat-task-status"
                  data-status={state.status}
                  data-testid={`cloud-todo-task-status-${task.id}`}
                >
                  <span className="task-detail-flat-task-status-dot" aria-hidden="true" />
                  {taskExecutionStatusLabel(state.status, translate)}
                </span>
              ) : null}
              <ChevronRight className="h-4 w-4 shrink-0 text-text-muted" />
            </button>
          )
        })
      }
    </ExecutionListSection>
  )
}

export function IssueDeliveries({
  deliveries,
  onOpen,
  translate,
}: {
  deliveries: SharedIssueDetailDelivery[]
  onOpen(id: string): void
  translate: CollaborationTranslate
}) {
  return (
    <ExecutionListSection
      title={translate('todo.deliveries', '交付')}
      count={deliveries.length}
      testId="todo-detail-deliveries"
      listTestId="todo-detail-delivery-list"
      toggleTestId="todo-detail-toggle-deliveries"
      translate={translate}
    >
      {expanded =>
        (expanded ? deliveries : deliveries.slice(0, PREVIEW_LIMIT)).map(delivery => (
          <button
            key={delivery.id}
            type="button"
            data-testid={`todo-detail-open-delivery-${delivery.id}`}
            onClick={() => onOpen(delivery.id)}
            className="task-detail-workspace-sub-row w-full text-left"
          >
            <Package className="h-4 w-4 shrink-0 text-text-muted" />
            <span className="min-w-0 flex-1 truncate">
              {translate('todo.delivery_result', '交付结果')}
              {delivery.assets.length > 0
                ? ` · ${translate('todo.attachment_count', '{{count}} 个附件', { count: delivery.assets.length })}`
                : ''}
            </span>
            <span className="shrink-0 text-xs text-text-muted">
              {delivery.delivered_at?.slice(0, 10)}
            </span>
          </button>
        ))
      }
    </ExecutionListSection>
  )
}
