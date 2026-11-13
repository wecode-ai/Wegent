import { useContext, useState, type ReactNode } from 'react'
import { ArrowUpRight, LoaderCircle, SquareTerminal } from 'lucide-react'
import type { WorkspaceMyWorkItem, WorkspaceTaskBinding } from '@wegent/collaboration'
import { findRuntimeTask } from '@wegent/chat-core/runtime-task-lookup'
import { WorkbenchContext } from '@/features/workbench/useWorkbench'
import { useRuntimeTaskLifecycleResolver } from '@/features/workbench/runtimeTaskLifecycle'
import {
  runtimeTaskSummaryTrackingExecutionStatus,
  runtimeTaskTrackingExecutionStatus,
} from '@/features/workbench/runtimeTaskLifecycle/projection'
import { useTranslation } from '@/hooks/useTranslation'
import { findWorkbenchDevice } from '@/lib/workbench-device'
import { AnchorPopover } from './AnchorPopover'

/** Consume the page's batched context; rendering an Issue must never request its own data. */
export function PersonalHomeIssueActivity({
  issueId,
  assignment,
  bindings = [],
  active,
  summary,
  onOpenTask,
}: {
  issueId: string
  assignment?: WorkspaceMyWorkItem['assignment_context']
  bindings?: readonly WorkspaceTaskBinding[]
  active: boolean
  summary?: ReactNode
  onOpenTask?(binding: WorkspaceTaskBinding): void
}) {
  const { t } = useTranslation('common')
  const workbench = useContext(WorkbenchContext)
  const resolveLifecycle = useRuntimeTaskLifecycleResolver()
  const [taskAnchor, setTaskAnchor] = useState<HTMLButtonElement | null>(null)
  const tasks = bindings.map(binding => {
    const reminder = workbench?.runtimeTaskReminders.items.find(
      item => item.address.deviceId === binding.deviceId && item.address.taskId === binding.taskId
    )
    const lifecycle = resolveLifecycle(binding) ?? reminder?.lifecycle
    const task =
      lifecycle?.task ?? reminder?.task ?? findRuntimeTask(workbench?.state?.runtimeWork, binding)
    const interaction = lifecycle?.interactionStatus ?? task?.interactionStatus
    const status =
      interaction === 'waitingForUserInput' || interaction === 'awaitingUserReply'
        ? 'waiting'
        : ((lifecycle
            ? runtimeTaskTrackingExecutionStatus(lifecycle)
            : task
              ? runtimeTaskSummaryTrackingExecutionStatus(task)
              : null) ?? (binding.standInPending ? 'reserved' : 'unknown'))
    return {
      binding,
      status,
      title: task?.title || binding.taskTitle || t('personalHome.viewTask'),
    }
  })
  const statusLabel = (status: string) =>
    status === 'reserved'
      ? t('todo.assistant_task_pending')
      : status === 'waiting'
        ? t('personalHome.taskStatusWaiting')
        : status === 'unknown'
          ? t('personalHome.taskStatusUnknown')
          : t(`todo.workflow_task_status_${status === 'queued' ? 'pending' : status}`)
  const statusOrder = [
    'waiting',
    'failed',
    'running',
    'queued',
    'cancelled',
    'succeeded',
    'archived',
    'reserved',
    'unknown',
  ]
  const counts = [
    ...tasks.reduce(
      (result, row) => result.set(row.status, (result.get(row.status) ?? 0) + 1),
      new Map<string, number>()
    ),
  ].sort(([left], [right]) => statusOrder.indexOf(left) - statusOrder.indexOf(right))
  const local =
    bindings.length > 0 &&
    bindings.every(
      binding =>
        findWorkbenchDevice(workbench?.state?.devices ?? [], binding.deviceId)?.device_type ===
        'local'
    )
  const countLabel = t(
    `personalHome.${local ? 'localTaskCount' : 'linkedTaskCount'}${tasks.length === 1 ? 'Single' : ''}`,
    { count: tasks.length }
  )
  const names = tasks
    .slice(0, 2)
    .map(task => task.title)
    .join('、')

  return (
    <div data-testid={`personal-home-assignment-${issueId}`}>
      {summary && <div className="mt-2">{summary}</div>}
      {assignment?.body && (
        <blockquote className="mt-2 border-l border-border pl-3 text-sm text-text-secondary">
          <span className="mb-1 block text-xs text-text-muted">
            {t('personalHome.assignmentReason')}
            {assignment.created_by_user_name ? ` · ${assignment.created_by_user_name}` : ''}
          </span>
          <span className="line-clamp-2 whitespace-pre-wrap">{assignment.body}</span>
        </blockquote>
      )}
      {tasks.length > 0 && (
        <button
          type="button"
          data-testid={
            tasks.length === 1
              ? `personal-home-task-${issueId}-${tasks[0].binding.id}`
              : `personal-home-tasks-summary-${issueId}`
          }
          data-execution-state={tasks.length === 1 ? tasks[0].status : undefined}
          disabled={!onOpenTask || (tasks.length === 1 && tasks[0].status === 'reserved')}
          aria-haspopup={tasks.length > 1 ? 'dialog' : undefined}
          aria-expanded={tasks.length > 1 ? Boolean(taskAnchor) : undefined}
          title={tasks.map(task => `${task.title} · ${statusLabel(task.status)}`).join('\n')}
          className="mt-2 inline-flex min-h-11 max-w-full items-center gap-2 whitespace-nowrap rounded-md py-1 text-sm text-text-secondary transition-colors hover:text-text-primary keyboard:focus-visible:ring-2 keyboard:focus-visible:ring-focus/30 md:min-h-7"
          onClick={event => {
            event.stopPropagation()
            if (tasks.length === 1) onOpenTask?.(tasks[0].binding)
            else setTaskAnchor(event.currentTarget)
          }}
        >
          <SquareTerminal aria-hidden="true" className="h-4 w-4 shrink-0 text-text-muted" />
          <span className="min-w-0 max-w-sm truncate">{names}</span>
          <span className="shrink-0">{countLabel}</span>
          {counts
            .filter(([status]) => status !== 'unknown')
            .slice(0, 2)
            .map(([status, count]) => (
              <span
                key={status}
                className={`inline-flex shrink-0 items-center gap-1 text-xs ${status === 'failed' ? 'text-error' : 'text-text-muted'}`}
              >
                {status === 'running' ? (
                  <LoaderCircle aria-hidden="true" className="h-3 w-3 motion-safe:animate-spin" />
                ) : (
                  <span
                    aria-hidden="true"
                    className={`h-1.5 w-1.5 rounded-full ${status === 'succeeded' ? 'bg-emerald-500' : 'bg-current'}`}
                  />
                )}
                {statusLabel(status)} {count}
              </span>
            ))}
          <ArrowUpRight aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-text-muted" />
        </button>
      )}
      {taskAnchor && active && tasks.length > 1 && (
        <AnchorPopover
          anchor={taskAnchor}
          title={t('personalHome.linkedTasks')}
          testId={`personal-home-tasks-picker-${issueId}`}
          onClose={() => {
            taskAnchor.focus()
            setTaskAnchor(null)
          }}
        >
          {tasks.map(task => (
            <button
              type="button"
              key={task.binding.id}
              disabled={!onOpenTask || task.status === 'reserved'}
              data-testid={`personal-home-task-${issueId}-${task.binding.id}`}
              className="flex min-h-11 w-full items-center gap-2 rounded-md px-2 text-left text-sm hover:bg-muted md:min-h-8"
              onClick={event => {
                event.stopPropagation()
                setTaskAnchor(null)
                onOpenTask?.(task.binding)
              }}
            >
              <span className="min-w-0 flex-1 truncate">{task.title}</span>
              <span className="shrink-0 text-xs text-text-muted">{statusLabel(task.status)}</span>
              <ArrowUpRight aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-text-muted" />
            </button>
          ))}
        </AnchorPopover>
      )}
    </div>
  )
}
