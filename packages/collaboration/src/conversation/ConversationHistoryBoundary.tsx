import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'

import { useConversationTranslation } from './ConversationTranslation'
import { CompositedSpinner } from '../issue-detail/CompositedSpinner'

interface ConversationHistoryBoundaryProps {
  boundaryKey: string
  loading: boolean
  failed?: boolean
  suspended: boolean
  manual?: boolean
  scrollRef: RefObject<HTMLDivElement | null>
  onPrepare: (automatic: boolean) => void
  onLoad?: () => Promise<void> | void
}

export function ConversationHistoryBoundary({
  boundaryKey,
  loading,
  failed = false,
  suspended,
  manual = false,
  scrollRef,
  onPrepare,
  onLoad,
}: ConversationHistoryBoundaryProps) {
  const { t } = useConversationTranslation()
  const markerRef = useRef<HTMLDivElement>(null)
  const pendingRef = useRef(false)
  const attemptedBoundaryRef = useRef<string | null>(null)
  const mountedRef = useRef(false)
  const [status, setStatus] = useState<'idle' | 'loading' | 'failed'>('idle')
  const [completedBoundaryKey, setCompletedBoundaryKey] = useState<string | null>(null)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const load = useCallback(
    async (automatic: boolean) => {
      if (!onLoad || loading || pendingRef.current) return
      if (automatic && attemptedBoundaryRef.current === boundaryKey) return
      attemptedBoundaryRef.current = boundaryKey
      pendingRef.current = true
      setStatus('loading')
      try {
        onPrepare(automatic)
        await onLoad()
        if (mountedRef.current) {
          setCompletedBoundaryKey(boundaryKey)
          setStatus('idle')
        }
      } catch {
        if (mountedRef.current) setStatus('failed')
      } finally {
        pendingRef.current = false
      }
    },
    [boundaryKey, loading, onLoad, onPrepare]
  )

  useEffect(() => {
    const marker = markerRef.current
    const scroller = scrollRef.current
    if (
      suspended ||
      manual ||
      loading ||
      failed ||
      status !== 'idle' ||
      !onLoad ||
      !marker ||
      !scroller ||
      typeof IntersectionObserver === 'undefined'
    )
      return
    let active = true
    const observer = new IntersectionObserver(
      entries => {
        if (active && entries.some(entry => entry.isIntersecting)) void load(true)
      },
      {
        root: scroller,
        // Fetch one viewport ahead, while the boundary is still outside the reader's view.
        rootMargin: `${Math.max(scroller.clientHeight, 800)}px 0px 0px`,
        threshold: 0,
      }
    )
    observer.observe(marker)
    return () => {
      active = false
      observer.disconnect()
    }
  }, [boundaryKey, failed, load, loading, manual, onLoad, scrollRef, status, suspended])

  const showAction =
    manual || failed || status === 'failed' || (!loading && completedBoundaryKey === boundaryKey)
  const busy = loading || status === 'loading'
  return (
    <div
      ref={markerRef}
      data-testid="runtime-transcript-history-start"
      aria-busy={busy}
      className={showAction ? 'flex shrink-0 justify-center px-4 py-2' : 'h-px shrink-0'}
    >
      {showAction ? (
        <button
          type="button"
          data-testid="load-older-runtime-transcript-button"
          disabled={busy || !onLoad}
          onClick={() => void load(false)}
          className="flex h-11 items-center gap-2 rounded-md px-4 text-xs text-text-secondary hover:bg-muted disabled:opacity-60"
        >
          {busy && <CompositedSpinner className="h-4 w-4" />}
          {busy
            ? t('workbench.loading_older_messages')
            : failed || status === 'failed'
              ? t('workbench.load_older_messages_failed')
              : t('workbench.load_older_messages')}
        </button>
      ) : (
        <span className="sr-only">{busy ? t('workbench.loading_older_messages') : ''}</span>
      )}
    </div>
  )
}
