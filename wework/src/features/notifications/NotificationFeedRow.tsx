import { formatNotificationTime } from './notificationTime'
import type { ReactNode } from 'react'
import { AtSign, Bell, Bot, ClipboardCheck, type LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
const KIND_ICONS: Record<string, LucideIcon> = {
  mention: AtSign,
  assignment: ClipboardCheck,
  execution: Bot,
}

export function NotificationFeedRow({
  testId,
  kind,
  title,
  body,
  summary,
  replyPreview,
  timestamp,
  unread,
  unreadLabel,
  busy,
  onClick,
  processing,
}: {
  processing?: ReactNode
  testId: string
  /** Names the notification's glyph; a source without kinds shows none. */
  kind?: string
  title: string
  body: string
  /** The board, item and state the notification points at. */
  summary?: string
  /** The comment this notification answered, when it answered one. */
  replyPreview?: string
  timestamp: number
  unread: boolean
  unreadLabel: string
  busy: boolean
  onClick: () => void
}) {
  const time = formatNotificationTime(timestamp)
  const KindIcon = kind ? (KIND_ICONS[kind] ?? Bell) : null
  return (
    <div className="border-b border-border/60 last:border-b-0">
      <button
        type="button"
        data-testid={testId}
        data-unread={unread ? 'true' : undefined}
        disabled={busy}
        className={cn(
          'block min-h-16 w-full px-3 py-3 text-left hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-50'
        )}
        onClick={onClick}
      >
        <span className="grid grid-cols-[6px_minmax(0,1fr)_auto] items-center gap-x-1.5">
          <span
            aria-hidden="true"
            className={cn('h-1.5 w-1.5 rounded-full', unread && 'bg-text-primary')}
          />
          <span className="flex min-w-0 items-center gap-1.5 text-sm font-medium">
            {unread && <span className="sr-only">{unreadLabel}：</span>}
            {KindIcon && (
              <KindIcon aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-text-tertiary" />
            )}
            <span className="truncate">{title}</span>
          </span>
          {time && (
            <time
              className="text-xs text-text-tertiary"
              dateTime={new Date(timestamp).toISOString()}
            >
              {time}
            </time>
          )}
        </span>
        {summary && (
          <span
            data-testid={`${testId}-summary`}
            className="ml-3 mt-0.5 block truncate text-xs text-text-secondary"
          >
            {summary}
          </span>
        )}
        {body && (
          <span
            data-testid={`${testId}-body`}
            className="ml-3 mt-0.5 line-clamp-2 whitespace-pre-wrap text-xs text-text-secondary"
            title={body}
          >
            {body}
          </span>
        )}
        {replyPreview && (
          <span
            data-testid={`${testId}-reply`}
            className="ml-3 mt-1 block border-l-2 border-border pl-2 text-xs text-text-secondary"
          >
            {replyPreview}
          </span>
        )}
      </button>
      {processing && <div className="mb-3 ml-6 mr-3">{processing}</div>}
    </div>
  )
}
