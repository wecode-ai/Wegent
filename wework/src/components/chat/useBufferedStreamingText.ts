import { useEffect, useRef, useState } from 'react'

export function useBufferedStreamingText(content: string, isStreaming: boolean): string {
  const [bufferedContent, setBufferedContent] = useState(content)
  const targetContentRef = useRef(content)
  const bufferedContentRef = useRef(content)
  const frameRef = useRef<number | null>(null)

  useEffect(() => {
    targetContentRef.current = content

    const cancelFrame = () => {
      if (frameRef.current === null) return
      cancelAnimationFrame(frameRef.current)
      frameRef.current = null
    }

    const syncImmediately = () => {
      cancelFrame()
      bufferedContentRef.current = content
      setBufferedContent(content)
    }

    if (!isStreaming || !content.startsWith(bufferedContentRef.current)) {
      syncImmediately()
      return
    }

    const advanceFrame = () => {
      frameRef.current = null
      const target = targetContentRef.current
      bufferedContentRef.current = target
      setBufferedContent(target)
    }

    if (frameRef.current === null && bufferedContentRef.current !== content) {
      frameRef.current = requestAnimationFrame(advanceFrame)
    }
  }, [content, isStreaming])

  useEffect(
    () => () => {
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current)
      }
    },
    []
  )

  return bufferedContent
}
