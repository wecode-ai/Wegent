import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import type { ReactNode } from 'react'

export function IssueTimelineActions({
  rootId,
  replyLabel,
  active,
  onReply,
  children,
}: {
  rootId: string
  replyLabel: string
  active: boolean
  onReply?: () => void
  children?: ReactNode
}) {
  if (!onReply && !children) return null
  return (
    <div className="task-detail-thread-actions">
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
