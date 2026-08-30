import { useCallback, useEffect, useRef, useState } from 'react'
import {
  cancelSafeAnimationFrame,
  requestSafeAnimationFrame,
  type SafeAnimationFrameHandle,
} from './safeAnimationFrame'

const BASE_REVEAL_CPS = 90
const BACKLOG_ACCELERATION_EXPONENT = 1.25
const BACKLOG_PRESSURE = 0.85
const MAX_REVEAL_CPS = 600
const MAX_FRAME_DELTA_MS = 100
const BACKGROUND_FLUSH_MS = 100

interface BufferedStreamingTextOptions {
  reducedMotion?: boolean
  revealScaleRef?: { current: number }
  shouldHoldBack?: () => boolean
}

export interface StreamingRevealStep {
  debt: number
  revealChars: number
  speedCps: number
}

export function computeStreamingRevealStep(
  backlog: number,
  elapsedMs: number,
  debt: number,
  revealScale = 1
): StreamingRevealStep {
  if (backlog <= 0 || elapsedMs <= 0) {
    return { debt: 0, revealChars: 0, speedCps: 0 }
  }

  const speedCps = Math.min(
    MAX_REVEAL_CPS,
    BASE_REVEAL_CPS + Math.pow(backlog, BACKLOG_ACCELERATION_EXPONENT) * BACKLOG_PRESSURE
  )
  const accumulated = Math.max(0, debt) + speedCps * Math.max(0.1, revealScale) * (elapsedMs / 1000)
  const revealChars = Math.min(backlog, Math.floor(accumulated))

  return {
    debt: revealChars >= backlog ? 0 : accumulated - revealChars,
    revealChars,
    speedCps,
  }
}

export function useBufferedStreamingText(
  content: string,
  isStreaming: boolean,
  { reducedMotion = false, revealScaleRef, shouldHoldBack }: BufferedStreamingTextOptions = {}
): string {
  const [bufferedContent, setBufferedContent] = useState(content)
  const targetContentRef = useRef(content)
  const bufferedCodeUnitIndexRef = useRef(content.length)
  const backlogRef = useRef(0)
  const revealDebtRef = useRef(0)
  const frameRef = useRef<SafeAnimationFrameHandle | null>(null)
  const fallbackTimerRef = useRef<number | null>(null)
  const bufferSyncTimerRef = useRef<number | null>(null)
  const lastFrameAtRef = useRef<number | null>(null)
  const shouldHoldBackRef = useRef(shouldHoldBack)

  useEffect(() => {
    shouldHoldBackRef.current = shouldHoldBack
  }, [shouldHoldBack])

  const cancelScheduledWork = useCallback(() => {
    if (frameRef.current !== null) {
      cancelSafeAnimationFrame(frameRef.current)
      frameRef.current = null
    }
    if (fallbackTimerRef.current !== null) {
      clearTimeout(fallbackTimerRef.current)
      fallbackTimerRef.current = null
    }
    if (bufferSyncTimerRef.current !== null) {
      clearTimeout(bufferSyncTimerRef.current)
      bufferSyncTimerRef.current = null
    }
    lastFrameAtRef.current = null
  }, [])

  const resetBuffer = useCallback(
    (nextContent: string) => {
      cancelScheduledWork()
      targetContentRef.current = nextContent
      bufferedCodeUnitIndexRef.current = nextContent.length
      backlogRef.current = 0
      revealDebtRef.current = 0
    },
    [cancelScheduledWork]
  )

  const scheduleBufferSync = useCallback((nextContent: string) => {
    bufferSyncTimerRef.current = window.setTimeout(() => {
      bufferSyncTimerRef.current = null
      setBufferedContent(nextContent)
    }, 0)
  }, [])

  const startFrameLoop = useCallback(() => {
    if (frameRef.current !== null) return

    const advanceFrame = (now: number) => {
      frameRef.current = null
      if (backlogRef.current <= 0) {
        revealDebtRef.current = 0
        lastFrameAtRef.current = null
        return
      }

      const previousFrameAt = lastFrameAtRef.current
      lastFrameAtRef.current = now
      if (previousFrameAt === null) {
        frameRef.current = requestSafeAnimationFrame(advanceFrame)
        return
      }

      const step = computeStreamingRevealStep(
        backlogRef.current,
        Math.min(MAX_FRAME_DELTA_MS, Math.max(0, now - previousFrameAt)),
        revealDebtRef.current,
        revealScaleRef?.current ?? 1
      )

      if (shouldHoldBackRef.current?.() !== true) {
        revealDebtRef.current = step.debt
        if (step.revealChars > 0) {
          const nextIndex = advanceCodePointIndex(
            targetContentRef.current,
            bufferedCodeUnitIndexRef.current,
            step.revealChars
          )
          bufferedCodeUnitIndexRef.current = nextIndex
          backlogRef.current -= step.revealChars
          setBufferedContent(targetContentRef.current.slice(0, nextIndex))
        }
      }

      if (backlogRef.current > 0) {
        frameRef.current = requestSafeAnimationFrame(advanceFrame)
      } else {
        lastFrameAtRef.current = null
      }
    }

    frameRef.current = requestSafeAnimationFrame(advanceFrame)
  }, [revealScaleRef])

  useEffect(() => {
    if (!isStreaming || reducedMotion) {
      resetBuffer(content)
      scheduleBufferSync(content)
      return
    }

    const previousTarget = targetContentRef.current
    if (!content.startsWith(previousTarget)) {
      resetBuffer(content)
      scheduleBufferSync(content)
      return
    }
    if (content === previousTarget) return

    const appended = content.slice(previousTarget.length)
    targetContentRef.current = content
    backlogRef.current += countCodePoints(appended)
    startFrameLoop()

    if (fallbackTimerRef.current === null) {
      fallbackTimerRef.current = window.setTimeout(() => {
        fallbackTimerRef.current = null
        if (document.visibilityState === 'hidden') {
          const target = targetContentRef.current
          resetBuffer(target)
          setBufferedContent(target)
        }
      }, BACKGROUND_FLUSH_MS)
    }
  }, [content, isStreaming, reducedMotion, resetBuffer, scheduleBufferSync, startFrameLoop])

  useEffect(
    () => () => {
      cancelScheduledWork()
    },
    [cancelScheduledWork]
  )

  return isStreaming && !reducedMotion ? bufferedContent : content
}

function countCodePoints(value: string): number {
  let count = 0
  for (const character of value) {
    void character
    count += 1
  }
  return count
}

function advanceCodePointIndex(value: string, start: number, count: number): number {
  let index = start
  let consumed = 0
  while (index < value.length && consumed < count) {
    const codePoint = value.codePointAt(index)
    index += codePoint !== undefined && codePoint > 0xffff ? 2 : 1
    consumed += 1
  }
  return index
}
