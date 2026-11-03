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
  requestKey: string | null,
  ready = true
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
    const list = listRef.current
    if (!list) return
    let disposed = false
    let frame = 0
    const viewport = commentViewport(list)
    const eventTarget = viewport ?? window
    const cleanup = () => {
      disposed = true
      window.cancelAnimationFrame(frame)
      resize.disconnect()
      mutations.disconnect()
      eventTarget.removeEventListener('wheel', cancel)
      eventTarget.removeEventListener('touchstart', cancel)
      eventTarget.removeEventListener('pointerdown', cancel)
      eventTarget.removeEventListener('keydown', cancelKey)
    }
    const cancel = () => {
      revealed.current = { commentId, requestKey }
      cleanup()
    }
    const cancelKey = (event: Event) => {
      const key = (event as KeyboardEvent).key
      const element = event.target instanceof HTMLElement ? event.target : null
      if (element?.closest('input, textarea, [contenteditable="true"]')) return
      if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(key)) cancel()
    }
    const locate = () => {
      frame = 0
      if (disposed || !ready) return
      const target = Array.from(list.querySelectorAll<HTMLElement>('[data-message-id]')).find(
        node => node.dataset.messageId === commentId
      )
      if (!target) return
      const bounds = viewport?.getBoundingClientRect() ?? {
        top: 0,
        bottom: window.innerHeight,
        height: window.innerHeight,
        width: window.innerWidth,
      }
      if (bounds.width <= 0 || bounds.height <= 0 || target.getBoundingClientRect().height <= 0)
        return
      resize.observe(target)
      target.scrollIntoView?.({
        behavior: 'instant',
        block: target.getBoundingClientRect().height > bounds.height ? 'start' : 'center',
      })
      const rect = target.getBoundingClientRect()
      if (
        rect.top < bounds.top - 1 ||
        (rect.height <= bounds.height ? rect.bottom > bounds.bottom + 1 : rect.top >= bounds.bottom)
      )
        return
      revealed.current = { commentId, requestKey }
      setFlashedRequest(revealed.current)
      cleanup()
    }
    const schedule = () => {
      if (!disposed && !frame) frame = window.requestAnimationFrame(locate)
    }
    const resize = new ResizeObserver(schedule)
    const mutations = new MutationObserver(schedule)
    resize.observe(list)
    if (viewport) resize.observe(viewport)
    mutations.observe(list, { childList: true, subtree: true })
    eventTarget.addEventListener('wheel', cancel, { passive: true })
    eventTarget.addEventListener('touchstart', cancel, { passive: true })
    eventTarget.addEventListener('pointerdown', cancel, { passive: true })
    eventTarget.addEventListener('keydown', cancelKey)
    // Run after parent effects have reset the detail scroll position.
    schedule()
    return cleanup
  }, [commentId, listRef, messages, ready, requestKey])

  useEffect(() => {
    if (!flashedRequest) return
    const timer = window.setTimeout(() => setFlashedRequest(null), COMMENT_FLASH_MS)
    return () => window.clearTimeout(timer)
  }, [flashedRequest])
  return flashedRequest?.commentId === commentId && flashedRequest?.requestKey === requestKey
    ? commentId
    : null
}

function commentViewport(list: HTMLElement): HTMLElement | null {
  for (let element: HTMLElement | null = list; element; element = element.parentElement) {
    const style = window.getComputedStyle(element)
    if (/^(auto|scroll)$/.test(style.overflowY || style.overflow)) return element
  }
  return null
}
