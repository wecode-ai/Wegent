import { createCollaborationTranslator, formatIssueTimestamp } from '@wegent/collaboration'
import type { ProjectChatMessage } from '@/api/backend/projectChatSocket'
import type { CloudLoopItem } from '@/api/deliveries'
import { LoaderCircle } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { resolveMessageRunStatus } from './taskActivityMessageUtils'
import { issueActivityRole } from './issueActivityRole'

export function IssueManagerEvent({
  message,
  task,
  onOpenExecution,
  onCancel,
  cancelling = false,
}: {
  message: ProjectChatMessage
  task: CloudLoopItem
  onOpenExecution?: () => void
  onCancel?: () => void
  cancelling?: boolean
}) {
  const { i18n } = useTranslation('common')
  const t = createCollaborationTranslator(i18n.language.startsWith('zh') ? 'zh-CN' : 'en')
  const assignments = Array.isArray(message.metadata.workflow_assignments)
    ? (message.metadata.workflow_assignments as { assignee_id?: string; assignee_name?: string }[])
    : []
  const assigned = message.metadata.workflow_plan_submitted === true || assignments.length > 0
  const decision = message.metadata.workflow_review_decision
  const status = resolveMessageRunStatus(task.ai_state, message)
  const failed = Boolean(message.metadata.manager_action_error) || status === 'failed'
  const completed = status === 'completed' || status === 'succeeded'
  const recipients = [
    ...new Set(assignments.map(item => item.assignee_name || item.assignee_id).filter(Boolean)),
  ].join('、')
  const action = failed
    ? 'failed'
    : decision === 'completed'
      ? 'completed'
      : decision === 'needs_rework'
        ? 'rework'
        : decision === 'in_review'
          ? 'confirmation'
          : assigned
            ? 'assigned'
            : issueActivityRole(message) === 'manager_review'
              ? 'reviewing'
              : completed
                ? 'planned'
                : 'planning'
  return (
    <div
      data-testid={`cloud-task-${assigned ? 'assignment' : 'manager'}-event-${message.messageId}`}
      className="flex gap-3 px-3 py-3"
    >
      {action === 'planning' || action === 'reviewing' ? (
        <LoaderCircle
          aria-hidden="true"
          className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-text-muted"
        />
      ) : (
        <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-text-muted" />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-start gap-2 text-sm">
          <div className="min-w-0 flex-1">
            <span className="font-medium">{message.sender.name}</span>{' '}
            <span className="text-xs text-text-muted">
              {t('activity.task_activity_manager_role')}
            </span>
            {' · '}
            {assigned && recipients
              ? t('activity.task_activity_manager_assigned_to', undefined, { name: recipients })
              : t(`activity.task_activity_manager_${action}`)}
          </div>
          {onOpenExecution || onCancel ? (
            <div className="flex shrink-0 items-center gap-3">
              {onOpenExecution ? (
                <button
                  type="button"
                  data-testid={`cloud-task-manager-execution-${message.messageId}`}
                  className="text-xs text-text-muted hover:text-text-primary"
                  onClick={onOpenExecution}
                >
                  {t('activity.task_activity_view_execution')}
                </button>
              ) : null}
              {onCancel ? (
                <button
                  type="button"
                  data-testid={`cloud-task-manager-cancel-${message.messageId}`}
                  disabled={cancelling}
                  className="text-xs text-text-muted hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-45"
                  onClick={onCancel}
                >
                  {cancelling
                    ? t('activity.task_activity_stopping_workflow')
                    : t('activity.task_activity_stop_workflow')}
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
        <time dateTime={message.createdAt} className="text-xs text-text-muted">
          {formatIssueTimestamp(message.createdAt)}
        </time>
      </div>
    </div>
  )
}
