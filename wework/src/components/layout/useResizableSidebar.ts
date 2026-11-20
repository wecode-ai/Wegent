import { useState, type PointerEvent } from 'react'
import { usePanelResizeDrag } from './usePanelResizeDrag'

const DEFAULT_SIDEBAR_WIDTH = 240
const MIN_SIDEBAR_WIDTH = 240
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
  const { startResize, stopResize } = usePanelResizeDrag()

  const handleResizeStart = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return
    stopResize()
    setResizing(true)
    onResizeStateChange?.(true)
    startResize(event, {
      cursor: 'col-resize',
      onFinish: () => {
        setResizing(false)
        onResizeStateChange?.(false)
      },
      onMove: ({ x }) => {
        if (x <= COLLAPSE_SIDEBAR_WIDTH) {
          stopResize()
          onCollapse?.()
          return
        }
        const nextWidth = clampSidebarWidth(x)
        setSidebarWidth(nextWidth)
        storeSidebarWidth(nextWidth)
      },
    })
  }

  return {
    sidebarWidth,
    resizing,
    handleResizeStart,
  }
}
