import { Bot, Reply } from 'lucide-react'
import { formatIssueTimestamp } from '@wegent/collaboration'
import { AssistantMarkdown } from '@wegent/collaboration/markdown'
import type { ProjectChatMessage } from '@wegent/chat-core'
import { useTranslation } from '@/hooks/useTranslation'
import { createGroupReplyTarget, type GroupReplyTarget } from './groupReply'

export function GroupChatMessage({
  message,
  currentUserId,
  focused,
  scopeKey,
  replyTo,
  onReply,
}: {
  message: ProjectChatMessage
  currentUserId: string | null | undefined
  focused: boolean
  scopeKey?: string
  replyTo?: GroupReplyTarget | null
  onReply?(message: ProjectChatMessage): void
}) {
  const { t } = useTranslation('collaboration')
  const { t: common } = useTranslation('common')
  const system = message.sender.type === 'system' || message.type === 'system'
  const own = message.sender.type === 'user' && message.sender.id === currentUserId
  const name = message.sender.name || message.sender.id
  const label = own && name !== t('you') ? t('selfMessageSender', { name }) : name
  const canReply = Boolean(onReply && createGroupReplyTarget(scopeKey ?? '', message))
  const quote =
    replyTo?.scopeKey === scopeKey && replyTo?.messageId === message.replyToMessageId
      ? replyTo
      : null
  return (
    <article
      data-testid={`group-message-${message.messageId}`}
      data-message-id={message.messageId}
      data-reply-to-message-id={message.replyToMessageId ?? undefined}
      data-focused={focused || undefined}
      data-flash={focused || undefined}
      data-message-side={system ? 'system' : own ? 'self' : 'other'}
      className={
        system
          ? 'mx-auto max-w-xl py-2 text-center text-xs text-text-muted'
          : `group/message flex w-full items-start gap-3 ${own ? 'flex-row-reverse' : ''}`
      }
    >
      {system ? (
        <>
          <AssistantMarkdown content={message.content} />
          <time className="mt-1 block" dateTime={message.createdAt}>
            {formatIssueTimestamp(message.createdAt)}
          </time>
        </>
      ) : (
        <>
          <span
            data-testid={`group-message-avatar-${message.messageId}`}
            aria-hidden="true"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-border bg-hover text-sm font-medium text-text-secondary"
          >
            {message.sender.type === 'agent' ? (
              <Bot className="h-4 w-4" />
            ) : (
              Array.from(name.trim())[0]?.toLocaleUpperCase()
            )}
          </span>
          <div className="min-w-0 max-w-[85%]">
            <div
              className={`mb-1 flex flex-wrap items-baseline gap-x-2 gap-y-1 text-xs text-text-muted ${own ? 'flex-row-reverse' : ''}`}
            >
              <span className="break-all font-medium text-text-secondary">{label}</span>
              <time dateTime={message.createdAt}>{formatIssueTimestamp(message.createdAt)}</time>
              {canReply && (
                <button
                  type="button"
                  data-testid={`group-message-reply-${message.messageId}`}
                  aria-label={common('interactions.reply')}
                  title={common('interactions.reply')}
                  onClick={() => onReply?.(message)}
                  className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded text-text-muted opacity-100 transition-opacity hover:bg-hover hover:text-text-primary focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus max-md:h-11 max-md:w-11 md:opacity-0 md:group-hover/message:opacity-100 md:group-focus-within/message:opacity-100"
                >
                  <Reply className="h-4 w-4" />
                </button>
              )}
            </div>
            <div
              data-testid={`group-message-bubble-${message.messageId}`}
              className={`min-w-0 overflow-hidden rounded-xl border px-4 py-3 text-chat text-text-primary ${own ? 'border-transparent bg-hover' : 'border-border bg-background'}`}
            >
              {message.replyToMessageId && (
                <blockquote
                  data-testid={`group-message-quoted-${message.messageId}`}
                  className="mb-2 border-l-2 border-border pl-3 text-xs text-text-muted"
                >
                  {quote ? (
                    <>
                      <span className="block truncate font-medium">{quote.senderName}</span>
                      <span className="line-clamp-2 whitespace-pre-wrap break-words">
                        {quote.content}
                      </span>
                    </>
                  ) : (
                    t('messageUnavailable')
                  )}
                </blockquote>
              )}
              <div data-testid={`group-message-content-${message.messageId}`}>
                <AssistantMarkdown content={message.content} />
              </div>
            </div>
          </div>
        </>
      )}
    </article>
  )
}
