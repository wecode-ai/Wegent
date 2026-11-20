import { dispatchWorkbenchSidebarPaneDragCancel } from './workbenchPaneDrag'

export interface SidebarPointerCoordinates {
  x: number
  y: number
}
export interface SidebarHorizontalBounds {
  left: number
  right: number
}
export function isWithinSidebarHorizontalBounds(
  point: SidebarPointerCoordinates,
  bounds: SidebarHorizontalBounds | null
) {
  return !bounds || (point.x >= bounds.left && point.x <= bounds.right)
}

/** Pointer drop coordinates and visual sorting suppression belong to one drag session. */
export function createSidebarPointerDragSource() {
  let snapshot = { active: false, suppressed: false }
  let coordinates: SidebarPointerCoordinates | null = null
  let bounds: SidebarHorizontalBounds | null = null
  const listeners = new Set<() => void>()
  const publish = (active: boolean, suppressed: boolean) => {
    if (snapshot.active === active && snapshot.suppressed === suppressed) return
    snapshot = { active, suppressed }
    listeners.forEach(listener => listener())
  }
  const stop = () => {
    coordinates = null
    publish(false, false)
  }
  const cancel = () => {
    if (snapshot.active) dispatchWorkbenchSidebarPaneDragCancel()
    stop()
  }
  return {
    getSnapshot: () => snapshot,
    getCoordinates: () => coordinates,
    setBounds(value: SidebarHorizontalBounds | null) {
      bounds = value
    },
    getBounds: () => bounds,
    start(point: SidebarPointerCoordinates) {
      coordinates = point
      publish(true, false)
    },
    track(point: SidebarPointerCoordinates | null) {
      if (!snapshot.active || !point) return
      coordinates = point
      publish(true, !isWithinSidebarHorizontalBounds(point, bounds))
    },
    stop,
    cancel,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
        if (!listeners.size) cancel()
      }
    },
  }
}
