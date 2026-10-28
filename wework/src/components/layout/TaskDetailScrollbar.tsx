import { useCallback, useLayoutEffect, useRef, type RefObject } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import {
  CONVERSATION_SCROLL_WRITE_SOURCE,
  recordConversationScrollWrite,
} from '@wegent/collaboration/conversation'

interface TaskDetailScrollbarProps {
  viewportRef: RefObject<HTMLDivElement | null>
  scrollbarRef: RefObject<HTMLDivElement | null>
  viewportId: string
}

// The workbench owns the viewport; this overlay does not add a layout gutter.
export function TaskDetailScrollbar({
  viewportRef,
  scrollbarRef,
  viewportId,
}: TaskDetailScrollbarProps) {
  const { t } = useTranslation('common')
  const thumbRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ pointerId: number; offset: number; clientY: number } | null>(null)
  const dragFrameRef = useRef<number | null>(null)
  const pendingPointerRef = useRef<{ clientY: number; offset: number } | null>(null)

  const cancelDragFrame = useCallback(() => {
    if (dragFrameRef.current !== null) cancelAnimationFrame(dragFrameRef.current)
    dragFrameRef.current = null
    pendingPointerRef.current = null
  }, [])

  useLayoutEffect(() => cancelDragFrame, [cancelDragFrame])

  const scrollFromPointer = useCallback(
    (clientY: number, offset: number) => {
      const viewport = viewportRef.current
      const track = scrollbarRef.current
      const thumb = thumbRef.current
      if (!viewport || !track || !thumb) return
      const travel = track.clientHeight - thumb.offsetHeight
      if (travel <= 0) return
      const ratio = Math.max(
        0,
        Math.min(1, (clientY - track.getBoundingClientRect().top - offset) / travel)
      )
      const top = ratio * Math.max(0, viewport.scrollHeight - viewport.clientHeight)
      if (Math.abs(viewport.scrollTop - top) < 0.5) return
      recordConversationScrollWrite(
        viewport,
        CONVERSATION_SCROLL_WRITE_SOURCE.scrollbarPointer,
        top,
        () => {
          viewport.scrollTop = top
        }
      )
    },
    [scrollbarRef, viewportRef]
  )

  useLayoutEffect(() => {
    const viewport = viewportRef.current
    const track = scrollbarRef.current
    const thumb = thumbRef.current
    if (!viewport || !track || !thumb) return

    const update = () => {
      const viewportHeight = viewport.clientHeight
      const contentHeight = viewport.scrollHeight
      const range = Math.max(0, contentHeight - viewportHeight)
      const display = range > 0 && viewportHeight > 0 ? 'flex' : 'none'
      if (track.style.display !== display) track.style.display = display
      const trackHeight = track.clientHeight
      const size = Math.min(
        trackHeight,
        Math.max(18, contentHeight > 0 ? (trackHeight * viewportHeight) / contentHeight : 0)
      )
      thumb.style.height = `${size}px`
      const drag = dragRef.current
      if (drag) scrollFromPointer(drag.clientY, drag.offset)
      const position = Math.max(0, Math.min(range, viewport.scrollTop))
      thumb.style.transform = `translateY(${range ? (position / range) * (trackHeight - size) : 0}px)`
      track.setAttribute('aria-valuemax', String(range))
      track.setAttribute('aria-valuenow', String(Math.round(position)))
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(viewport)
    observer.observe(track)
    if (viewport.firstElementChild) observer.observe(viewport.firstElementChild)
    viewport.addEventListener('scroll', update)
    return () => {
      observer.disconnect()
      viewport.removeEventListener('scroll', update)
    }
  }, [scrollFromPointer, scrollbarRef, viewportRef])

  const flushPointer = () => {
    const pending = pendingPointerRef.current
    cancelDragFrame()
    if (pending) scrollFromPointer(pending.clientY, pending.offset)
  }

  return (
    <div
      ref={scrollbarRef}
      role="scrollbar"
      tabIndex={0}
      aria-label={t('workbench.conversation_scrollbar')}
      aria-controls={viewportId}
      aria-orientation="vertical"
      aria-valuemin={0}
      aria-valuemax={0}
      aria-valuenow={0}
      data-testid="desktop-workbench-scrollbar"
      className="workbench-scrollbar absolute bottom-[3px] right-[3px] top-[3px] z-critical flex w-2 touch-none select-none bg-transparent"
      onPointerDown={event => {
        if (event.button !== 0 || !thumbRef.current) return
        event.preventDefault()
        cancelDragFrame()
        const thumb = thumbRef.current
        const offset = thumb.contains(event.target as Node)
          ? event.clientY - thumb.getBoundingClientRect().top
          : thumb.offsetHeight / 2
        dragRef.current = { pointerId: event.pointerId, offset, clientY: event.clientY }
        event.currentTarget.setPointerCapture(event.pointerId)
        scrollFromPointer(event.clientY, offset)
      }}
      onPointerMove={event => {
        const drag = dragRef.current
        if (drag?.pointerId !== event.pointerId) return
        drag.clientY = event.clientY
        pendingPointerRef.current = { clientY: event.clientY, offset: drag.offset }
        if (dragFrameRef.current === null) {
          dragFrameRef.current = requestAnimationFrame(flushPointer)
        }
      }}
      onPointerUp={event => {
        if (dragRef.current?.pointerId !== event.pointerId) return
        flushPointer()
        dragRef.current = null
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId)
        }
      }}
      onLostPointerCapture={() => {
        cancelDragFrame()
        dragRef.current = null
      }}
      onPointerCancel={() => {
        cancelDragFrame()
        dragRef.current = null
      }}
      onKeyDown={event => {
        const viewport = viewportRef.current
        if (!viewport) return
        const range = Math.max(0, viewport.scrollHeight - viewport.clientHeight)
        const positions: Record<string, number> = {
          ArrowUp: viewport.scrollTop - 40,
          ArrowDown: viewport.scrollTop + 40,
          PageUp: viewport.scrollTop - viewport.clientHeight,
          PageDown: viewport.scrollTop + viewport.clientHeight,
          Home: 0,
          End: range,
        }
        const position = positions[event.key]
        if (position === undefined) return
        event.preventDefault()
        const top = Math.max(0, Math.min(range, position))
        recordConversationScrollWrite(
          viewport,
          CONVERSATION_SCROLL_WRITE_SOURCE.scrollbarKeyboard,
          top,
          () => {
            viewport.scrollTop = top
          }
        )
      }}
    >
      <div
        ref={thumbRef}
        data-testid="desktop-workbench-scrollbar-thumb"
        className="workbench-scrollbar-thumb w-full rounded-full"
      />
    </div>
  )
}
