import { useEffect, useRef, useState } from 'react'

const STREAM_RENDER_INTERVAL_MS = 50

export function useBufferedStreamingText(content: string, isStreaming: boolean): string {
  const [bufferedContent, setBufferedContent] = useState(content)
  const targetContentRef = useRef(content)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    targetContentRef.current = content

    if (!isStreaming) {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
      return
    }

    if (timerRef.current !== null) return
    timerRef.current = setTimeout(() => {
      timerRef.current = null
      setBufferedContent(targetContentRef.current)
    }, STREAM_RENDER_INTERVAL_MS)
  }, [content, isStreaming])

  useEffect(
    () => () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current)
      }
    },
    []
  )

  return isStreaming ? bufferedContent : content
}
