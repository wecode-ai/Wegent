const PAGE_ZOOM_KEYS = new Set(['+', '=', '-', '0'])

export function installPageZoomGuard(target: Document = document): () => void {
  const preventKeyboardZoom = (event: KeyboardEvent) => {
    if ((event.ctrlKey || event.metaKey) && PAGE_ZOOM_KEYS.has(event.key)) {
      event.preventDefault()
    }
  }
  const preventWheelZoom = (event: WheelEvent) => {
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault()
    }
  }
  const preventGestureZoom: EventListener = event => {
    event.preventDefault()
  }

  target.addEventListener('keydown', preventKeyboardZoom)
  target.addEventListener('wheel', preventWheelZoom, { passive: false })
  target.addEventListener('gesturestart', preventGestureZoom, {
    passive: false,
  })
  target.addEventListener('gesturechange', preventGestureZoom, {
    passive: false,
  })

  return () => {
    target.removeEventListener('keydown', preventKeyboardZoom)
    target.removeEventListener('wheel', preventWheelZoom)
    target.removeEventListener('gesturestart', preventGestureZoom)
    target.removeEventListener('gesturechange', preventGestureZoom)
  }
}
