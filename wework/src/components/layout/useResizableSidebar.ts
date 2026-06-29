import { useState, type PointerEvent } from 'react'

const DEFAULT_SIDEBAR_WIDTH = 240
const MIN_SIDEBAR_WIDTH = 200
const MAX_SIDEBAR_WIDTH = 480
const COLLAPSE_SIDEBAR_WIDTH = 168
const SIDEBAR_WIDTH_STORAGE_KEY = 'wework.desktop.sidebar.width'

function clampSidebarWidth(width: number): number {
  return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, width))
}

function readStoredSidebarWidth(): number {
  if (typeof window === 'undefined') return DEFAULT_SIDEBAR_WIDTH

  const storedWidth = window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY)
  const parsedWidth = storedWidth ? Number(storedWidth) : DEFAULT_SIDEBAR_WIDTH

  if (!Number.isFinite(parsedWidth)) {
    return DEFAULT_SIDEBAR_WIDTH
  }

  return clampSidebarWidth(parsedWidth)
}

function storeSidebarWidth(width: number) {
  window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(width))
}

interface ResizableSidebarOptions {
  onCollapse?: () => void
  onResizeStateChange?: (resizing: boolean) => void
}

export function useResizableSidebar({
  onCollapse,
  onResizeStateChange,
}: ResizableSidebarOptions = {}) {
  const [sidebarWidth, setSidebarWidth] = useState(readStoredSidebarWidth)
  const [resizing, setResizing] = useState(false)

  const handleResizeStart = (event: PointerEvent<HTMLButtonElement>) => {
    event.preventDefault()
    const previousCursor = document.body.style.cursor
    const previousUserSelect = document.body.style.userSelect
    let collapsed = false

    setResizing(true)
    onResizeStateChange?.(true)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'

    const finishResize = () => {
      setResizing(false)
      onResizeStateChange?.(false)
      document.body.style.cursor = previousCursor
      document.body.style.userSelect = previousUserSelect
      document.removeEventListener('pointermove', handlePointerMove)
      document.removeEventListener('pointerup', handlePointerUp)
    }

    const handlePointerMove = (moveEvent: globalThis.PointerEvent) => {
      if (collapsed) return

      if (moveEvent.clientX <= COLLAPSE_SIDEBAR_WIDTH) {
        collapsed = true
        finishResize()
        onCollapse?.()
        return
      }

      const nextWidth = clampSidebarWidth(moveEvent.clientX)
      setSidebarWidth(nextWidth)
      storeSidebarWidth(nextWidth)
    }

    const handlePointerUp = () => {
      if (!collapsed) finishResize()
    }

    document.addEventListener('pointermove', handlePointerMove)
    document.addEventListener('pointerup', handlePointerUp)
  }

  return {
    sidebarWidth,
    resizing,
    handleResizeStart,
  }
}
