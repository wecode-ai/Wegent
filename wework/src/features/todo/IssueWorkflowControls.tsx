import { ExternalLink, Sparkles } from 'lucide-react'
import type { IssueWorkflowInstance } from '@/api/deliveries'
import { useTranslation } from '@/hooks/useTranslation'

export type WorkflowPlanAction = 'pauseWorkflowPlan' | 'resumeWorkflowPlan' | 'replanWorkflowPlan'

interface Props {
  workflow: IssueWorkflowInstance
  status: NonNullable<IssueWorkflowInstance['orchestration_status']>
  statusLabel: string
  busy: boolean
  canAction: (action: WorkflowPlanAction) => boolean
  onAction: (action: WorkflowPlanAction) => Promise<void>
  onOpenExecution: (() => void) | null
}

export function IssueWorkflowControls({
  workflow,
  status,
  statusLabel,
  busy,
  canAction,
  onAction,
  onOpenExecution,
}: Props) {
  const { t } = useTranslation()
  return (
    <div className="mb-3">
      <div
        className="flex flex-wrap items-center gap-2 text-sm"
        data-testid="cloud-todo-workflow-plan"
      >
        <Sparkles className="h-4 w-4" />
        <span data-testid="cloud-todo-workflow-plan-status">{statusLabel}</span>
        {onOpenExecution ? (
          <button
            type="button"
            data-testid="cloud-todo-workflow-manager-run"
            onClick={onOpenExecution}
            className="ml-auto flex min-h-11 items-center gap-1 rounded-md px-2 hover:bg-muted md:min-h-7"
          >
            <ExternalLink className="h-4 w-4" />
            {t('workbench.task_activity_view_execution')}
          </button>
        ) : null}
        {!workflow.migration_required && ['failed', 'paused'].includes(status) ? (
          <button
            type="button"
            data-testid={
              status === 'paused' ? 'cloud-todo-workflow-resume' : 'cloud-todo-workflow-replan'
            }
            className="min-h-11 rounded-md px-3 hover:bg-muted md:min-h-7"
            disabled={
              busy || !canAction(status === 'paused' ? 'resumeWorkflowPlan' : 'replanWorkflowPlan')
            }
            onClick={() =>
              void onAction(status === 'paused' ? 'resumeWorkflowPlan' : 'replanWorkflowPlan')
            }
          >
            {t(status === 'paused' ? 'todo.workflow_plan_resume' : 'todo.workflow_plan_retry')}
          </button>
        ) : null}
        {!workflow.migration_required &&
        workflow.advancement_policy === 'ai' &&
        ['planning', 'dispatching', 'running', 'waiting_human'].includes(status) ? (
          <button
            type="button"
            data-testid="cloud-todo-workflow-pause"
            className="min-h-11 rounded-md px-3 hover:bg-muted md:min-h-7"
            disabled={busy || !canAction('pauseWorkflowPlan')}
            onClick={() => void onAction('pauseWorkflowPlan')}
          >
            {t('todo.workflow_plan_pause')}
          </button>
        ) : null}
      </div>
      {status === 'paused' ? (
        <p data-testid="cloud-todo-workflow-paused-hint" className="mt-1 text-sm text-text-muted">
          {t('todo.workflow_plan_paused_hint')}
        </p>
      ) : null}
    </div>
  )
}
