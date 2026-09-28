import { useLayoutEffect, useRef, type RefObject } from 'react'
import { useTranslation } from '@/hooks/useTranslation'

interface TaskDetailScrollbarProps {
  viewportRef: RefObject<HTMLDivElement | null>
  scrollbarRef: RefObject<HTMLDivElement | null>
  viewportId: string
}

// The conversation uses bottom-origin scrolling (-range..0). Radix's vertical
// scrollbar only supports 0..range, so it cannot drive this viewport.
export function TaskDetailScrollbar({
  viewportRef,
  scrollbarRef,
  viewportId,
}: TaskDetailScrollbarProps) {
  const { t } = useTranslation('common')
  const thumbRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ pointerId: number; offset: number } | null>(null)

  useLayoutEffect(() => {
    const viewport = viewportRef.current
    const track = scrollbarRef.current
    const thumb = thumbRef.current
    if (!viewport || !track || !thumb) return

    const update = () => {
      const range = Math.max(0, viewport.scrollHeight - viewport.clientHeight)
      track.style.display = range > 0 && viewport.clientHeight > 0 ? 'flex' : 'none'
      const size = Math.min(
        track.clientHeight,
        Math.max(18, (track.clientHeight * viewport.clientHeight) / viewport.scrollHeight)
      )
      const position = Math.max(0, Math.min(range, range + viewport.scrollTop))
      thumb.style.height = `${size}px`
      thumb.style.transform = `translateY(${range ? (position / range) * (track.clientHeight - size) : 0}px)`
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
  }, [scrollbarRef, viewportRef])

  const scrollFromPointer = (clientY: number, offset: number) => {
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
    viewport.scrollTop = (ratio - 1) * (viewport.scrollHeight - viewport.clientHeight)
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
        const thumb = thumbRef.current
        const offset = thumb.contains(event.target as Node)
          ? event.clientY - thumb.getBoundingClientRect().top
          : thumb.offsetHeight / 2
        dragRef.current = { pointerId: event.pointerId, offset }
        event.currentTarget.setPointerCapture(event.pointerId)
        scrollFromPointer(event.clientY, offset)
      }}
      onPointerMove={event => {
        const drag = dragRef.current
        if (drag?.pointerId === event.pointerId) scrollFromPointer(event.clientY, drag.offset)
      }}
      onPointerUp={event => {
        dragRef.current = null
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId)
        }
      }}
      onLostPointerCapture={() => {
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
          Home: -range,
          End: 0,
        }
        const position = positions[event.key]
        if (position === undefined) return
        event.preventDefault()
        viewport.scrollTop = Math.max(-range, Math.min(0, position))
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
