import { formatNotificationTime } from './notificationTime'
import type { ReactNode } from 'react'
import { AtSign, Bell, Bot, ClipboardCheck, type LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

const KIND_ICONS: Record<string, LucideIcon> = {
  mention: AtSign,
  assignment: ClipboardCheck,
  issue_dispatch_assignment: ClipboardCheck,
  execution: Bot,
}

export interface NotificationFeedRowProps {
  processing?: ReactNode
  event?: ReactNode
  avatarLabel?: string
  badge?: ReactNode
  testId: string
  kind?: string
  title: string
  body: string
  summary?: string
  replyPreview?: string
  timestamp: number
  unread: boolean
  unreadLabel: string
  busy: boolean
  onClick: () => void
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
  event,
  avatarLabel,
  badge,
}: NotificationFeedRowProps) {
  const time = formatNotificationTime(timestamp)
  const KindIcon = KIND_ICONS[kind ?? ''] ?? Bell
  const taskOnly = kind === 'issue_dispatch_assignment' && !avatarLabel
  const timeLabel = time ? (
    <time
      className="shrink-0 text-xs text-text-secondary"
      dateTime={new Date(timestamp).toISOString()}
    >
      {time}
    </time>
  ) : null
  return (
    <div
      data-testid={`${testId}-container`}
      className={cn(
        'relative isolate flex gap-3 border-b border-border px-4 py-3 hover:bg-muted/40',
        unread && 'bg-muted/30'
      )}
    >
      <span
        aria-hidden="true"
        className="relative mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted text-sm text-text-secondary"
      >
        {avatarLabel ? Array.from(avatarLabel)[0] : <KindIcon className="h-4 w-4" />}
        {unread && (
          <span className="absolute -left-2 top-3.5 h-1 w-1 rounded-full bg-text-primary" />
        )}
      </span>
      <div className="min-w-0 flex-1">
        <button
          type="button"
          data-testid={testId}
          data-unread={unread ? 'true' : undefined}
          disabled={busy}
          className="block min-h-11 w-full text-left after:absolute after:inset-0 after:z-0 after:content-[''] focus-visible:outline-none keyboard:focus-visible:after:ring-2 keyboard:focus-visible:after:ring-inset keyboard:focus-visible:after:ring-focus disabled:opacity-50 md:min-h-6"
          onClick={onClick}
        >
          <span className="flex items-baseline justify-between gap-3">
            <span
              className={cn(
                'min-w-0 text-sm',
                taskOnly ? 'line-clamp-2 whitespace-normal font-normal' : 'truncate font-medium'
              )}
            >
              {unread && <span className="sr-only">{unreadLabel}：</span>}
              {title}
            </span>
            {badge}
            {!event && !taskOnly && timeLabel}
          </span>
          {(event || (taskOnly && time)) && (
            <span className="mt-0.5 flex items-center gap-2 text-xs text-text-secondary">
              {event}
              {event && time && <span aria-hidden="true">·</span>}
              {timeLabel}
            </span>
          )}
          {body && (
            <span
              data-testid={`${testId}-body`}
              className="mt-2 block line-clamp-2 whitespace-pre-wrap text-sm text-text-primary"
              title={body}
            >
              {body}
            </span>
          )}
          {summary && (
            <span
              data-testid={`${testId}-summary`}
              className="mt-1 block truncate text-xs text-text-secondary"
              title={summary}
            >
              {summary}
            </span>
          )}
          {replyPreview && (
            <span
              data-testid={`${testId}-reply`}
              className="mt-1 block border-l-2 border-border pl-2 text-xs text-text-secondary"
            >
              {replyPreview}
            </span>
          )}
        </button>
        {processing && (
          <div className="pointer-events-none relative z-10 mt-2 [&_:is(button,input,textarea,select,a,label,[role=button],[role=checkbox],[role=radio])]:pointer-events-auto">
            {processing}
          </div>
        )}
      </div>
    </div>
  )
}
