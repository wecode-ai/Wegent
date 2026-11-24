/** The rendered width and drag state own their pending native resize work. */
export function createRightSplitResizeState(width: number) {
  let snapshot = { width, resizing: false }
  const listeners = new Set<() => void>()
  let cleanup: (() => void) | undefined
  let collapseFrame: number | null = null
  const publish = (next: typeof snapshot) => {
    if (next.width === snapshot.width && next.resizing === snapshot.resizing) return
    snapshot = next
    listeners.forEach(listener => listener())
  }
  return {
    getSnapshot: () => snapshot,
    setWidth: (next: number) => publish({ ...snapshot, width: next }),
    setResizing: (resizing: boolean) => publish({ ...snapshot, resizing }),
    setCleanup(next: (() => void) | undefined) {
      cleanup = next
    },
    cancelResize() {
      cleanup?.()
      if (collapseFrame !== null) {
        window.cancelAnimationFrame(collapseFrame)
        collapseFrame = null
      }
    },
    getCollapseFrame: () => collapseFrame,
    setCollapseFrame(frame: number | null) {
      collapseFrame = frame
    },
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
        if (listeners.size) return
        cleanup?.()
        cleanup = undefined
        if (collapseFrame !== null) {
          window.cancelAnimationFrame(collapseFrame)
          collapseFrame = null
        }
      }
    },
  }
}
