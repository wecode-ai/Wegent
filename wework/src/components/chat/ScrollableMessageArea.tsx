import {
  ScrollableMessageArea as SharedScrollableMessageArea,
  type ScrollableMessageAreaProps,
} from '@wegent/collaboration/conversation'
import { useDeferredValue, useEffect, useMemo, useState } from 'react'
import type {
  RuntimeTranscriptSearchMatch,
  RuntimeTranscriptSearchResponse,
} from '@wegent/chat-core/runtime'
import type {
  RuntimeConversationTurn,
  WorkbenchMessage,
} from '@wegent/chat-core/runtime-conversation'
import { DesktopToolServices } from './DesktopToolServices'
import { useTranslation } from '@/hooks/useTranslation'
import { Button } from '@/components/ui/button'
import { ConversationFindBar } from './ConversationFindBar'
import { useConversationFind } from './useConversationFind'
import {
  useDesktopConversationPresentation,
  type DesktopConversationPresentationProp,
} from './useDesktopConversationPresentation'

type SearchableMessageAreaProps = Omit<
  ScrollableMessageAreaProps,
  DesktopConversationPresentationProp
> & {
  workspacePath?: string
  imageTarget?: { deviceId: string; workspacePath: string } | null
  virtualize?: boolean
  transcriptError?: string | null
  onSearchTranscript?: (
    query: string,
    signal: AbortSignal
  ) => Promise<RuntimeTranscriptSearchResponse>
  onEnsureSearchMatch?: (match: RuntimeTranscriptSearchMatch, signal: AbortSignal) => Promise<void>
  searchPage?: {
    messages: WorkbenchMessage[]
    turns: RuntimeConversationTurn[]
    hasMoreBefore?: boolean
    hasMoreAfter?: boolean
    loadingMoreBefore?: boolean
    loadingMoreAfter?: boolean
    loadError?: string | null
  } | null
  onLoadSearchContext?: (direction: 'before' | 'after') => Promise<void>
  onReleaseSearchPage?: () => void
  onRetryTranscript?: () => void
  searchActive?: boolean
}

export function ScrollableMessageArea({
  workspacePath,
  imageTarget,
  virtualize,
  transcriptError,
  onSearchTranscript,
  onEnsureSearchMatch,
  searchPage,
  onLoadSearchContext,
  onReleaseSearchPage,
  onRetryTranscript,
  searchActive = false,
  ...props
}: SearchableMessageAreaProps) {
  const { t } = useTranslation('chat')
  const { t: commonT } = useTranslation('common')
  const [browsing, setBrowsing] = useState<{ query: string; selection: object } | null>(null)
  const find = useConversationFind(
    {
      ...props,
      searchMessages: searchPage?.messages,
      transcriptError,
      onSearchTranscript,
      onEnsureSearchMatch,
    },
    searchActive
  )
  useEffect(() => {
    if (!find.open || find.queryPending || !find.query.trim()) onReleaseSearchPage?.()
  }, [find.open, find.queryPending, find.query, onReleaseSearchPage])
  const searchTarget = useDeferredValue(find.searchTarget)
  const visibleSearchPage = find.open && searchTarget?.source === 'page' ? searchPage : null
  const browsingContext =
    browsing?.selection === find.navigationRequest && browsing?.query === find.query
  const loadSearchContext = (direction: 'before' | 'after') => {
    setBrowsing({ query: find.query, selection: find.navigationRequest })
    // The hook preserves the page and exposes a retryable load error.
    void onLoadSearchContext?.(direction).catch(() => {})
  }
  const presentation = useDesktopConversationPresentation(
    visibleSearchPage?.messages ?? props.messages,
    workspacePath
  )
  const historyError = useMemo(
    () =>
      visibleSearchPage ? (
        visibleSearchPage.loadError ? (
          <p role="alert" className="px-6 py-4 text-center text-sm text-text-secondary">
            {t('history.load_failed')}
          </p>
        ) : undefined
      ) : transcriptError ? (
        <div
          role="alert"
          data-testid="runtime-transcript-error"
          className="mx-auto flex max-w-3xl items-start gap-3 px-6 py-8 text-sm"
        >
          <div className="min-w-0 flex-1">
            <p className="font-medium">{t('history.load_failed')}</p>
            <p className="mt-1 break-words text-xs text-text-secondary">{transcriptError}</p>
          </div>
          <Button
            variant="outline"
            size="sm"
            data-testid="runtime-transcript-retry"
            onClick={onRetryTranscript}
            disabled={!onRetryTranscript || props.loading}
          >
            {t('history.retry')}
          </Button>
        </div>
      ) : (
        props.historyError
      ),
    [visibleSearchPage, transcriptError, onRetryTranscript, props.loading, props.historyError, t]
  )
  return (
    <DesktopToolServices imageTarget={imageTarget}>
      <SharedScrollableMessageArea
        {...props}
        {...presentation}
        messages={visibleSearchPage?.messages ?? props.messages}
        turns={visibleSearchPage?.turns ?? props.turns}
        conversationKey={
          visibleSearchPage ? `${props.conversationKey ?? ''}:find` : props.conversationKey
        }
        hasMoreBefore={visibleSearchPage ? visibleSearchPage.hasMoreBefore : props.hasMoreBefore}
        loadingMoreBefore={
          visibleSearchPage
            ? visibleSearchPage.loadingMoreBefore || visibleSearchPage.loadingMoreAfter
            : props.loadingMoreBefore
        }
        onLoadMoreBefore={
          visibleSearchPage
            ? onLoadSearchContext && (() => loadSearchContext('before'))
            : props.onLoadMoreBefore
        }
        contentFooter={
          visibleSearchPage ? (
            visibleSearchPage.hasMoreAfter ? (
              <div className="flex justify-center px-4 py-4">
                <Button
                  variant="outline"
                  data-testid="load-newer-runtime-transcript-button"
                  className="min-h-11 text-xs"
                  disabled={
                    visibleSearchPage.loadingMoreBefore ||
                    visibleSearchPage.loadingMoreAfter ||
                    !onLoadSearchContext
                  }
                  onClick={() => loadSearchContext('after')}
                >
                  {visibleSearchPage.loadingMoreAfter
                    ? commonT('workbench.loading_older_messages')
                    : commonT('workbench.load_newer_messages')}
                </Button>
              </div>
            ) : null
          ) : (
            props.contentFooter
          )
        }
        loadedTranscriptRanges={visibleSearchPage ? undefined : props.loadedTranscriptRanges}
        turnNavigation={visibleSearchPage ? [] : props.turnNavigation}
        searchTarget={searchTarget}
        onSearchNavigationFailure={find.reportNavigationFailure}
        searchNavigationPaused={
          find.queryPending || searchTarget !== find.searchTarget || !find.open || browsingContext
        }
        autoScrollSuspended={props.autoScrollSuspended || find.open || searchTarget !== null}
        historyError={historyError}
        virtualize={virtualize ?? presentation.virtualize}
      />
      <ConversationFindBar find={find} />
    </DesktopToolServices>
  )
}
