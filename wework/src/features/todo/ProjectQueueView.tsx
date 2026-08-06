import { Bot, CheckCircle2, Clock3, Inbox, LoaderCircle, RefreshCw } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { CloudLoopItem, CloudProject } from '@/api/deliveries'
import type { LocalLoopItemExecution } from '@/api/local/localDelivery'
import type { ProjectChatAgent } from '@/api/projectChatAgents'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'

type DeliveryApi = NonNullable<WorkbenchServices['deliveryApi']>

const QUEUE_STATES = new Set([
  'assigned',
  'pending_approval',
  'queued',
  'claimed',
  'running',
  'failed',
])

function isInQueue(item: CloudLoopItem): boolean {
  if (item.status === 'completed' || item.status === 'in_review') return false
  if (!item.execution_state) return true
  return QUEUE_STATES.has(item.execution_state)
}

function executionInQueue(execution: LocalLoopItemExecution): boolean {
  return ['pending_approval', 'queued', 'claimed', 'running'].includes(execution.status)
}

function executionToItem(execution: LocalLoopItemExecution): CloudLoopItem {
  return {
    id: execution.loop_item_id,
    cloud_project_id: execution.cloud_project_id,
    sequence_number: 0,
    parent_id: null,
    created_by_user_id: execution.assigner_user_id,
    assignee_user_id: null,
    title: execution.task_title,
    description: '',
    status: execution.task_status ?? 'inbox',
    priority: (execution.task_priority as CloudLoopItem['priority']) ?? 'none',
    due_at: null,
    tags: [],
    sort_order: 0,
    current_delivery_id: null,
    version: execution.version,
    created_at: execution.created_at,
    updated_at: execution.updated_at,
    completed_at: execution.completed_at ?? null,
    execution_id: execution.id,
    execution_state: execution.status,
    execution_note: execution.execution_note || null,
    assignment_history: [],
  }
}

function QueueStateChip({ state }: { state?: string | null }) {
  const { t } = useTranslation('common')
  const config = {
    pending_approval: {
      label: t('workbench.queue_state_pending_approval'),
      className: 'bg-amber-500/10 text-amber-700',
      Icon: Clock3,
    },
    queued: {
      label: t('workbench.queue_state_queued'),
      className: 'bg-sky-500/10 text-sky-700',
      Icon: Inbox,
    },
    claimed: {
      label: t('workbench.queue_state_claimed', '已领取'),
      className: 'bg-indigo-500/10 text-indigo-700',
      Icon: Inbox,
    },
    running: {
      label: t('workbench.queue_state_running'),
      className: 'bg-violet-500/10 text-violet-700',
      Icon: LoaderCircle,
    },
    failed: {
      label: t('workbench.queue_state_failed'),
      className: 'bg-red-500/10 text-red-700',
      Icon: RefreshCw,
    },
    assigned: {
      label: t('workbench.queue_state_assigned'),
      className: 'bg-emerald-500/10 text-emerald-700',
      Icon: CheckCircle2,
    },
  } as const
  const current = config[state as keyof typeof config]
  if (!current) return null
  const Icon = current.Icon
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium',
        current.className
      )}
    >
      <Icon className="h-3 w-3" />
      {current.label}
    </span>
  )
}

const PRIORITY_LABELS: Record<string, string> = {
  none: '',
  low: '低',
  medium: '中',
  high: '高',
  urgent: '紧急',
}

const PRIORITY_CLASSES: Record<string, string> = {
  none: '',
  low: 'bg-sky-500/10 text-sky-700',
  medium: 'bg-emerald-500/10 text-emerald-700',
  high: 'bg-amber-500/10 text-amber-700',
  urgent: 'bg-red-500/10 text-red-700',
}

function PriorityBadge({ priority }: { priority?: string | null }) {
  const label = PRIORITY_LABELS[priority ?? 'none'] ?? ''
  if (!label) return null
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center rounded-full px-1.5 py-0.5 text-xs font-medium',
        PRIORITY_CLASSES[priority ?? 'none'] ?? ''
      )}
    >
      {label}
    </span>
  )
}

