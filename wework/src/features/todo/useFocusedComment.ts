import { useEffect, useRef, useState, type RefObject } from 'react'

const COMMENT_FLASH_MS = 2000

interface CommentFocusRequest {
  commentId: string
  requestKey: string | null
  cancelled?: boolean
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
  const readingSize = useRef<{ width: number; height: number } | null>(null)
  useEffect(() => {
    if (!commentId) {
      revealed.current = null
      return
    }
    const sameRequest =
      revealed.current?.commentId === commentId && revealed.current.requestKey === requestKey
    if (sameRequest && revealed.current?.cancelled) return
    const list = listRef.current
    if (!list) return
    let disposed = false
    let frame = 0
    let located = sameRequest
    const viewport = commentViewport(list)
    const composer = viewport?.querySelector<HTMLElement>('.task-detail-comment-bar')
    const eventTarget = viewport ?? window
    const cleanup = () => {
      disposed = true
      window.cancelAnimationFrame(frame)
      resize.disconnect()
      mutations.disconnect()
      eventTarget.removeEventListener('wheel', cancel)
      eventTarget.removeEventListener('touchstart', cancelPointer)
      eventTarget.removeEventListener('pointerdown', cancelPointer)
      eventTarget.removeEventListener('keydown', cancelKey)
      window.removeEventListener('resize', schedule)
    }
    const cancel = () => {
      revealed.current = { commentId, requestKey, cancelled: true }
      cleanup()
    }
    const cancelPointer = (event: Event) => {
      if (event.target instanceof Element && event.target.closest('.task-detail-comment-bar'))
        return
      cancel()
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
      const bounds = commentReadingBounds(viewport)
      if (bounds.width <= 0 || bounds.height <= 0 || target.getBoundingClientRect().height <= 0)
        return
      resize.observe(target)
      target.scrollIntoView?.({
        behavior: 'instant',
        block: target.getBoundingClientRect().height > bounds.height ? 'start' : 'center',
      })
      if (viewport) {
        const rect = target.getBoundingClientRect()
        if (rect.top < bounds.top || rect.bottom > bounds.bottom) {
          const top =
            bounds.top + (rect.height > bounds.height ? 0 : (bounds.height - rect.height) / 2)
          viewport.scrollTop += rect.top - top
        }
      }
      const rect = target.getBoundingClientRect()
      if (
        rect.top < bounds.top - 1 ||
        (rect.height <= bounds.height ? rect.bottom > bounds.bottom + 1 : rect.top >= bounds.bottom)
      )
        return
      revealed.current = { commentId, requestKey }
      readingSize.current = { width: bounds.width, height: bounds.height }
      if (!located) setFlashedRequest(revealed.current)
      located = true
      mutations.disconnect()
      resize.disconnect()
      if (viewport) resize.observe(viewport)
      const currentComposer = viewport?.querySelector<HTMLElement>('.task-detail-comment-bar')
      if (currentComposer) resize.observe(currentComposer)
    }
    const schedule = () => {
      if (!disposed && !frame) frame = window.requestAnimationFrame(locate)
    }
    const currentBounds = commentReadingBounds(viewport)
    let { width, height } = located && readingSize.current ? readingSize.current : currentBounds
    const resize = new ResizeObserver(() => {
      const bounds = commentReadingBounds(viewport)
      if (!located || bounds.width !== width || bounds.height !== height) schedule()
      width = bounds.width
      height = bounds.height
    })
    const mutations = new MutationObserver(schedule)
    if (!located) resize.observe(list)
    if (viewport) resize.observe(viewport)
    if (composer) resize.observe(composer)
    if (!located) mutations.observe(list, { childList: true, subtree: true })
    eventTarget.addEventListener('wheel', cancel, { passive: true })
    eventTarget.addEventListener('touchstart', cancelPointer, { passive: true })
    eventTarget.addEventListener('pointerdown', cancelPointer, { passive: true })
    eventTarget.addEventListener('keydown', cancelKey)
    window.addEventListener('resize', schedule)
    // Run after parent effects have reset the detail scroll position.
    if (!located || width !== currentBounds.width || height !== currentBounds.height) schedule()
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

function commentReadingBounds(viewport: HTMLElement | null) {
  const rect = viewport?.getBoundingClientRect()
  const top = rect?.top ?? 0
  let bottom = rect?.bottom ?? window.innerHeight
  const composer = viewport?.querySelector<HTMLElement>('.task-detail-comment-bar')
  const composerRect = composer?.getBoundingClientRect()
  if (composerRect && composerRect.height > 0) bottom = Math.min(bottom, composerRect.top)
  return { top, bottom, height: bottom - top, width: rect?.width ?? window.innerWidth }
}

function commentViewport(list: HTMLElement): HTMLElement | null {
  for (let element: HTMLElement | null = list; element; element = element.parentElement) {
    const style = window.getComputedStyle(element)
    if (/^(auto|scroll)$/.test(style.overflowY || style.overflow)) return element
  }
  return null
}
