import { LoaderCircle, RotateCcw } from 'lucide-react'
import type { CollaborationTranslate } from '../i18n'
import { Button as ControlButton } from '../markdown/Button'
import { IssueExecutionStatusControl } from './IssueChatMessage'
import { isExecutionFailed } from './executionStatus'

export interface IssueActivityToolsProps {
  task: {
    id: string
    status: string
    execution_state?: string | null
    execution_error?: string | null
    execution_note?: string | null
    ai_state?: { status?: string | null; last_error?: string | null } | null
  }
  assignedAgent?: { createdByUserName?: string | null } | null
  canApprove: boolean
  running: boolean
  translate: CollaborationTranslate
  copyText(text: string): Promise<unknown>
  onApprove?(): void
  onReject?(): void
  onAccept?(): void
  onRun?(): void
}

/** PC activity controls and their visibility rules, shared by both hosts. */
export function IssueActivityTools({
  task,
  assignedAgent,
  canApprove,
  running,
  translate: t,
  copyText,
  onApprove,
  onReject,
  onAccept,
  onRun,
}: IssueActivityToolsProps) {
  const status = task.execution_state ?? task.ai_state?.status
  const awaitingApproval = task.execution_state === 'waiting_approval'
  const review = task.status === 'in_review' || ['completed', 'succeeded'].includes(status ?? '')
  const rerun =
    assignedAgent && onRun ? (
      <ControlButton
        variant="unstyled"
        type="button"
        data-testid={`cloud-task-activity-rerun-${task.id}`}
        title={t('workbench.task_activity_rerun')}
        disabled={running}
        onClick={onRun}
        className="task-detail-activity-icon-button"
      >
        <RotateCcw className="h-4 w-4" />
        <span className="sr-only">{t('workbench.task_activity_rerun')}</span>
      </ControlButton>
    ) : null
  return (
    <>
      {awaitingApproval && canApprove && onApprove && onReject ? (
        <div
          data-testid={`cloud-task-activity-approval-${task.id}`}
          className="flex items-center gap-1.5"
        >
          <ControlButton
            variant="unstyled"
            type="button"
            data-testid={`cloud-task-activity-reject-${task.id}`}
            disabled={running}
            onClick={onReject}
            className="max-md:min-h-11 max-md:min-w-11 rounded-lg px-2.5 py-1.5 text-xs font-medium text-text-secondary transition hover:bg-muted hover:text-red-600"
          >
            {t('workbench.task_activity_reject')}
          </ControlButton>
          <ControlButton
            variant="primary"
            size="sm"
            type="button"
            data-testid={`cloud-task-activity-approve-${task.id}`}
            disabled={running}
            onClick={onApprove}
            className="max-md:min-h-11 max-md:min-w-11 rounded-lg bg-text-primary px-3 py-1.5 text-xs font-medium text-background"
          >
            {t('workbench.task_activity_approve')}
          </ControlButton>
        </div>
      ) : null}
      {status ? (
        <IssueExecutionStatusControl
          taskId={task.id}
          status={status}
          error={task.execution_error ?? task.ai_state?.last_error}
          note={task.execution_note}
          translate={t}
          copyText={copyText}
          approvalLabel={
            awaitingApproval && !canApprove
              ? assignedAgent?.createdByUserName
                ? t('workbench.task_activity_awaiting_approval_with_creator', undefined, {
                    name: assignedAgent.createdByUserName,
                  })
                : t('workbench.task_activity_awaiting_approval')
              : undefined
          }
        />
      ) : null}
      {assignedAgent &&
      onRun &&
      ['queued', 'starting', 'waiting_runtime'].includes(task.execution_state ?? '') &&
      task.status !== 'in_review' ? (
        <ControlButton
          variant="unstyled"
          type="button"
          data-testid={`cloud-task-activity-run-now-${task.id}`}
          title={t('workbench.task_activity_run_now')}
          disabled={running}
          onClick={onRun}
          className="task-detail-activity-icon-button"
        >
          <LoaderCircle className="h-4 w-4" />
          <span className="sr-only">{t('workbench.task_activity_run_now')}</span>
        </ControlButton>
      ) : null}
      {review ? (
        <div
          data-testid={`cloud-task-activity-review-actions-${task.id}`}
          className="flex items-center gap-1.5"
        >
          {rerun}
          {onAccept && task.status !== 'completed' ? (
            <ControlButton
              variant="primary"
              size="sm"
              type="button"
              data-testid={`cloud-task-activity-accept-${task.id}`}
              title={t('workbench.task_activity_accept_hint')}
              disabled={running}
              onClick={onAccept}
              className="max-md:min-h-11 max-md:min-w-11 rounded-lg bg-text-primary px-3 py-1.5 text-xs font-medium text-background"
            >
              {t('workbench.task_activity_accept')}
            </ControlButton>
          ) : null}
        </div>
      ) : assignedAgent && isExecutionFailed(status) ? (
        rerun
      ) : null}
    </>
  )
}
