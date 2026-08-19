import { useCallback, useEffect, useState } from 'react'
import {
  AlertCircle,
  Check,
  CirclePause,
  ExternalLink,
  LoaderCircle,
  Play,
  RefreshCw,
  Sparkles,
} from 'lucide-react'
import type { CloudLoopItem, WorkflowPlan } from '@/api/deliveries'
import { createDeliveryApi } from '@/api/deliveries'
import { useTranslation } from '@/hooks/useTranslation'

type DeliveryApi = ReturnType<typeof createDeliveryApi>

export function IssueWorkflowPlan({
  api,
  item,
  onUpdated,
  onChanged,
  onOpenTask,
  onViewActivity,
}: {
  api: DeliveryApi
  item: CloudLoopItem
  onUpdated: (item: CloudLoopItem) => void
  onChanged?: () => void
  onOpenTask?: (taskId: string) => void
  onViewActivity?: (messageId: string) => void
}) {
  const { t } = useTranslation('common')
  const [plan, setPlan] = useState<WorkflowPlan | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const fetchPlan = useCallback(async () => {
    const next = await api.getWorkflowPlan(item.id)
    if (next?.status && next.status !== item.workflow?.orchestration_status) {
      onUpdated(await api.getLoopItem(item.id))
    }
    return next
  }, [api, item.id, item.workflow?.orchestration_status, onUpdated])

  const refreshPlan = useCallback(async () => {
    const next = await fetchPlan()
    setPlan(next)
    setError('')
    return next
  }, [fetchPlan])

  useEffect(() => {
    let active = true
    void fetchPlan()
      .then(next => {
        if (!active) return
        setPlan(next)
        setError('')
      })
      .catch(cause => {
        if (active) setError(cause instanceof Error ? cause.message : String(cause))
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [fetchPlan, item.workflow?.active_run_id])

  useEffect(() => {
    const transient = [
      'preparing',
      'waiting_approval',
      'queued',
      'starting',
      'waiting_runtime',
      'running',
      'cancelling',
    ]
    const coordinatorTransient =
      plan?.coordinator_run && transient.includes(plan.coordinator_run.status)
    if (plan?.status !== 'planning' && plan?.status !== 'running' && !coordinatorTransient) return
    let active = true
    let timer: number | undefined
    const poll = () => {
      if (!active) return
      if (document.visibilityState !== 'visible') {
        timer = window.setTimeout(poll, 3000)
        return
      }
      void refreshPlan()
        .catch(cause => {
          setError(cause instanceof Error ? cause.message : String(cause))
        })
        .finally(() => {
          if (active) timer = window.setTimeout(poll, 3000)
        })
    }
    timer = window.setTimeout(poll, 3000)
    return () => {
      active = false
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [plan?.coordinator_run, plan?.status, refreshPlan])

  const act = async (action: () => Promise<WorkflowPlan | null>) => {
    setBusy(true)
    setError('')
    try {
      setPlan(await action())
      onUpdated(await api.getLoopItem(item.id))
      onChanged?.()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const status = plan?.status ?? item.workflow?.orchestration_status ?? 'idle'
  const coordinator = plan?.coordinator_run
  const coordinatorActive = Boolean(
    coordinator &&
    [
      'preparing',
      'waiting_approval',
      'queued',
      'starting',
      'waiting_runtime',
      'running',
      'cancelling',
    ].includes(coordinator.status)
  )
  const coordinatorStatus: Record<string, string> = {
    preparing: t('todo.workflow_coordinator_preparing'),
    waiting_approval: t('todo.workflow_coordinator_waiting_approval'),
    queued: t('todo.workflow_coordinator_queued'),
    starting: t('todo.workflow_coordinator_starting'),
    waiting_runtime: t('todo.workflow_coordinator_waiting_runtime'),
    running: t('todo.workflow_coordinator_running'),
    succeeded: t('todo.workflow_coordinator_succeeded'),
    failed: t('todo.workflow_coordinator_failed'),
    cancelled: t('todo.workflow_coordinator_cancelled'),
    cancelling: t('todo.workflow_coordinator_cancelling'),
    interrupted: t('todo.workflow_coordinator_interrupted'),
    unknown: t('todo.workflow_coordinator_interrupted'),
  }
  const statusText: Record<string, string> = {
    idle: t('todo.workflow_plan_idle'),
    planning: t('todo.workflow_plan_planning'),
    awaiting_approval: t('todo.workflow_plan_awaiting_approval'),
    dispatching: t('todo.workflow_plan_dispatching'),
    running: t('todo.workflow_plan_running'),
    paused: t('todo.workflow_plan_paused'),
    completed: t('todo.workflow_plan_completed'),
    failed: t('todo.workflow_plan_failed'),
  }
  const taskStatusText: Record<string, string> = {
    inbox: t('todo.cloud_todo_status_inbox', '收集箱'),
    pending: t('todo.cloud_todo_status_pending', '待处理'),
    in_progress: t('todo.cloud_todo_status_in_progress', '进行中'),
    in_review: t('todo.cloud_todo_status_in_review', '待评审'),
    completed: t('todo.cloud_todo_status_completed', '已完成'),
  }

  return (
    <section className="mt-6" data-testid="issue-workflow-plan">
      <div className="flex min-h-8 items-center gap-2">
        <Sparkles className="h-4 w-4 text-text-secondary" />
        <h3 className="text-sm font-semibold text-text-primary">{t('todo.workflow_plan_title')}</h3>
        <span className="text-xs text-text-muted">{statusText[status] ?? status}</span>
        <span className="flex-1" />
        {status === 'running' ? (
          <button
            type="button"
            data-testid="issue-workflow-plan-pause"
            disabled={busy}
            onClick={() => void act(() => api.pauseWorkflowPlan(item.id))}
            className="flex h-7 items-center gap-1 rounded-lg px-2 text-xs text-text-secondary hover:bg-muted disabled:opacity-50"
          >
            <CirclePause className="h-3.5 w-3.5" />
            {t('todo.workflow_plan_pause')}
          </button>
        ) : null}
        {status === 'paused' || status === 'failed' || status === 'idle' ? (
          <button
            type="button"
            data-testid="issue-workflow-plan-resume"
            disabled={busy}
            onClick={() => void act(() => api.resumeWorkflowPlan(item.id))}
            className="flex h-7 items-center gap-1 rounded-lg px-2 text-xs text-text-secondary hover:bg-muted disabled:opacity-50"
          >
            <Play className="h-3.5 w-3.5" />
            {t('todo.workflow_plan_resume')}
          </button>
        ) : null}
        {plan ? (
          <button
            type="button"
            data-testid="issue-workflow-plan-replan"
            disabled={busy || status === 'dispatching' || coordinatorActive}
            onClick={() => void act(() => api.replanWorkflowPlan(item.id))}
            className="flex h-7 items-center gap-1 rounded-lg px-2 text-xs text-text-secondary hover:bg-muted disabled:opacity-50"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            {t('todo.workflow_plan_replan')}
          </button>
        ) : null}
      </div>

      <div className="mt-2 rounded-xl border border-border">
        {coordinator ? (
          <div
            className="border-b border-border px-4 py-3"
            data-testid="issue-workflow-coordinator-run"
          >
            <div className="flex items-start gap-3">
              <span className="mt-0.5 text-text-muted">
                {coordinatorActive ? (
                  <LoaderCircle className="h-4 w-4 animate-spin" />
                ) : coordinator.status === 'succeeded' ? (
                  <Check className="h-4 w-4" />
                ) : (
                  <AlertCircle
                    className={
                      coordinator.status === 'failed' ? 'h-4 w-4 text-destructive' : 'h-4 w-4'
                    }
                  />
                )}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-text-primary">
                  {coordinatorStatus[coordinator.status] ?? coordinator.status}
                </span>
                <span className="mt-0.5 block truncate text-xs text-text-muted">
                  {coordinator.manager_name}
                  {coordinator.model ? ` · ${coordinator.model}` : ''}
                  {coordinator.execution_environment === 'cloud'
                    ? ` · ${t('todo.workflow_coordinator_cloud')}`
                    : coordinator.execution_environment === 'local'
                      ? ` · ${t('todo.workflow_coordinator_local')}`
                      : ''}
                  {coordinator.execution_device_id ? ` · ${coordinator.execution_device_id}` : ''}
                </span>
                <span className="mt-0.5 block text-xs text-text-muted">
                  {t('todo.workflow_coordinator_last_activity')}:
                  {new Date(coordinator.last_activity_at).toLocaleString()}
                </span>
                {coordinator.error ? (
                  <span className="mt-1 block text-xs text-destructive">{coordinator.error}</span>
                ) : null}
              </span>
              <button
                type="button"
                data-testid="issue-workflow-view-activity"
                disabled={!coordinator.activity_message_id || !onViewActivity}
                onClick={() => {
                  if (coordinator.activity_message_id) {
                    onViewActivity?.(coordinator.activity_message_id)
                  }
                }}
                className="inline-flex h-7 shrink-0 items-center gap-1 rounded-lg px-2 text-xs text-text-secondary hover:bg-muted disabled:opacity-40"
              >
                <ExternalLink className="h-3.5 w-3.5" />
                {t('todo.workflow_coordinator_view_activity')}
              </button>
            </div>
          </div>
        ) : null}
        {loading ? (
          <div className="flex min-h-24 items-center justify-center text-sm text-text-muted">
            <LoaderCircle className="mr-2 h-4 w-4 animate-spin" />
            {t('todo.workflow_plan_loading')}
          </div>
        ) : plan?.items.length ? (
          <>
            {plan.summary ? (
              <p className="border-b border-border px-4 py-3 text-sm text-text-secondary">
                {plan.summary}
              </p>
            ) : null}
            <div className="divide-y divide-border">
              {plan.items.map((planItem, index) => {
                const content = (
                  <>
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-muted text-xs text-text-muted">
                      {index + 1}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium text-text-primary">
                        {planItem.title}
                      </span>
                      {planItem.description ? (
                        <span className="mt-1 block text-xs text-text-secondary">
                          {planItem.description}
                        </span>
                      ) : null}
                      <span className="mt-1 block text-xs text-text-muted">
                        {planItem.assignee_name || t('todo.workflow_plan_assignee_required')}
                        {planItem.task_status
                          ? ` · ${taskStatusText[planItem.task_status] ?? planItem.task_status}`
                          : planItem.rationale
                            ? ` · ${planItem.rationale}`
                            : ''}
                      </span>
                    </span>
                    {planItem.task_id ? (
                      onOpenTask ? (
                        <span className="shrink-0 text-xs font-medium text-text-secondary">
                          {t('todo.workflow_plan_view_execution')}
                        </span>
                      ) : (
                        <Check className="h-4 w-4 shrink-0 text-green-600" />
                      )
                    ) : null}
                  </>
                )
                return planItem.task_id && onOpenTask ? (
                  <button
                    key={planItem.id}
                    type="button"
                    data-testid={`issue-workflow-plan-item-${planItem.id}`}
                    onClick={() => onOpenTask(planItem.task_id!)}
                    className="flex w-full gap-3 px-4 py-3 text-left transition hover:bg-muted"
                  >
                    {content}
                  </button>
                ) : (
                  <div
                    key={planItem.id}
                    data-testid={`issue-workflow-plan-item-${planItem.id}`}
                    className="flex gap-3 px-4 py-3"
                  >
                    {content}
                  </div>
                )
              })}
            </div>
            {status === 'awaiting_approval' ? (
              <div className="flex justify-end border-t border-border px-4 py-3">
                <button
                  type="button"
                  data-testid="issue-workflow-plan-approve"
                  disabled={busy || plan.items.some(planItem => !planItem.assignee_id)}
                  onClick={() => void act(() => api.approveWorkflowPlan(item.id))}
                  className="h-8 rounded-lg bg-text-primary px-3.5 text-sm font-medium text-background disabled:opacity-50"
                >
                  {t('todo.workflow_plan_approve')}
                </button>
              </div>
            ) : null}
          </>
        ) : (
          <p className="px-4 py-5 text-center text-sm text-text-muted">
            {status === 'planning'
              ? t('todo.workflow_plan_generating')
              : t('todo.workflow_plan_empty')}
          </p>
        )}
      </div>
      {error ? (
        <p className="mt-2 text-xs text-destructive" data-testid="issue-workflow-plan-error">
          {error}
        </p>
      ) : null}
    </section>
  )
}
