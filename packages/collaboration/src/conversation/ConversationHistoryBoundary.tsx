import { useIntersectionEvent } from '../dom-events'
import { useCallback, useRef, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'

import { useConversationTranslation } from './ConversationTranslation'
import { CompositedSpinner } from '../issue-detail/CompositedSpinner'

interface ConversationHistoryBoundaryProps {
  boundaryKey: string
  loading: boolean
  failed?: boolean
  suspended: boolean
  manual?: boolean
  controlsTarget: HTMLElement | null
  scrollRef: RefObject<HTMLDivElement | null>
  onPrepare: (automatic: boolean) => void
  onLoad?: () => Promise<void> | void
}

function historyPrefetchMargin(root: Element | Document | null): string {
  // Fetch one viewport ahead, even in short reading panes.
  return Math.max(root instanceof Element ? root.clientHeight : 0, 800) + 'px 0px 0px'
}

export function ConversationHistoryBoundary({
  boundaryKey,
  loading,
  failed = false,
  suspended,
  manual = false,
  controlsTarget,
  scrollRef,
  onPrepare,
  onLoad,
}: ConversationHistoryBoundaryProps) {
  const { t } = useConversationTranslation()
  const markerRef = useRef<HTMLDivElement>(null)
  const pendingRef = useRef(false)
  const attemptedBoundaryRef = useRef<string | null>(null)
  const [request, setRequest] = useState<{
    boundaryKey: string
    automatic: boolean
    status: 'loading' | 'completed' | 'failed'
  } | null>(null)
  const currentRequest = request?.boundaryKey === boundaryKey ? request : null
  const status = currentRequest?.status ?? 'idle'
  const requestPending = request?.status === 'loading'

  const load = useCallback(
    async (automatic: boolean) => {
      if (!onLoad || loading || pendingRef.current) return
      if (automatic && attemptedBoundaryRef.current === boundaryKey) return
      attemptedBoundaryRef.current = boundaryKey
      pendingRef.current = true
      setRequest({ boundaryKey, automatic, status: 'loading' })
      try {
        onPrepare(automatic)
        await onLoad()
        setRequest({ boundaryKey, automatic, status: 'completed' })
      } catch {
        setRequest({ boundaryKey, automatic, status: 'failed' })
      } finally {
        pendingRef.current = false
      }
    },
    [boundaryKey, loading, onLoad, onPrepare]
  )

  const onIntersection = useCallback<IntersectionObserverCallback>(
    entries => {
      if (entries.some(entry => entry.isIntersecting)) void load(true)
    },
    [load]
  )
  useIntersectionEvent(markerRef, onIntersection, {
    enabled:
      !suspended &&
      !manual &&
      !loading &&
      !failed &&
      !requestPending &&
      status !== 'failed' &&
      Boolean(onLoad),
    root: scrollRef,
    rootMargin: historyPrefetchMargin,
    threshold: 0,
  })

  const busy = loading || requestPending
  const showAction =
    manual ||
    failed ||
    status === 'failed' ||
    (request && !request.automatic && busy) ||
    (currentRequest && (!currentRequest.automatic || (status === 'completed' && !loading)))
  const showControls = showAction || (busy && !suspended)
  return (
    <>
      <div
        ref={markerRef}
        data-testid="runtime-transcript-history-start"
        aria-busy={busy}
        className="h-px shrink-0"
      />
      {controlsTarget &&
        showControls &&
        createPortal(
          <div className="pointer-events-none absolute inset-x-0 top-2 z-20 flex justify-center">
            {showAction ? (
              <button
                type="button"
                data-testid="load-older-runtime-transcript-button"
                disabled={!onLoad}
                aria-disabled={busy || !onLoad}
                onClick={() => void load(false)}
                className="pointer-events-auto flex h-11 items-center gap-2 rounded-md bg-background/95 px-4 text-xs text-text-secondary shadow-sm hover:bg-muted aria-disabled:opacity-60"
              >
                {busy && <CompositedSpinner className="h-4 w-4" />}
                {busy
                  ? t('workbench.loading_older_messages')
                  : failed || status === 'failed'
                    ? t('workbench.load_older_messages_failed')
                    : t('workbench.load_older_messages')}
              </button>
            ) : (
              <span
                role="status"
                aria-label={t('workbench.loading_older_messages')}
                data-testid="runtime-transcript-history-loading"
                className="flex h-8 w-8 items-center justify-center rounded-full bg-background/90 text-text-secondary"
              >
                <CompositedSpinner className="h-4 w-4" />
              </span>
            )}
          </div>,
          controlsTarget
        )}
    </>
  )
}
