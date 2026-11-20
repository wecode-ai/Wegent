import type { ReactNode } from 'react'
import { formatIssueTimestamp } from '@wegent/collaboration'

export function IssueTimelineActions({
  rootId,
  createdAt,
  replyLabel,
  active,
  onReply,
  children,
}: {
  rootId: string
  createdAt?: string
  replyLabel: string
  active: boolean
  onReply: () => void
  children?: ReactNode
}) {
  return (
    <div className="task-detail-thread-actions">
      {createdAt && (
        <time dateTime={createdAt} className="text-xs text-text-secondary">
          {formatIssueTimestamp(createdAt)}
        </time>
      )}
      {children}
      <button
        type="button"
        data-testid={`cloud-task-activity-reply-toggle-${rootId}`}
        aria-expanded={active}
        aria-controls="issue-reply-composer"
        onClick={onReply}
      >
        {replyLabel}
      </button>
    </div>
  )
}
