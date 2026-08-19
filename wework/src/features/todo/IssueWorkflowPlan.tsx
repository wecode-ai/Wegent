import { useEffect, useState } from 'react'
import { Check, CirclePause, LoaderCircle, Play, RefreshCw, Sparkles } from 'lucide-react'
import type { CloudLoopItem, WorkflowPlan } from '@/api/deliveries'
import { createDeliveryApi } from '@/api/deliveries'
import { useTranslation } from '@/hooks/useTranslation'

type DeliveryApi = ReturnType<typeof createDeliveryApi>

export function IssueWorkflowPlan({
  api,
  item,
  onUpdated,
}: {
  api: DeliveryApi
  item: CloudLoopItem
  onUpdated: (item: CloudLoopItem) => void
}) {
  const { t } = useTranslation('common')
  const [plan, setPlan] = useState<WorkflowPlan | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    void api
      .getWorkflowPlan(item.id)
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
  }, [api, item.id, item.workflow?.active_run_id, item.workflow?.orchestration_status])

  const act = async (action: () => Promise<WorkflowPlan | null>) => {
    setBusy(true)
    setError('')
    try {
      setPlan(await action())
      onUpdated(await api.getLoopItem(item.id))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const status = item.workflow?.orchestration_status ?? plan?.status ?? 'idle'
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
            disabled={busy || status === 'dispatching'}
            onClick={() => void act(() => api.replanWorkflowPlan(item.id))}
            className="flex h-7 items-center gap-1 rounded-lg px-2 text-xs text-text-secondary hover:bg-muted disabled:opacity-50"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            {t('todo.workflow_plan_replan')}
          </button>
        ) : null}
      </div>

      <div className="mt-2 rounded-xl border border-border">
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
              {plan.items.map((planItem, index) => (
                <div
                  key={planItem.id}
                  data-testid={`issue-workflow-plan-item-${planItem.id}`}
                  className="flex gap-3 px-4 py-3"
                >
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
                      {planItem.rationale ? ` · ${planItem.rationale}` : ''}
                    </span>
                  </span>
                  {planItem.task_id ? <Check className="h-4 w-4 shrink-0 text-green-600" /> : null}
                </div>
              ))}
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
