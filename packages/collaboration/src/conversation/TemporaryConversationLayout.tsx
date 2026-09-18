import type { ReactNode } from 'react'
import { ChevronRight, MessageCircle } from 'lucide-react'
import type { CollaborationTranslate } from '../i18n'
import { activityClassNames as cn } from '../issue-detail/activityClassNames'
import { DESKTOP_CHAT_CONTENT_WIDTH_CLASS } from './conversationLayout'

/** Native side-conversation layout. Hosts supply the shared message and composer adapters. */
export function TemporaryConversationLayout({
  testId = 'right-workspace-chat-panel',
  emptyStateText,
  messageCount,
  expanded = false,
  wideComposer = false,
  onRestoreConversation,
  translate: t,
  children,
  composer,
}: {
  testId?: string
  emptyStateText: string
  messageCount: number
  expanded?: boolean
  wideComposer?: boolean
  onRestoreConversation?(): void
  translate: CollaborationTranslate
  children: ReactNode
  composer: ReactNode
}) {
  return (
    <section data-testid={testId} className="flex min-h-0 min-w-0 flex-1 flex-col">
      {messageCount > 0 ? (
        children
      ) : (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-8 text-center text-sm text-text-muted">
          <MessageCircle className="h-5 w-5 text-text-secondary" />
          <p>{emptyStateText}</p>
        </div>
      )}
      <div
        data-testid="right-workspace-chat-composer-shell"
        className={cn(
          'shrink-0',
          expanded
            ? cn(
                'relative z-critical mx-auto max-w-[calc(100%_-_2rem)] bg-transparent pb-2 pt-6',
                wideComposer
                  ? 'w-[min(68rem,calc(100%_-_2rem))]'
                  : 'w-[min(46rem,calc(100%_-_2rem))]'
              )
            : 'bg-background py-3'
        )}
      >
        {expanded && onRestoreConversation ? (
          <button
            type="button"
            data-testid="restore-conversation-from-expanded-workspace-button"
            className="mb-1 flex h-8 w-full items-center justify-between rounded-xl border border-border/45 bg-background/95 px-4 text-xs text-text-secondary shadow-sm hover:bg-muted hover:text-text-primary"
            onClick={onRestoreConversation}
          >
            <span>{t('workbench.latest_conversation_turn')}</span>
            <ChevronRight className="h-4 w-4" aria-hidden="true" />
          </button>
        ) : null}
        <div
          data-testid="side-chat-composer-layout"
          className={cn('pointer-events-auto', !expanded && DESKTOP_CHAT_CONTENT_WIDTH_CLASS)}
        >
          {composer}
        </div>
      </div>
    </section>
  )
}
