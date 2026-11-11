import { Bot } from 'lucide-react'
import { formatIssueTimestamp } from '@wegent/collaboration'
import { AssistantMarkdown } from '@wegent/collaboration/markdown'
import type { ProjectChatMessage } from '@wegent/chat-core'
import { useTranslation } from '@/hooks/useTranslation'

export function GroupChatMessage({
  message,
  currentUserId,
  focused,
}: {
  message: ProjectChatMessage
  currentUserId: string | null | undefined
  focused: boolean
}) {
  const { t } = useTranslation('collaboration')
  const system = message.sender.type === 'system' || message.type === 'system'
  const own = message.sender.type === 'user' && message.sender.id === currentUserId
  const name = message.sender.name || message.sender.id
  const label = own && name !== t('you') ? t('selfMessageSender', { name }) : name
  return (
    <article
      data-testid={`group-message-${message.messageId}`}
      data-message-id={message.messageId}
      data-focused={focused || undefined}
      data-flash={focused || undefined}
      data-message-side={system ? 'system' : own ? 'self' : 'other'}
      className={
        system
          ? 'mx-auto max-w-xl py-2 text-center text-xs text-text-muted'
          : `flex w-full items-start gap-3 ${own ? 'flex-row-reverse' : ''}`
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
            </div>
            <div
              className={`min-w-0 overflow-hidden rounded-xl border px-4 py-3 text-chat text-text-primary ${own ? 'border-transparent bg-hover' : 'border-border bg-background'}`}
            >
              <AssistantMarkdown content={message.content} />
            </div>
          </div>
        </>
      )}
    </article>
  )
}
