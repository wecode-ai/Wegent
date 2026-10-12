import { useEffect, useRef, useState, type RefObject } from 'react'

const COMMENT_FLASH_MS = 2000

interface CommentFocusRequest {
  commentId: string
  requestKey: string | null
}

export function useFocusedComment(
  listRef: RefObject<HTMLDivElement | null>,
  messages: readonly unknown[],
  commentId: string | null,
  requestKey: string | null
): string | null {
  const [flashedRequest, setFlashedRequest] = useState<CommentFocusRequest | null>(null)
  const revealed = useRef<CommentFocusRequest | null>(null)
  useEffect(() => {
    if (!commentId) {
      revealed.current = null
      return
    }
    if (revealed.current?.commentId === commentId && revealed.current.requestKey === requestKey)
      return
    const target = Array.from(
      listRef.current?.querySelectorAll<HTMLElement>('[data-message-id]') ?? []
    ).find(node => node.dataset.messageId === commentId)
    if (!target) return
    target.scrollIntoView?.({ block: 'center' })
    // A new request renders without the old flash until its next animation frame.
    const frame = window.requestAnimationFrame(() => {
      revealed.current = { commentId, requestKey }
      setFlashedRequest(revealed.current)
    })
    return () => window.cancelAnimationFrame(frame)
  }, [commentId, listRef, messages, requestKey])

  useEffect(() => {
    if (!flashedRequest) return
    const timer = window.setTimeout(() => setFlashedRequest(null), COMMENT_FLASH_MS)
    return () => window.clearTimeout(timer)
  }, [flashedRequest])
  return flashedRequest?.commentId === commentId && flashedRequest?.requestKey === requestKey
    ? commentId
    : null
}
