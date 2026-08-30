import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import {
  cancelSafeAnimationFrame,
  requestSafeAnimationFrame,
  type SafeAnimationFrameHandle,
} from './safeAnimationFrame'

const FPS_THRESHOLD = 30
const FRAME_TIME_EMA_ALPHA = 0.12
const HEALTHY_RECOVERY_FRAMES = 6
const MAX_FRAME_TIME_MS = 100

type FrameHealthSubscriber = (degraded: boolean) => void

const frameHealthSubscribers = new Set<FrameHealthSubscriber>()
let frameHealthHandle: SafeAnimationFrameHandle | null = null
let previousFrameAt = 0
let frameTimeEma = 0
let healthyFrames = 0
let frameHealthDegraded = false

interface StreamingRenderGuard {
  reducedMotion: boolean
  rootRef: RefObject<HTMLDivElement | null>
  shouldHoldBack: () => boolean
}

function publishFrameHealth(degraded: boolean) {
  if (frameHealthDegraded === degraded) return
  frameHealthDegraded = degraded
  frameHealthSubscribers.forEach(subscriber => subscriber(degraded))
}

function measureFrameHealth(now: number) {
  frameHealthHandle = null
  if (frameHealthSubscribers.size === 0) return

  if (previousFrameAt !== 0) {
    const elapsedMs = Math.min(MAX_FRAME_TIME_MS, Math.max(1, now - previousFrameAt))
    frameTimeEma =
      frameTimeEma === 0
        ? elapsedMs
        : frameTimeEma + FRAME_TIME_EMA_ALPHA * (elapsedMs - frameTimeEma)
    if (1000 / frameTimeEma < FPS_THRESHOLD) {
      healthyFrames = 0
      publishFrameHealth(true)
    } else if (frameHealthDegraded) {
      healthyFrames += 1
      if (healthyFrames >= HEALTHY_RECOVERY_FRAMES) publishFrameHealth(false)
    }
  }
  previousFrameAt = now
  frameHealthHandle = requestSafeAnimationFrame(measureFrameHealth, {
    fallbackOnSynchronous: false,
  })
}

function subscribeFrameHealth(subscriber: FrameHealthSubscriber): () => void {
  frameHealthSubscribers.add(subscriber)
  subscriber(frameHealthDegraded)
  if (frameHealthHandle === null) {
    frameHealthHandle = requestSafeAnimationFrame(measureFrameHealth, {
      fallbackOnSynchronous: false,
    })
  }

  return () => {
    frameHealthSubscribers.delete(subscriber)
    if (frameHealthSubscribers.size > 0) return
    if (frameHealthHandle !== null) cancelSafeAnimationFrame(frameHealthHandle)
    frameHealthHandle = null
    previousFrameAt = 0
    frameTimeEma = 0
    healthyFrames = 0
    frameHealthDegraded = false
  }
}

export function useStreamingRenderGuard(active: boolean): StreamingRenderGuard {
  const rootRef = useRef<HTMLDivElement>(null)
  const visibleRef = useRef(true)
  const degradedRef = useRef(false)
  const [reducedMotion, setReducedMotion] = useState(
    () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
  )

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const query = window.matchMedia('(prefers-reduced-motion: reduce)')
    const update = () => setReducedMotion(query.matches)
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])

  useEffect(() => {
    const root = rootRef.current
    if (!active || !root || typeof IntersectionObserver === 'undefined') {
      visibleRef.current = true
      return
    }
    const observer = new IntersectionObserver(
      entries => {
        const entry = entries[0]
        if (entry) visibleRef.current = entry.isIntersecting
      },
      { rootMargin: '240px 0px' }
    )
    observer.observe(root)
    return () => {
      observer.disconnect()
      visibleRef.current = true
    }
  }, [active])

  useEffect(() => {
    if (!active || reducedMotion) {
      degradedRef.current = false
      return
    }
    return subscribeFrameHealth(degraded => {
      degradedRef.current = degraded
    })
  }, [active, reducedMotion])

  const shouldHoldBack = useCallback(
    () => active && (!visibleRef.current || degradedRef.current),
    [active]
  )

  return { reducedMotion, rootRef, shouldHoldBack }
}
