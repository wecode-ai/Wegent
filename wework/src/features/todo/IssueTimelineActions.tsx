import { formatIssueTimestamp } from '@wegent/collaboration'
import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import type { ReactNode } from 'react'

export function IssueTimelineActions({
  rootId,
  createdAt,
  replyLabel,
  active,
  onReply,
  children,
}: {
  rootId: string
  createdAt: string
  replyLabel: string
  active: boolean
  onReply?: () => void
  children?: ReactNode
}) {
  return (
    <div className="task-detail-thread-actions">
      <time dateTime={createdAt} className="text-xs text-text-secondary">
        {formatIssueTimestamp(createdAt)}
      </time>
      {children}
      {onReply ? (
        <ControlButton
          variant="unstyled"
          type="button"
          data-testid={`cloud-task-activity-reply-toggle-${rootId}`}
          aria-expanded={active}
          aria-controls="issue-reply-composer"
          onClick={onReply}
        >
          {replyLabel}
        </ControlButton>
      ) : null}
    </div>
  )
}
