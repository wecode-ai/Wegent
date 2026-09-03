import {
  Bot,
  CheckCircle2,
  Clock3,
  Inbox,
  LoaderCircle,
  RefreshCw,
  Search,
  Square,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { CloudLoopItem, CloudLoopItemExecution, CloudProject } from '@/api/deliveries'
import type { ProjectChatAgent } from '@/api/projectChatAgents'
import { runtimeProfileIsRunnable, type RuntimeProfile } from '@/api/runtimeProfiles'
import { CompositedSpinner } from '@/components/common/CompositedSpinner'
import { MenuSelect } from '@/components/common/MenuSelect'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import type { TFunction } from 'i18next'

type DeliveryApi = NonNullable<WorkbenchServices['deliveryApi']>

type QueueExecution = Pick<
  CloudLoopItemExecution,
  | 'id'
  | 'loop_item_id'
  | 'cloud_project_id'
  | 'assigner_user_id'
  | 'agent_id'
  | 'task_title'
  | 'task_status'
  | 'task_priority'
  | 'status'
  | 'display_state'
  | 'queued_at'
  | 'started_at'
  | 'completed_at'
  | 'execution_note'
  | 'version'
  | 'created_at'
  | 'updated_at'
  | 'executor_owner_user_id'
  | 'runtime_profile_id'
  | 'runtime_source'
  | 'can_select_runtime'
  | 'waiting_runtime_reason'
> & {
  team_id?: number | null
  executor_type?: string
}

export interface ExecutionListApi {
  list: (
    projectId: string,
    options: { agent_id?: string; status?: string }
  ) => Promise<QueueExecution[]>
  stop?: (projectId: string, executionId: number) => Promise<{ id: number; status: string }>
}

const QUEUE_STATES = new Set([
  'assigned',
  'waiting_approval',
  'queued',
  'starting',
  'waiting_runtime',
  'running',
  'cancelling',
  'unknown',
  'failed',
])
const MY_APPROVAL_FILTER = 'my_approval'
const STOPPABLE_STATES = new Set([
  'waiting_approval',
  'queued',
  'starting',
  'waiting_runtime',
  'running',
])

function queueStateLabel(state: string, t: TFunction): string {
  switch (state) {
    case 'waiting_approval':
      return t('workbench.queue_state_pending_approval')
    case 'queued':
      return t('workbench.queue_state_queued')
    case 'starting':
      return t('workbench.queue_state_starting')
    case 'waiting_runtime':
      return t('workbench.queue_state_waiting_runtime')
    case 'running':
      return t('workbench.queue_state_running')
    case 'failed':
      return t('workbench.queue_state_failed')
    case 'cancelling':
      return t('workbench.queue_state_cancelling')
    case 'unknown':
      return t('workbench.queue_state_unknown')
    case 'assigned':
      return t('workbench.queue_state_assigned')
    default:
      return state
  }
}

function isInQueue(item: CloudLoopItem): boolean {
  if (item.status === 'completed' || item.status === 'in_review') return false
  if (!item.execution_state) return true
  return QUEUE_STATES.has(item.execution_state)
}

function executionInQueue(execution: QueueExecution): boolean {
  // Keep terminal failed runs visible with their error state, matching the
  // cloud queue (which keeps 'failed' execution_state items in the columns).
  return QUEUE_STATES.has(execution.display_state)
}

type QueueItem = CloudLoopItem & {
  runtime_profile_id?: string | null
  can_select_runtime?: boolean
  executor_owner_user_id?: number | null
}

function executionToItem(execution: QueueExecution): QueueItem {
  return {
    id: execution.loop_item_id,
    cloud_project_id: execution.cloud_project_id,
    sequence_number: 0,
    parent_id: null,
    created_by_user_id: execution.assigner_user_id,
    assignee_user_id: null,
    assignee_agent_id: execution.agent_id,
    assignee_team_id: execution.team_id ?? null,
    assignee_agent_name: undefined,
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
    execution_state: execution.display_state,
    execution_control_state: execution.status,
    can_approve: execution.status === 'pending_approval',
    execution_note: execution.execution_note || null,
    assignment_history: [],
    runtime_profile_id: execution.runtime_profile_id,
    can_select_runtime: execution.can_select_runtime,
    executor_owner_user_id: execution.executor_owner_user_id,
  }
}

function QueueStateChip({ state }: { state?: string | null }) {
  const { t } = useTranslation('common')
  const config = {
    waiting_approval: {
      className: 'bg-amber-500/10 text-amber-700',
      Icon: Clock3,
    },
    queued: {
      className: 'bg-sky-500/10 text-sky-700',
      Icon: Inbox,
    },
    starting: {
      className: 'bg-indigo-500/10 text-indigo-700',
      Icon: Inbox,
    },
    waiting_runtime: {
      className: 'bg-indigo-500/10 text-indigo-700',
      Icon: Clock3,
    },
    running: {
      className: 'bg-violet-500/10 text-violet-700',
      Icon: LoaderCircle,
    },
    failed: {
      className: 'bg-red-500/10 text-red-700',
      Icon: RefreshCw,
    },
    cancelling: {
      className: 'bg-amber-500/10 text-amber-700',
      Icon: LoaderCircle,
    },
    unknown: {
      className: 'bg-red-500/10 text-red-700',
      Icon: RefreshCw,
    },
    assigned: {
      className: 'bg-muted text-text-secondary',
      Icon: CheckCircle2,
    },
  } as const
  const current = state ? config[state as keyof typeof config] : undefined
  if (!current) return null
  const Icon = current.Icon
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium',
        current.className
      )}
    >
      {state === 'running' || state === 'cancelling' ? (
        <CompositedSpinner icon={Icon} className="h-3 w-3" />
      ) : (
        <Icon className="h-3 w-3" />
      )}
      {state ? queueStateLabel(state, t) : ''}
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
  runtimeProfileApi,
  runtimeProfiles = [],
  currentUserId,
  onOpenTask,
  embedded = false,
}: {
  api: DeliveryApi
  project: CloudProject
  projectChatAgentApi?: NonNullable<WorkbenchServices['projectChatAgentApi']>
  executionApi?: ExecutionListApi
  runtimeProfileApi?: WorkbenchServices['runtimeProfileApi']
  runtimeProfiles?: RuntimeProfile[]
  currentUserId?: string | number
  onOpenTask?: (item: CloudLoopItem) => void
  embedded?: boolean
}) {
  const { t } = useTranslation('common')
  const [agents, setAgents] = useState<ProjectChatAgent[]>([])
  const [myTasks, setMyTasks] = useState<CloudLoopItem[]>([])
  const [botQueues, setBotQueues] = useState<Record<string, CloudLoopItem[]>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [stateFilter, setStateFilter] = useState<string>('all')
  const [query, setQuery] = useState('')
  const [reloadKey, setReloadKey] = useState(0)
  const [stoppingExecutionId, setStoppingExecutionId] = useState<number | null>(null)
  const [selectingRuntimeExecutionId, setSelectingRuntimeExecutionId] = useState<number | null>(
    null
  )
  const runnableRuntimeProfiles = useMemo(
    () => runtimeProfiles.filter(runtimeProfileIsRunnable),
    [runtimeProfiles]
  )

  const selectRuntime = async (item: QueueItem, runtimeProfileId: string) => {
    if (!runtimeProfileApi || item.execution_id == null) return
    setSelectingRuntimeExecutionId(item.execution_id)
    setError(null)
    try {
      await runtimeProfileApi.selectExecution(
        project.id,
        item.execution_id,
        runtimeProfileId,
        item.version
      )
      setReloadKey(key => key + 1)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('workbench.runtime_select_failed'))
    } finally {
      setSelectingRuntimeExecutionId(null)
    }
  }

  const stopExecution = async (item: CloudLoopItem) => {
    if (!executionApi?.stop || item.execution_id == null) return
    setStoppingExecutionId(item.execution_id)
    setError(null)
    try {
      await executionApi.stop(project.id, item.execution_id)
      setReloadKey(key => key + 1)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('workbench.queue_stop_failed'))
    } finally {
      setStoppingExecutionId(null)
    }
  }

  useEffect(() => {
    let active = true
    let loadSeq = 0
    const load = async (background: boolean) => {
      const seq = ++loadSeq
      // Only the initial load swaps the content for the spinner. Background
      // refreshes update the existing content in place, so a fresh snapshot
      // never flashes the loading state.
      if (!background) {
        setLoading(true)
        setError(null)
      }
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
        if (!active || seq !== loadSeq) return
        setAgents(nextAgents)
        setMyTasks(myResponse.items)
        const queues: Record<string, CloudLoopItem[]> = {}
        if (executionApi) {
          const all = await executionApi.list(project.id, {})
          if (!active || seq !== loadSeq) return
          const byExecutor = new Map<string, QueueExecution[]>()
          for (const execution of all) {
            const executorKey = execution.agent_id
              ? `agent:${execution.agent_id}`
              : 'generic-runtime'
            const bucket = byExecutor.get(executorKey) ?? []
            bucket.push(execution)
            byExecutor.set(executorKey, bucket)
          }
          for (const agent of nextAgents) {
            queues[`agent:${agent.id}`] = (byExecutor.get(`agent:${agent.id}`) ?? [])
              .filter(executionInQueue)
              .map(executionToItem)
          }
          queues['generic-runtime'] = (byExecutor.get('generic-runtime') ?? [])
            .filter(executionInQueue)
            .map(executionToItem)
        } else {
          for (const agent of nextAgents) {
            const response = await api.listLoopItems(project.id, {
              assigneeType: 'agent',
              assigneeId: agent.id,
            })
            if (!active || seq !== loadSeq) return
            queues[`agent:${agent.id}`] = response.items.filter(isInQueue)
          }
        }
        setBotQueues(queues)
        setError(null)
      } catch (cause) {
        if (!active || seq !== loadSeq) return
        // Keep the last good content on background refresh failures; only the
        // initial load surfaces the error banner.
        if (!background) setError(cause instanceof Error ? cause.message : '加载队列失败')
      } finally {
        if (active && seq === loadSeq) setLoading(false)
      }
    }
    void load(false)
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load(true)
    }, 15_000)
    return () => {
      active = false
      window.clearInterval(interval)
    }
  }, [api, currentUserId, executionApi, project.id, projectChatAgentApi, reloadKey])

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
        items: botQueues[`agent:${agent.id}`] ?? [],
        bot: agent,
      })
    }
    const genericItems = botQueues['generic-runtime'] ?? []
    if (genericItems.length > 0) {
      columns.push({
        key: 'generic-runtime',
        title: t('workbench.queue_generic_ai'),
        items: genericItems,
      })
    }
    return columns
  }, [agents, botQueues, currentUserId, myTasks, t])

  const stateCounts = useMemo(() => {
    const counts: Record<string, number> = { all: 0, my_approval: 0 }
    QUEUE_STATES.forEach(state => {
      counts[state] = 0
    })
    for (const column of queueColumns) {
      for (const item of column.items) {
        counts.all += 1
        const state = item.execution_state ?? ''
        if (counts[state] !== undefined) counts[state] += 1
        if (state === 'waiting_approval' && item.can_approve === true) {
          counts.my_approval += 1
        }
      }
    }
    return counts
  }, [queueColumns])

  const trimmedQuery = query.trim().toLowerCase()
  const isVisible = (item: CloudLoopItem) =>
    (stateFilter === MY_APPROVAL_FILTER
      ? item.execution_state === 'waiting_approval' && item.can_approve === true
      : stateFilter === 'all' || item.execution_state === stateFilter) &&
    (!trimmedQuery || item.title.toLowerCase().includes(trimmedQuery))

  return (
    <div
      className={cn('flex min-h-0 flex-1 flex-col', embedded ? '' : 'px-6 pb-6 pt-4')}
      data-testid="project-queue-view"
    >
      {!embedded ? (
        <div className="mb-3 flex items-center gap-2">
          <h2 className="text-heading-md font-semibold">{t('workbench.queue_title')}</h2>
          <span className="text-xs text-text-muted">{t('workbench.queue_description')}</span>
        </div>
      ) : null}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          data-testid="project-queue-filter-all"
          onClick={() => setStateFilter('all')}
          className={cn(
            'h-8 rounded-lg border px-3 text-xs',
            stateFilter === 'all'
              ? 'border-transparent bg-text-primary font-medium text-background'
              : 'border-border bg-background text-text-secondary hover:bg-muted'
          )}
        >
          {t('workbench.queue_filter_all')} {stateCounts.all}
        </button>
        {Array.from(QUEUE_STATES).map(state => (
          <button
            key={state}
            type="button"
            data-testid={`project-queue-filter-${state}`}
            onClick={() => setStateFilter(state)}
            className={cn(
              'h-8 rounded-lg border px-3 text-xs',
              stateFilter === state
                ? 'border-transparent bg-text-primary font-medium text-background'
                : 'border-border bg-background text-text-secondary hover:bg-muted'
            )}
          >
            {queueStateLabel(state, t)} {stateCounts[state]}
          </button>
        ))}
        <button
          type="button"
          data-testid="project-queue-filter-my-approval"
          onClick={() => setStateFilter(MY_APPROVAL_FILTER)}
          className={cn(
            'h-8 rounded-lg border px-3 text-xs',
            stateFilter === MY_APPROVAL_FILTER
              ? 'border-transparent bg-text-primary font-medium text-background'
              : 'border-border bg-background text-text-secondary hover:bg-muted'
          )}
        >
          {t('workbench.queue_filter_my_approval')} {stateCounts.my_approval}
        </button>
        <label className="ml-auto flex h-8 min-w-52 items-center gap-2 rounded-lg border border-border px-2.5 text-xs text-text-muted focus-within:border-focus">
          <Search className="h-3.5 w-3.5" />
          <input
            data-testid="project-queue-search"
            value={query}
            onChange={event => setQuery(event.target.value)}
            placeholder={t('workbench.queue_search_placeholder')}
            className="min-w-0 flex-1 bg-transparent text-text-primary outline-none"
          />
        </label>
      </div>
      {error ? <p className="mb-3 text-sm text-red-600">{error}</p> : null}
      {loading ? (
        <div className="flex h-40 items-center justify-center text-sm text-text-muted">
          <CompositedSpinner className="mr-2 h-4 w-4" />
          {t('workbench.project_chat_loading')}
        </div>
      ) : (
        <div
          className={cn(
            'grid min-h-0 flex-1 auto-rows-min grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3',
            embedded ? 'overflow-visible' : 'overflow-y-auto'
          )}
        >
          {queueColumns.every(column => column.items.filter(isVisible).length === 0) ? (
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
                {column.items.filter(isVisible).length === 0 ? (
                  <p className="py-6 text-center text-xs text-text-muted">
                    {t('workbench.queue_column_empty')}
                  </p>
                ) : (
                  column.items.filter(isVisible).map(item => {
                    const queueItem = item as QueueItem
                    const canStop =
                      Boolean(executionApi?.stop) &&
                      item.execution_id != null &&
                      STOPPABLE_STATES.has(item.execution_state ?? '')
                    return (
                      <div
                        key={item.execution_id ? `${item.id}:${item.execution_id}` : item.id}
                        className="group relative"
                      >
                        <button
                          type="button"
                          data-testid={`project-queue-task-${item.id}`}
                          onClick={() => onOpenTask?.(item)}
                          className={cn(
                            'flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition hover:bg-muted',
                            canStop && 'pr-8'
                          )}
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
                            {queueItem.can_select_runtime &&
                            item.execution_id != null &&
                            String(queueItem.executor_owner_user_id ?? '') ===
                              String(currentUserId ?? '') ? (
                              <span
                                className="mt-1 block"
                                onClick={event => event.stopPropagation()}
                              >
                                <MenuSelect
                                  testId={`project-queue-runtime-${item.execution_id}`}
                                  value={queueItem.runtime_profile_id ?? ''}
                                  disabled={selectingRuntimeExecutionId === item.execution_id}
                                  placeholder={t('workbench.runtime_select')}
                                  onChange={value => void selectRuntime(queueItem, value)}
                                  options={runnableRuntimeProfiles.map(profile => ({
                                    value: profile.id,
                                    label: `${profile.name} · ${profile.model}`,
                                  }))}
                                />
                              </span>
                            ) : null}
                          </span>
                          <PriorityBadge priority={item.priority} />
                          <QueueStateChip state={item.execution_state} />
                        </button>
                        {canStop ? (
                          <button
                            type="button"
                            data-testid={`project-queue-stop-${item.id}`}
                            title={t('workbench.queue_stop')}
                            disabled={stoppingExecutionId === item.execution_id}
                            onClick={event => {
                              event.stopPropagation()
                              void stopExecution(item)
                            }}
                            className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1 text-text-muted transition hover:bg-destructive/10 hover:text-destructive disabled:opacity-40"
                          >
                            <Square className="h-3.5 w-3.5" />
                          </button>
                        ) : null}
                      </div>
                    )
                  })
                )}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  )
}
