import { useEffect, useRef, useState } from 'react'

const TARGET_CATCH_UP_FRAMES = 8
const MAX_CODE_POINTS_PER_FRAME = 16
const TARGET_RESERVE_CODE_POINTS = 12

export function useBufferedStreamingText(content: string, isStreaming: boolean): string {
  const [bufferedContent, setBufferedContent] = useState(content)
  const targetContentRef = useRef(content)
  const bufferedContentRef = useRef(content)
  const frameRef = useRef<number | null>(null)
  const reserveDrainFrameRef = useRef(false)

  useEffect(() => {
    targetContentRef.current = content

    if (!isStreaming || !content.startsWith(bufferedContentRef.current)) {
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current)
        frameRef.current = null
      }
      bufferedContentRef.current = content
      setBufferedContent(content)
      return
    }

    if (content === bufferedContentRef.current) return

    const advanceFrame = () => {
      frameRef.current = null
      reserveDrainFrameRef.current = !reserveDrainFrameRef.current
      const nextContent = getNextBufferedStreamingText(
        bufferedContentRef.current,
        targetContentRef.current,
        reserveDrainFrameRef.current
      )
      bufferedContentRef.current = nextContent
      setBufferedContent(nextContent)
      if (nextContent !== targetContentRef.current) {
        frameRef.current = requestAnimationFrame(advanceFrame)
      }
    }

    if (frameRef.current === null) {
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

  return isStreaming ? bufferedContent : content
}

export function getNextBufferedStreamingText(
  current: string,
  target: string,
  drainReserve = true
): string {
  if (current === target || !target.startsWith(current)) return target

  const remaining = target.slice(current.length)
  const remainingCodePoints = countCodePoints(remaining)
  if (remainingCodePoints <= TARGET_RESERVE_CODE_POINTS && !drainReserve) return current

  const catchUpCodePoints = Math.max(0, remainingCodePoints - TARGET_RESERVE_CODE_POINTS)
  const codePointBudget = Math.min(
    MAX_CODE_POINTS_PER_FRAME,
    Math.max(1, Math.ceil(catchUpCodePoints / TARGET_CATCH_UP_FRAMES))
  )
  return current + takeCodePoints(remaining, codePointBudget)
}

function countCodePoints(value: string): number {
  return Array.from(value).length
}

function takeCodePoints(value: string, count: number): string {
  let result = ''
  let consumed = 0
  for (const character of value) {
    if (consumed >= count) break
    result += character
    consumed += 1
  }
  return result
}
