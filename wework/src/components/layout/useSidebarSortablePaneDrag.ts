import { useCallback, useRef, useState } from 'react'
import {
  dispatchWorkbenchSidebarPaneDragCancel,
  dispatchWorkbenchSidebarPaneDragEnd,
  dispatchWorkbenchSidebarPaneDragStart,
  type WorkbenchSidebarPaneDragData,
} from './workbenchPaneDrag'

interface Coordinates {
  x: number
  y: number
}
interface PaneDragSession {
  key: string
  data: WorkbenchSidebarPaneDragData
  pointerId: number
  coordinates: Coordinates
  bounds: { left: number; right: number } | null
  outcome: 'active' | 'drop' | 'cancel'
  started: boolean
  finished: boolean
  suppressCommit: boolean
  cleanup(): void
}

function coordinatesOf(event?: Event): Coordinates | null {
  if (!event || !('clientX' in event) || !('clientY' in event)) return null
  return typeof event.clientX === 'number' && typeof event.clientY === 'number'
    ? { x: event.clientX, y: event.clientY }
    : null
}
function isOutside(session: PaneDragSession) {
  return Boolean(
    session.bounds &&
    (session.coordinates.x < session.bounds.left || session.coordinates.x > session.bounds.right)
  )
}
function horizontalBounds(element: HTMLElement | null) {
  const rows = element?.querySelectorAll<HTMLElement>('[data-sidebar-sortable-id]')
  if (!rows?.length) return null
  const rectangles = [...rows].map(row => row.getBoundingClientRect())
  return {
    left: Math.min(...rectangles.map(rect => rect.left)),
    right: Math.max(...rectangles.map(rect => rect.right)),
  }
}

export function useSidebarSortablePaneDrag() {
  const list = useRef<HTMLDivElement | null>(null)
  const current = useRef<PaneDragSession | null>(null)
  const [sortingSuppressed, setSortingSuppressed] = useState(false)
  const finish = useCallback((session: PaneDragSession) => {
    if (session.finished) return session.suppressCommit
    session.finished = true
    session.cleanup()
    if (!session.started) {
      session.suppressCommit = false
    } else if (session.outcome === 'drop') {
      const data = {
        ...session.data,
        clientX: session.coordinates.x,
        clientY: session.coordinates.y,
        handled: false,
      }
      dispatchWorkbenchSidebarPaneDragEnd(data)
      session.suppressCommit = data.handled || isOutside(session)
    } else {
      dispatchWorkbenchSidebarPaneDragCancel()
      session.suppressCommit = true
    }
    if (list.current) setSortingSuppressed(false)
    return session.suppressCommit
  }, [])
  const bindList = useCallback(
    (node: HTMLDivElement | null) => {
      list.current = node
      if (!node) return
      return () => {
        list.current = null
        const session = current.current
        if (session && !session.finished) {
          session.outcome = 'cancel'
          finish(session)
        }
      }
    },
    [finish]
  )
  const prepare = useCallback(
    (key: string, data: WorkbenchSidebarPaneDragData, event?: Event) => {
      const coordinates = coordinatesOf(event)
      if (
        !coordinates ||
        !event ||
        event.type !== 'pointerdown' ||
        !('pointerId' in event) ||
        typeof event.pointerId !== 'number'
      )
        return
      const previous = current.current
      if (previous && !previous.finished) {
        previous.outcome = 'cancel'
        finish(previous)
      }
      const session: PaneDragSession = {
        key,
        data,
        coordinates,
        pointerId: event.pointerId,
        bounds: horizontalBounds(list.current),
        outcome: 'active',
        started: false,
        finished: false,
        suppressCommit: false,
        cleanup: () => {},
      }
      const matches = (pointer: PointerEvent) => pointer.pointerId === session.pointerId
      const track = (pointer: PointerEvent) => {
        if (!matches(pointer) || session.finished) return
        session.coordinates = { x: pointer.clientX, y: pointer.clientY }
        if (session.started) setSortingSuppressed(isOutside(session))
      }
      const drop = (pointer: PointerEvent) => {
        if (!matches(pointer) || session.finished) return
        track(pointer)
        session.outcome = 'drop'
        queueMicrotask(() => finish(session))
      }
      const cancel = () => {
        if (session.finished || session.outcome === 'drop') return
        session.outcome = 'cancel'
        finish(session)
      }
      const cancelPointer = (pointer: PointerEvent) => {
        if (matches(pointer)) cancel()
      }
      const cancelKey = (keyEvent: KeyboardEvent) => {
        if (keyEvent.key === 'Escape') cancel()
      }
      window.addEventListener('pointermove', track, true)
      window.addEventListener('pointerup', drop, true)
      window.addEventListener('pointercancel', cancelPointer, true)
      window.addEventListener('lostpointercapture', cancelPointer, true)
      window.addEventListener('blur', cancel)
      window.addEventListener('keydown', cancelKey, true)
      session.cleanup = () => {
        window.removeEventListener('pointermove', track, true)
        window.removeEventListener('pointerup', drop, true)
        window.removeEventListener('pointercancel', cancelPointer, true)
        window.removeEventListener('lostpointercapture', cancelPointer, true)
        window.removeEventListener('blur', cancel)
        window.removeEventListener('keydown', cancelKey, true)
      }
      current.current = session
      setSortingSuppressed(false)
    },
    [finish, list]
  )
  const start = useCallback(
    (key: string, data: WorkbenchSidebarPaneDragData, event?: Event) => {
      const previous = current.current
      if (!previous || previous.key !== key || previous.finished) prepare(key, data, event)
      const session = current.current
      if (!session || session.key !== key || session.started || session.finished) return
      session.started = true
      setSortingSuppressed(isOutside(session))
      dispatchWorkbenchSidebarPaneDragStart(session.data)
    },
    [prepare]
  )
  const suppressCommit = useCallback(
    (event?: Event) => {
      const session = current.current
      if (!session) return false
      if (event?.type === 'pointerup' && !session.finished) {
        session.coordinates = coordinatesOf(event) ?? session.coordinates
        session.outcome = 'drop'
      }
      if (session.outcome === 'active') return true
      return finish(session)
    },
    [finish]
  )
  const end = useCallback(
    (key: string) => {
      const session = current.current
      if (!session || session.key !== key) return
      queueMicrotask(() => {
        if (!session.finished) {
          if (session.outcome === 'active') session.outcome = 'cancel'
          finish(session)
        }
        if (current.current === session) current.current = null
      })
    },
    [finish]
  )
  return { bindList, sortingSuppressed, prepare, start, suppressCommit, end }
}
