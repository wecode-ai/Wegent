import { useEffect, useRef, useState } from 'react'

const TARGET_COMPLETION_FRAMES = 8
const MAX_CODE_UNITS_PER_FRAME = 128 * 1024

export function useBufferedStreamingText(content: string, isStreaming: boolean): string {
  const [bufferedContent, setBufferedContent] = useState(content)
  const targetContentRef = useRef(content)
  const bufferedContentRef = useRef(content)
  const frameRef = useRef<number | null>(null)
  const wasStreamingRef = useRef(isStreaming)
  const completionStepRef = useRef<number | null>(null)

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

    if (!content.startsWith(bufferedContentRef.current)) {
      wasStreamingRef.current = isStreaming
      completionStepRef.current = null
      syncImmediately()
      return
    }

    if (isStreaming) {
      wasStreamingRef.current = true
      completionStepRef.current = null
    } else if (wasStreamingRef.current) {
      wasStreamingRef.current = false
      const remaining = content.length - bufferedContentRef.current.length
      completionStepRef.current = Math.min(
        MAX_CODE_UNITS_PER_FRAME,
        Math.max(1, Math.ceil(remaining / TARGET_COMPLETION_FRAMES))
      )
    } else if (frameRef.current === null) {
      syncImmediately()
      return
    }

    const advanceFrame = () => {
      frameRef.current = null
      const target = targetContentRef.current
      const step = completionStepRef.current
      const next =
        step === null
          ? target
          : sliceWithoutSplittingSurrogate(
              target,
              Math.min(target.length, bufferedContentRef.current.length + step)
            )
      bufferedContentRef.current = next
      setBufferedContent(next)
      if (next !== target) {
        frameRef.current = requestAnimationFrame(advanceFrame)
      }
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

function sliceWithoutSplittingSurrogate(value: string, requestedEnd: number): string {
  let end = requestedEnd
  if (
    end > 0 &&
    end < value.length &&
    isHighSurrogate(value.charCodeAt(end - 1)) &&
    isLowSurrogate(value.charCodeAt(end))
  ) {
    end -= 1
  }
  return value.slice(0, end)
}

function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff
}

function isLowSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xdc00 && codeUnit <= 0xdfff
}
