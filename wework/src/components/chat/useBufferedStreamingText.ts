import { useEffect, useRef, useState } from 'react'

export function useBufferedStreamingText(content: string, isStreaming: boolean): string {
  const [bufferedContent, setBufferedContent] = useState(content)
  const targetContentRef = useRef(content)
  const bufferedContentRef = useRef(content)
  const frameRef = useRef<number | null>(null)
  const fallbackTimerRef = useRef<number | null>(null)

  useEffect(() => {
    targetContentRef.current = content

    const cancelFrame = () => {
      if (frameRef.current === null) return
      cancelAnimationFrame(frameRef.current)
      frameRef.current = null
    }

    const cancelFallbackTimer = () => {
      if (fallbackTimerRef.current === null) return
      clearTimeout(fallbackTimerRef.current)
      fallbackTimerRef.current = null
    }

    const syncImmediately = () => {
      cancelFrame()
      cancelFallbackTimer()
      bufferedContentRef.current = content
      setBufferedContent(content)
    }

    if (!isStreaming || !content.startsWith(bufferedContentRef.current)) {
      syncImmediately()
      return
    }

    const advanceFrame = () => {
      frameRef.current = null
      cancelFallbackTimer()
      const target = targetContentRef.current
      bufferedContentRef.current = target
      setBufferedContent(target)
    }

    if (frameRef.current === null && bufferedContentRef.current !== content) {
      frameRef.current = requestAnimationFrame(advanceFrame)
      fallbackTimerRef.current = window.setTimeout(() => {
        cancelFrame()
        fallbackTimerRef.current = null
        const target = targetContentRef.current
        bufferedContentRef.current = target
        setBufferedContent(target)
      }, 100)
    }
  }, [content, isStreaming])

  useEffect(
    () => () => {
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current)
      }
      if (fallbackTimerRef.current !== null) {
        clearTimeout(fallbackTimerRef.current)
      }
    },
    []
  )

  return bufferedContent
}
