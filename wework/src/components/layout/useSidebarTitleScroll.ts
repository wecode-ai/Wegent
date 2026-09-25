import { useEffect, type RefObject } from 'react'
import {
  getSidebarTitleMotion,
  SIDEBAR_TITLE_DELAY_MS,
  SIDEBAR_TITLE_RETURN_MS,
} from './sidebarTitleMotion'
import {
  WORKBENCH_SIDEBAR_PANE_DRAG_END_EVENT,
  WORKBENCH_SIDEBAR_PANE_DRAG_START_EVENT,
} from './workbenchPaneDrag'

const activeDragListeners = new Set<() => void>()
let mountedTitles = 0
let paneDragging = false

function handlePaneDragStart() {
  paneDragging = true
  activeDragListeners.forEach(listener => listener())
}

function handlePaneDragEnd() {
  paneDragging = false
  activeDragListeners.forEach(listener => listener())
}

function listenForPaneDrag() {
  if (mountedTitles++ === 0) {
    window.addEventListener(WORKBENCH_SIDEBAR_PANE_DRAG_START_EVENT, handlePaneDragStart)
    window.addEventListener(WORKBENCH_SIDEBAR_PANE_DRAG_END_EVENT, handlePaneDragEnd)
  }
  return () => {
    if (--mountedTitles === 0) {
      window.removeEventListener(WORKBENCH_SIDEBAR_PANE_DRAG_START_EVENT, handlePaneDragStart)
      window.removeEventListener(WORKBENCH_SIDEBAR_PANE_DRAG_END_EVENT, handlePaneDragEnd)
      paneDragging = false
    }
  }
}

export function useSidebarTitleScroll(
  containerRef: RefObject<HTMLSpanElement | null>,
  viewportRef: RefObject<HTMLSpanElement | null>,
  textRef: RefObject<HTMLSpanElement | null>,
  text: string
) {
  useEffect(() => {
    const container = containerRef.current
    const viewport = viewportRef.current
    const content = textRef.current
    const row = container?.closest<HTMLElement>('[data-sidebar-task-row]')
    if (!container || !viewport || !content || !row) return
    const actions = row.querySelector<HTMLElement>('[data-sidebar-title-actions]')
    let hovered = row.matches(':hover')
    let keyboardFocused =
      row.contains(document.activeElement) &&
      Boolean(document.activeElement?.matches(':focus-visible'))
    let pointerDown = false
    let disposed = false
    let distance = 0
    let position = 0
    let timer: number | undefined
    let frame: number | undefined
    let observer: ResizeObserver | undefined
    let media: MediaQueryList | undefined

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
      if (disposed || !isActive()) return
      cancel()
      measure()
      paint(0)
      container.dataset.scrollState = 'idle'
      if (media?.matches || paneDragging || pointerDown || distance <= 0) return
      container.dataset.scrollState = 'waiting'
      timer = window.setTimeout(start, SIDEBAR_TITLE_DELAY_MS)
    }
    const stopTracking = () => {
      observer?.disconnect()
      observer = undefined
      media?.removeEventListener('change', refresh)
      media = undefined
      activeDragListeners.delete(refresh)
    }
    const activate = () => {
      if (!observer) {
        media = window.matchMedia?.('(prefers-reduced-motion: reduce)')
        media?.addEventListener('change', refresh)
        activeDragListeners.add(refresh)
        observer = new ResizeObserver(refresh)
        observer.observe(container)
        observer.observe(content)
        if (actions) observer.observe(actions)
        if (document.fonts?.status === 'loading') void document.fonts.ready.then(refresh)
      }
      refresh()
    }
    const resetIdle = () => {
      viewport.style.removeProperty('width')
      viewport.style.removeProperty('--sidebar-title-fade-start')
      viewport.style.removeProperty('--sidebar-title-fade-end')
      content.style.removeProperty('transform')
      delete container.dataset.overflow
      container.dataset.scrollState = 'idle'
      position = 0
    }
    const restore = () => {
      cancel()
      const reducedMotion = media?.matches
      stopTracking()
      viewport.style.removeProperty('width')
      if (reducedMotion || position === 0) {
        resetIdle()
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
          resetIdle()
        }
      }
      frame = window.requestAnimationFrame(tick)
    }
    const enter = () => {
      hovered = true
      activate()
    }
    const leave = () => {
      hovered = false
      if (!keyboardFocused) restore()
    }
    const focus = (event: FocusEvent) => {
      keyboardFocused = event.target instanceof Element && event.target.matches(':focus-visible')
      if (keyboardFocused) activate()
    }
    const blur = (event: FocusEvent) => {
      if (event.relatedTarget instanceof Node && row.contains(event.relatedTarget)) return
      keyboardFocused = false
      if (!hovered) restore()
    }
    const release = () => {
      if (!pointerDown) return
      pointerDown = false
      window.removeEventListener('pointerup', release)
      window.removeEventListener('pointercancel', release)
      refresh()
    }
    const press = () => {
      if (pointerDown) return
      pointerDown = true
      window.addEventListener('pointerup', release)
      window.addEventListener('pointercancel', release)
      refresh()
    }

    const stopListeningForPaneDrag = listenForPaneDrag()
    row.addEventListener('pointerenter', enter)
    row.addEventListener('pointerleave', leave)
    row.addEventListener('focusin', focus)
    row.addEventListener('focusout', blur)
    row.addEventListener('pointerdown', press)
    if (isActive()) activate()
    return () => {
      disposed = true
      cancel()
      stopTracking()
      if (pointerDown) {
        window.removeEventListener('pointerup', release)
        window.removeEventListener('pointercancel', release)
      }
      stopListeningForPaneDrag()
      row.removeEventListener('pointerenter', enter)
      row.removeEventListener('pointerleave', leave)
      row.removeEventListener('focusin', focus)
      row.removeEventListener('focusout', blur)
      row.removeEventListener('pointerdown', press)
      if (position !== 0 || viewport.style.width) resetIdle()
    }
  }, [containerRef, viewportRef, textRef, text])
}
