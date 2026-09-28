import { useLayoutEffect, type RefObject } from 'react'
import {
  getSidebarTitleMotion,
  SIDEBAR_TITLE_DELAY_MS,
  SIDEBAR_TITLE_RETURN_MS,
} from './sidebarTitleMotion'
import {
  WORKBENCH_SIDEBAR_PANE_DRAG_END_EVENT,
  WORKBENCH_SIDEBAR_PANE_DRAG_START_EVENT,
} from './workbenchPaneDrag'

export function useSidebarTitleScroll(
  containerRef: RefObject<HTMLSpanElement | null>,
  viewportRef: RefObject<HTMLSpanElement | null>,
  textRef: RefObject<HTMLSpanElement | null>,
  text: string
) {
  useLayoutEffect(() => {
    const container = containerRef.current
    const viewport = viewportRef.current
    const content = textRef.current
    const row = container?.closest<HTMLElement>('[data-sidebar-task-row]')
    if (!container || !viewport || !content || !row) return
    const actions = row.querySelector<HTMLElement>('[data-sidebar-title-actions]')
    const media = window.matchMedia?.('(prefers-reduced-motion: reduce)')
    let hovered = row.matches(':hover')
    let keyboardFocused =
      row.contains(document.activeElement) &&
      Boolean(document.activeElement?.matches(':focus-visible'))
    let dragging = false
    let pointerDown = false
    let disposed = false
    let distance = 0
    let position = 0
    let timer: number | undefined
    let frame: number | undefined

    const isActive = () => hovered || keyboardFocused
    const cancel = () => {
      window.clearTimeout(timer)
      if (frame !== undefined) window.cancelAnimationFrame(frame)
      timer = undefined
      frame = undefined
    }
    const paint = (nextPosition: number) => {
      position = nextPosition
      content.style.transform = `translateX(${-position}px)`
      viewport.style.setProperty('--sidebar-title-fade-start', `${Math.min(12, position)}px`)
      viewport.style.setProperty(
        '--sidebar-title-fade-end',
        `${Math.min(12, Math.max(0, distance - position))}px`
      )
    }
    const measure = () => {
      const bounds = container.getBoundingClientRect()
      const actionBounds = actions?.getBoundingClientRect()
      const actionsVisible = isActive() || actions?.matches(':focus-within')
      const width =
        actionsVisible && actionBounds && actionBounds.width > 0
          ? Math.max(0, Math.min(bounds.width, actionBounds.left - bounds.left - 4))
          : bounds.width
      viewport.style.width = `${width}px`
      distance = width > 0 ? Math.max(0, content.scrollWidth - width) : 0
      container.dataset.overflow = distance > 0 ? 'true' : 'false'
    }
    const start = () => {
      const motion = getSidebarTitleMotion(distance)
      const startedAt = performance.now()
      container.dataset.scrollState = 'scrolling'
      const tick = (now: number) => {
        const elapsed = now - startedAt
        paint(motion.positionAt(elapsed))
        if (elapsed < motion.duration) frame = window.requestAnimationFrame(tick)
        else {
          frame = undefined
          container.dataset.scrollState = 'end'
        }
      }
      frame = window.requestAnimationFrame(tick)
    }
    const refresh = () => {
      if (disposed) return
      cancel()
      measure()
      paint(0)
      container.dataset.scrollState = 'idle'
      if (!isActive() || media?.matches || dragging || pointerDown || distance <= 0) return
      container.dataset.scrollState = 'waiting'
      timer = window.setTimeout(start, SIDEBAR_TITLE_DELAY_MS)
    }
    const restore = () => {
      cancel()
      measure()
      if (media?.matches || position === 0) {
        paint(0)
        container.dataset.scrollState = 'idle'
        return
      }
      const from = position
      const startedAt = performance.now()
      container.dataset.scrollState = 'returning'
      const tick = (now: number) => {
        const progress = Math.min(1, (now - startedAt) / SIDEBAR_TITLE_RETURN_MS)
        paint(from * (1 - progress) ** 3)
        if (progress < 1) frame = window.requestAnimationFrame(tick)
        else {
          frame = undefined
          container.dataset.scrollState = 'idle'
        }
      }
      frame = window.requestAnimationFrame(tick)
    }
    const enter = () => {
      hovered = true
      refresh()
    }
    const leave = () => {
      hovered = false
      if (!keyboardFocused) restore()
    }
    const focus = (event: FocusEvent) => {
      keyboardFocused = event.target instanceof Element && event.target.matches(':focus-visible')
      if (keyboardFocused) refresh()
    }
    const blur = (event: FocusEvent) => {
      if (event.relatedTarget instanceof Node && row.contains(event.relatedTarget)) return
      keyboardFocused = false
      if (!hovered) restore()
    }
    const press = () => {
      pointerDown = true
      refresh()
    }
    const release = () => {
      if (!pointerDown) return
      pointerDown = false
      refresh()
    }
    const dragStart = () => {
      dragging = true
      refresh()
    }
    const dragEnd = () => {
      dragging = false
      refresh()
    }

    const observer = new ResizeObserver(refresh)
    observer.observe(container)
    observer.observe(content)
    if (actions) observer.observe(actions)
    row.addEventListener('pointerenter', enter)
    row.addEventListener('pointerleave', leave)
    row.addEventListener('focusin', focus)
    row.addEventListener('focusout', blur)
    row.addEventListener('pointerdown', press)
    window.addEventListener('pointerup', release)
    window.addEventListener('pointercancel', release)
    window.addEventListener(WORKBENCH_SIDEBAR_PANE_DRAG_START_EVENT, dragStart)
    window.addEventListener(WORKBENCH_SIDEBAR_PANE_DRAG_END_EVENT, dragEnd)
    media?.addEventListener('change', refresh)
    refresh()
    void document.fonts?.ready.then(refresh)
    return () => {
      disposed = true
      cancel()
      observer.disconnect()
      row.removeEventListener('pointerenter', enter)
      row.removeEventListener('pointerleave', leave)
      row.removeEventListener('focusin', focus)
      row.removeEventListener('focusout', blur)
      row.removeEventListener('pointerdown', press)
      window.removeEventListener('pointerup', release)
      window.removeEventListener('pointercancel', release)
      window.removeEventListener(WORKBENCH_SIDEBAR_PANE_DRAG_START_EVENT, dragStart)
      window.removeEventListener(WORKBENCH_SIDEBAR_PANE_DRAG_END_EVENT, dragEnd)
      media?.removeEventListener('change', refresh)
    }
  }, [containerRef, viewportRef, textRef, text])
}
