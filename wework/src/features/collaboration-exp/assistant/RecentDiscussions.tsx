import { MessageCircle } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import type { ExperiencePrivateConversation } from '../model'

export interface RecentDiscussionsProps {
  conversations: readonly ExperiencePrivateConversation[]
  onOpen(conversation: ExperiencePrivateConversation): void
}

export function RecentDiscussions({ conversations, onOpen }: RecentDiscussionsProps) {
  const { t, i18n } = useTranslation('collaborationExp')
  return (
    <section data-testid="collaboration-exp-recent-discussions">
      <h2 className="px-4 py-2 text-sm font-medium text-text-secondary">
        {t('assistant.recentDiscussions')}
      </h2>
      {conversations.length ? (
        conversations.slice(0, 8).map(conversation => (
          <button
            key={conversation.key}
            type="button"
            data-testid={`collaboration-exp-recent-discussion-${encodeURIComponent(conversation.key)}`}
            className="flex min-h-11 w-full items-center gap-3 px-4 py-3 text-left hover:bg-text-primary/[0.025] keyboard:focus-visible:ring-2 keyboard:focus-visible:ring-focus/30"
            onClick={() => onOpen(conversation)}
          >
            <MessageCircle aria-hidden="true" className="size-4 shrink-0 text-text-muted" />
            <span className="min-w-0 flex-1 truncate">
              {conversation.title ?? t('assistant.untitledDiscussion')}
            </span>
            {conversation.linkedAt && Number.isFinite(Date.parse(conversation.linkedAt)) && (
              <time className="shrink-0 text-xs text-text-muted" dateTime={conversation.linkedAt}>
                {new Intl.DateTimeFormat(i18n.language, { month: 'short', day: 'numeric' }).format(
                  new Date(conversation.linkedAt)
                )}
              </time>
            )}
          </button>
        ))
      ) : (
        <p className="px-4 py-3 text-sm text-text-muted">{t('assistant.noDiscussions')}</p>
      )}
    </section>
  )
}