export function ProjectQueueView({
  api,
  project,
  projectChatAgentApi,
  executionApi,
  currentUserId,
  onOpenTask,
}: {
  api: DeliveryApi
  project: CloudProject
  projectChatAgentApi?: NonNullable<WorkbenchServices['projectChatAgentApi']>
  executionApi?: NonNullable<WorkbenchServices['localLoopItemExecutionApi']>
  currentUserId?: string | number
  onOpenTask?: (item: CloudLoopItem) => void
}) {
  const { t } = useTranslation('common')
  const [agents, setAgents] = useState<ProjectChatAgent[]>([])
  const [myTasks, setMyTasks] = useState<CloudLoopItem[]>([])
  const [botQueues, setBotQueues] = useState<Record<string, CloudLoopItem[]>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    const load = async () => {
      setLoading(true)
      setError(null)
      try {
        const [nextAgents, myResponse] = await Promise.all([
          projectChatAgentApi
            ? projectChatAgentApi.list(project.id)
            : Promise.resolve([] as ProjectChatAgent[]),
          api.listLoopItems(project.id, {
            assigneeType: 'user',
            ...(currentUserId !== undefined ? { assigneeId: currentUserId } : {}),
          }),
        ])
        if (!active) return
        setAgents(nextAgents)
        setMyTasks(myResponse.items)
        const queues: Record<string, CloudLoopItem[]> = {}
        if (executionApi) {
          for (const agent of nextAgents) {
            const executions = await executionApi.list(project.id, { agent_id: agent.id })
            if (!active) return
            queues[agent.id] = executions.filter(executionInQueue).map(executionToItem)
          }
        } else {
          for (const agent of nextAgents) {
            const response = await api.listLoopItems(project.id, {
              assigneeType: 'agent',
              assigneeId: agent.id,
            })
            if (!active) return
            queues[agent.id] = response.items.filter(isInQueue)
          }
        }
        setBotQueues(queues)
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : '加载队列失败')
      } finally {
        if (active) setLoading(false)
      }
    }
    void load()
    return () => {
      active = false
    }
  }, [api, currentUserId, executionApi, project.id, projectChatAgentApi])

  const queueColumns = useMemo(() => {
    const columns: Array<{
      key: string
      title: string
      items: CloudLoopItem[]
      bot?: ProjectChatAgent
    }> = []
    const visibleMyTasks = myTasks.filter(isInQueue)
    if (currentUserId !== undefined || visibleMyTasks.length > 0) {
      columns.push({
        key: 'me',
        title: t('workbench.queue_my_tasks'),
        items: visibleMyTasks,
      })
    }
    for (const agent of agents) {
      columns.push({
        key: agent.id,
        title: agent.name,
        items: botQueues[agent.id] ?? [],
        bot: agent,
      })
    }
    return columns
  }, [agents, botQueues, currentUserId, myTasks, t])

  return (
    <div className="flex min-h-0 flex-1 flex-col px-6 pb-6 pt-4" data-testid="project-queue-view">
      <div className="mb-3 flex items-center gap-2">
        <h2 className="text-heading-md font-semibold">{t('workbench.queue_title')}</h2>
        <span className="text-xs text-text-muted">{t('workbench.queue_description')}</span>
      </div>
      {error ? <p className="mb-3 text-sm text-red-600">{error}</p> : null}
      {loading ? (
        <div className="flex h-40 items-center justify-center text-sm text-text-muted">
          <LoaderCircle className="mr-2 h-4 w-4 animate-spin" />
          {t('workbench.project_chat_loading')}
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 auto-rows-min grid-cols-1 gap-3 overflow-y-auto sm:grid-cols-2 xl:grid-cols-3">
          {queueColumns.length === 0 ? (
            <div className="col-span-full flex h-40 items-center justify-center text-sm text-text-muted">
              {t('workbench.queue_empty')}
            </div>
          ) : null}
          {queueColumns.map(column => (
            <section
              key={column.key}
              data-testid={`project-queue-column-${column.key}`}
              className="flex min-h-40 flex-col rounded-xl border border-border bg-background"
            >
              <header className="flex items-center gap-2 border-b border-border/70 px-3 py-2">
                {column.bot ? (
                  <span className="flex h-6 w-6 items-center justify-center rounded-full bg-violet-500/10 text-violet-600">
                    <Bot className="h-3.5 w-3.5" />
                  </span>
                ) : (
                  <span className="flex h-6 w-6 items-center justify-center rounded-full bg-muted text-text-secondary">
                    <CheckCircle2 className="h-3.5 w-3.5" />
                  </span>
                )}
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{column.title}</span>
                <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-text-muted">
                  {column.items.length}
                </span>
              </header>
              <div className="flex-1 space-y-1 p-2">
                {column.items.length === 0 ? (
                  <p className="py-6 text-center text-xs text-text-muted">
                    {t('workbench.queue_column_empty')}
                  </p>
                ) : (
                  column.items.map(item => (
                    <button
                      key={item.id}
                      type="button"
                      data-testid={`project-queue-task-${item.id}`}
                      onClick={() => onOpenTask?.(item)}
                      className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition hover:bg-muted"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-xs font-medium text-text-primary">
                          {item.title}
                        </span>
                        <span className="block truncate text-xs text-text-muted">
                          {item.assignment_history?.at(-1)
                            ? `${t('workbench.queue_assigned_by')} ${item.assignment_history.at(-1)?.to_name ?? `#${item.assignment_history.at(-1)?.by_user_id}`}`
                            : item.id}
                        </span>
                        {item.execution_note ? (
                          <span className="block truncate text-xs text-amber-600">
                            {item.execution_note}
                          </span>
                        ) : null}
                      </span>
                      <PriorityBadge priority={item.priority} />
                      <QueueStateChip state={item.execution_state} />
                    </button>
                  ))
                )}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  )
}
