import { useTranslation } from '@/hooks/useTranslation'
import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import { X } from 'lucide-react'
import { issueReplyCopy, type IssueReplyContextKind } from './issueReplyCopy'

export function IssueReplyContext({
  kind,
  name,
  content,
  taskTitle,
  onCancel,
}: {
  kind: IssueReplyContextKind
  name: string
  content: string
  taskTitle?: string
  onCancel(): void
}) {
  const { t } = useTranslation('common')
  const label = `${t(issueReplyCopy[kind].label, { name })}${content ? ` · ${content}` : ''}`
  return (
    <div className="task-detail-comment-reply-context mx-3 border-b border-border/60 px-1 text-xs text-text-secondary">
      <div className="task-detail-comment-reply-context-row flex min-h-8 items-center gap-2">
        <span className="min-w-0 flex-1 truncate" title={label}>
          {label}
        </span>
        <ControlButton
          variant="unstyled"
          type="button"
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-text-secondary hover:bg-surface-hover hover:text-text-primary md:h-7 md:w-7"
          data-testid="issue-reply-cancel"
          aria-label={t('workbench.task_activity_cancel_reply')}
          onClick={onCancel}
        >
          <X aria-hidden="true" className="h-4 w-4" />
        </ControlButton>
      </div>
      {taskTitle ? (
        <p className="min-h-6 pb-1.5 leading-5" data-testid="issue-reply-starts-task-hint">
          {t('workbench.task_activity_reply_starts_task', { title: taskTitle })}
        </p>
      ) : null}
    </div>
  )
}
