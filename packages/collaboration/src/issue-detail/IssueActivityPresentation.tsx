import { Bot, type LucideIcon } from 'lucide-react'
import type { HTMLAttributes, ReactNode } from 'react'
import type { CollaborationTranslate } from '../i18n'
import { ComposerSendButton, ComposerSendGroup } from '../composer/ComposerSendButton'
import { activityClassNames as cn } from './activityClassNames'
import { formatIssueTimestamp } from './issueTimestamp'

export function IssueActivityAvatar({
  author,
  agent = false,
  compact = true,
}: {
  author: string
  agent?: boolean
  compact?: boolean
}) {
  return (
    <span
      title={author}
      role={agent ? 'img' : undefined}
      aria-label={agent ? author : undefined}
      className={cn(
        'flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold',
        agent
          ? compact
            ? 'bg-text-primary text-background'
            : 'bg-violet-500/10 text-violet-600'
          : 'bg-muted text-text-secondary'
      )}
    >
      {agent ? <Bot className="h-4 w-4" /> : author.slice(0, 1).toUpperCase()}
    </span>
  )
}

/** Data and execution actions belong to hosts; activity chrome is shared. */
export function IssueActivityCard(props: HTMLAttributes<HTMLElement>) {
  return <article {...props} className="task-detail-comment-card" />
}

export function IssueCreatedActivity({
  author,
  createdAt,
  translate,
}: {
  author: string
  createdAt: string
  translate: CollaborationTranslate
}) {
  return (
    <div data-testid="cloud-task-status-created" className="task-detail-timeline-system-event">
      <span className="task-detail-timeline-marker" aria-hidden="true" />
      <div className="task-detail-timeline-system-content text-xs text-text-primary">
        <span className="font-medium">{author}</span> {translate('activity.issue_created')}
        <time dateTime={createdAt} className="ml-2 text-text-secondary">
          {formatIssueTimestamp(createdAt)}
        </time>
      </div>
    </div>
  )
}

export function IssueActivityMessage({
  author,
  createdAt,
  agent = false,
  avatar,
  metadata,
  trailing,
  hideTime = false,
  children,
  ...attributes
}: HTMLAttributes<HTMLElement> & {
  author: string
  createdAt: string
  agent?: boolean
  avatar?: ReactNode
  metadata?: ReactNode
  trailing?: ReactNode
  hideTime?: boolean
}) {
  return (
    <article {...attributes} className="task-detail-thread-message">
      <header className="task-detail-thread-message-header">
        {avatar ?? <IssueActivityAvatar author={author} agent={agent} />}
        <span className="task-detail-thread-message-identity">
          <span className="task-detail-thread-message-author">{author}</span>
          {metadata ? (
            <span className="task-detail-thread-message-metadata">{metadata}</span>
          ) : null}
        </span>
        {trailing || !hideTime ? (
          <span className="task-detail-thread-message-aside">
            {trailing}
            {hideTime ? null : (
              <time className="task-detail-thread-message-time" dateTime={createdAt}>
                {formatIssueTimestamp(createdAt)}
              </time>
            )}
          </span>
        ) : null}
      </header>
      <div className="task-detail-thread-message-body">{children}</div>
    </article>
  )
}

export function IssueCommentComposer({
  input,
  before,
  after,
  actions,
  canSend,
  onSubmit,
  sendLabel,
  sendTestId,
  sendIcon,
  sendModeSelected,
  pendingActions,
  sendActions,
  workflow = false,
  ...attributes
}: Omit<HTMLAttributes<HTMLFormElement>, 'onSubmit'> & {
  input: ReactNode
  before?: ReactNode
  after?: ReactNode
  actions?: ReactNode
  canSend: boolean
  onSubmit: () => void
  sendLabel: string
  sendTestId: string
  sendIcon?: LucideIcon
  sendModeSelected?: boolean
  pendingActions?: ReactNode
  sendActions?: ReactNode
  workflow?: boolean
}) {
  return (
    <form
      {...attributes}
      className="task-detail-new-comment"
      data-workflow={workflow || undefined}
      onSubmit={event => {
        event.preventDefault()
        if (canSend) onSubmit()
      }}
    >
      <div className="task-detail-comment-body">
        {before}
        {input}
        <div className="task-detail-new-comment-actions">
          {actions}
          {pendingActions}
          <div className="ml-auto flex shrink-0 items-center gap-1">
            {sendActions ? (
              <ComposerSendGroup disabled={!canSend} selected={sendModeSelected}>
                <ComposerSendButton
                  label={sendLabel}
                  testId={sendTestId}
                  disabled={!canSend}
                  icon={sendIcon}
                  split
                />
                {sendActions}
              </ComposerSendGroup>
            ) : (
              <ComposerSendButton
                label={sendLabel}
                testId={sendTestId}
                disabled={!canSend}
                icon={sendIcon}
              />
            )}
          </div>
        </div>
      </div>
      {after}
    </form>
  )
}
