import { useEffect, useRef, useState } from 'react'
import {
  cancelSafeAnimationFrame,
  requestSafeAnimationFrame,
  type SafeAnimationFrameHandle,
} from './safeAnimationFrame'

const FALLBACK_FLUSH_MS = 100

export function useBufferedStreamingText(content: string, isStreaming: boolean): string {
  const [bufferedContent, setBufferedContent] = useState(content)
  const targetContentRef = useRef(content)
  const bufferedContentRef = useRef(content)
  const frameRef = useRef<SafeAnimationFrameHandle | null>(null)
  const fallbackTimerRef = useRef<number | null>(null)

  useEffect(() => {
    targetContentRef.current = content

    const cancelFrame = () => {
      if (frameRef.current === null) return
      cancelSafeAnimationFrame(frameRef.current)
      frameRef.current = null
    }

    const cancelFallbackTimer = () => {
      if (fallbackTimerRef.current === null) return
      clearTimeout(fallbackTimerRef.current)
      fallbackTimerRef.current = null
    }

    const syncLatestContent = () => {
      cancelFrame()
      cancelFallbackTimer()
      const target = targetContentRef.current
      bufferedContentRef.current = target
      setBufferedContent(target)
    }

    if (!isStreaming || !content.startsWith(bufferedContentRef.current)) {
      syncLatestContent()
      return
    }

    if (frameRef.current === null && bufferedContentRef.current !== content) {
      frameRef.current = requestSafeAnimationFrame(() => {
        frameRef.current = null
        syncLatestContent()
      })
      fallbackTimerRef.current = window.setTimeout(syncLatestContent, FALLBACK_FLUSH_MS)
    }
  }, [content, isStreaming])

  useEffect(
    () => () => {
      if (frameRef.current !== null) cancelSafeAnimationFrame(frameRef.current)
      if (fallbackTimerRef.current !== null) clearTimeout(fallbackTimerRef.current)
    },
    []
  )

  return isStreaming ? bufferedContent : content
}
