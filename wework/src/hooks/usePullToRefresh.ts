import {
  useCallback,
  useRef,
  useState,
  type RefObject,
  type TouchEvent,
} from 'react'

const PULL_THRESHOLD = 64
const MAX_PULL_DISTANCE = 96
const PULL_RESISTANCE = 0.5

interface PullToRefreshState {
  scrollRef: RefObject<HTMLDivElement | null>
  pullDistance: number
  refreshing: boolean
  threshold: number
  canRelease: boolean
  handlers: {
    onTouchStart: (event: TouchEvent<HTMLDivElement>) => void
    onTouchMove: (event: TouchEvent<HTMLDivElement>) => void
    onTouchEnd: () => void
  }
}

/**
 * Pull-to-refresh gesture for a scrollable container. The gesture only arms
 * when the container is scrolled to the top, so normal scrolling is untouched.
 */
export function usePullToRefresh(
  onRefresh: () => Promise<void>,
): PullToRefreshState {
  const scrollRef = useRef<HTMLDivElement>(null)
  const startYRef = useRef<number | null>(null)
  const [pullDistance, setPullDistance] = useState(0)
  const [refreshing, setRefreshing] = useState(false)

  const onTouchStart = useCallback(
    (event: TouchEvent<HTMLDivElement>) => {
      if (refreshing) return
      const element = scrollRef.current
      startYRef.current =
        element && element.scrollTop <= 0 ? event.touches[0].clientY : null
    },
    [refreshing],
  )

  const onTouchMove = useCallback(
    (event: TouchEvent<HTMLDivElement>) => {
      if (startYRef.current === null || refreshing) return
      const delta = event.touches[0].clientY - startYRef.current
      if (delta <= 0) {
        setPullDistance(0)
        return
      }
      setPullDistance(Math.min(MAX_PULL_DISTANCE, delta * PULL_RESISTANCE))
    },
    [refreshing],
  )

  const onTouchEnd = useCallback(() => {
    if (startYRef.current === null) return
    startYRef.current = null

    if (pullDistance < PULL_THRESHOLD || refreshing) {
      setPullDistance(0)
      return
    }

    setRefreshing(true)
    setPullDistance(PULL_THRESHOLD)
    void onRefresh()
      .catch(() => undefined)
      .finally(() => {
        setRefreshing(false)
        setPullDistance(0)
      })
  }, [onRefresh, pullDistance, refreshing])

  return {
    scrollRef,
    pullDistance,
    refreshing,
    threshold: PULL_THRESHOLD,
    canRelease: pullDistance >= PULL_THRESHOLD,
    handlers: { onTouchStart, onTouchMove, onTouchEnd },
  }
}
