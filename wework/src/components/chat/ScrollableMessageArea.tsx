import {
  ScrollableMessageArea as SharedScrollableMessageArea,
  type ScrollableMessageAreaProps,
} from '@wegent/collaboration/conversation'
import { useDeferredValue, useMemo } from 'react'
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
  onRetryTranscript?: () => void
  searchActive?: boolean
}

export function ScrollableMessageArea({
  workspacePath,
  imageTarget,
  virtualize,
  transcriptError,
  onRetryTranscript,
  searchActive = false,
  ...props
}: SearchableMessageAreaProps) {
  const { t } = useTranslation('chat')
  const presentation = useDesktopConversationPresentation(props.messages, workspacePath)
  const find = useConversationFind({ ...props, transcriptError }, searchActive)
  const searchTarget = useDeferredValue(find.searchTarget)
  const historyError = useMemo(
    () =>
      transcriptError ? (
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
    [transcriptError, onRetryTranscript, props.loading, props.historyError, t]
  )
  return (
    <DesktopToolServices imageTarget={imageTarget}>
      <SharedScrollableMessageArea
        {...props}
        {...presentation}
        searchTarget={searchTarget}
        searchNavigationPaused={
          find.queryPending || searchTarget !== find.searchTarget || !find.open
        }
        autoScrollSuspended={props.autoScrollSuspended || find.open || searchTarget !== null}
        historyError={historyError}
        virtualize={virtualize ?? presentation.virtualize}
      />
      <ConversationFindBar find={find} onRetryTranscript={onRetryTranscript} />
    </DesktopToolServices>
  )
}
