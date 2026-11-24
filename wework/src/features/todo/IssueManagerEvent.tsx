import type { ProjectChatMessage } from '@/api/backend/projectChatSocket'
import type { CloudLoopItem } from '@/api/deliveries'
import { useTranslation } from '@/hooks/useTranslation'
import {
  createCollaborationTranslator,
  executionDisplayStatus,
  formatIssueTimestamp,
  issueActivityTimestamp,
  managerActivityPresentation,
} from '@wegent/collaboration'
import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import { LoaderCircle } from 'lucide-react'
import { resolveMessageRunStatus } from './taskActivityMessageUtils'

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
  const status = resolveMessageRunStatus(task.ai_state, message)
  const presentation = managerActivityPresentation(
    t,
    message.metadata,
    executionDisplayStatus(status) ?? 'unknown'
  )
  const timestamp = issueActivityTimestamp(message)
  return (
    <div
      data-testid={`cloud-task-manager-event-${message.messageId}`}
      className="flex gap-3 px-3 py-3"
    >
      {presentation.planning ? (
        <LoaderCircle
          aria-hidden="true"
          className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-text-muted"
        />
      ) : (
        <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-text-muted" />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm">
          <div className="min-w-0 flex-1">
            <span className="font-medium">{message.sender.name}</span> {presentation.label}
          </div>
          <time dateTime={timestamp} className="shrink-0 whitespace-nowrap text-xs text-text-muted">
            {formatIssueTimestamp(timestamp)}
          </time>
          {onOpenExecution || onCancel ? (
            <div className="flex shrink-0 items-center gap-3">
              {onOpenExecution ? (
                <ControlButton
                  variant="unstyled"
                  type="button"
                  data-testid={`cloud-task-manager-execution-${message.messageId}`}
                  className="text-xs text-text-muted hover:text-text-primary"
                  onClick={onOpenExecution}
                >
                  {t('activity.task_activity_view_execution')}
                </ControlButton>
              ) : null}
              {onCancel ? (
                <ControlButton
                  variant="unstyled"
                  type="button"
                  data-testid={`cloud-task-manager-cancel-${message.messageId}`}
                  disabled={cancelling}
                  className="text-xs text-text-muted hover:text-destructive disabled:cursor-not-allowed disabled:opacity-45 wework:hover:text-red-600"
                  onClick={onCancel}
                >
                  {cancelling
                    ? t('activity.task_activity_stopping_workflow')
                    : t('activity.task_activity_stop_workflow')}
                </ControlButton>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}
