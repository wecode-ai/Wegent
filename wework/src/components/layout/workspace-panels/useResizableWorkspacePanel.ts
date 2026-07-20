import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent,
  type RefObject,
} from 'react'

const RIGHT_SPLIT_CHAT_DEFAULT_WIDTH = 420
const RIGHT_SPLIT_CHAT_MIN_WIDTH = 360
const RIGHT_SPLIT_CHAT_MAX_WIDTH = 620
const RIGHT_SPLIT_PANEL_COLLAPSE_WIDTH = 260
const BOTTOM_DEFAULT_HEIGHT = 320
const BOTTOM_MIN_HEIGHT = 220
const BOTTOM_MAX_HEIGHT = 560

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max)
}

function getRightSplitChatMaxWidth(containerWidth: number) {
  if (containerWidth <= 0) return RIGHT_SPLIT_CHAT_MAX_WIDTH

  return Math.max(RIGHT_SPLIT_CHAT_MIN_WIDTH, containerWidth - RIGHT_SPLIT_PANEL_COLLAPSE_WIDTH)
}

function getRightSplitChatDefaultWidth(containerWidth: number) {
  if (containerWidth <= 0) return RIGHT_SPLIT_CHAT_DEFAULT_WIDTH

  return clamp(
    RIGHT_SPLIT_CHAT_DEFAULT_WIDTH,
    RIGHT_SPLIT_CHAT_MIN_WIDTH,
    getRightSplitChatMaxWidth(containerWidth)
  )
}

interface ResizableRightSplitChatOptions {
  containerRef?: RefObject<HTMLElement | null>
  onCollapse?: () => void
}

export function useResizableRightSplitChat({
  containerRef,
  onCollapse,
}: ResizableRightSplitChatOptions = {}) {
  const [width, setWidth] = useState(RIGHT_SPLIT_CHAT_DEFAULT_WIDTH)
  const [resizing, setResizing] = useState(false)
  const collapseFrameRef = useRef<number | null>(null)
  const userSizedRef = useRef(false)

  useLayoutEffect(() => {
    const container = containerRef?.current
    if (!container) return

    const applyDefaultWidth = () => {
      if (userSizedRef.current) return
      setWidth(getRightSplitChatDefaultWidth(container.getBoundingClientRect().width))
    }

    applyDefaultWidth()
    if (typeof ResizeObserver === 'undefined') return

    const observer = new ResizeObserver(applyDefaultWidth)
    observer.observe(container)
    return () => observer.disconnect()
  }, [containerRef])

  useEffect(() => {
    return () => {
      if (collapseFrameRef.current === null) return
      window.cancelAnimationFrame(collapseFrameRef.current)
    }
  }, [])

  const handleResizeStart = (event: PointerEvent<HTMLDivElement>) => {
    event.preventDefault()

    const startX = event.clientX
    const startWidth = width
    const containerWidth = containerRef?.current?.getBoundingClientRect().width ?? 0
    const maxWidth = getRightSplitChatMaxWidth(containerWidth)
    let collapsed = false
    userSizedRef.current = true

    function finishResize() {
      document.removeEventListener('pointermove', handleMove)
      document.removeEventListener('pointerup', handleUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      setResizing(false)
    }

    function collapsePanel() {
      if (collapsed) return

      collapsed = true
      finishResize()
      if (collapseFrameRef.current !== null) {
        window.cancelAnimationFrame(collapseFrameRef.current)
      }
      const applyCollapse = () => {
        collapseFrameRef.current = null
        userSizedRef.current = false
        setWidth(getRightSplitChatDefaultWidth(containerWidth))
        onCollapse?.()
      }

      if (typeof window.requestAnimationFrame === 'function') {
        collapseFrameRef.current = window.requestAnimationFrame(applyCollapse)
        return
      }

      applyCollapse()
    }

    function handleMove(moveEvent: globalThis.PointerEvent) {
      if (collapsed) return

      const rawWidth = startWidth + moveEvent.clientX - startX
      if (onCollapse && rawWidth > startWidth && rawWidth >= maxWidth) {
        collapsePanel()
        return
      }

      const nextWidth = clamp(rawWidth, RIGHT_SPLIT_CHAT_MIN_WIDTH, maxWidth)
      setWidth(nextWidth)
    }

    function handleUp() {
      if (!collapsed) finishResize()
    }

    setResizing(true)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    document.addEventListener('pointermove', handleMove)
    document.addEventListener('pointerup', handleUp)
  }

  return { width, resizing, handleResizeStart }
}

export function useResizableBottomPanel() {
  const [height, setHeight] = useState(BOTTOM_DEFAULT_HEIGHT)
  const [resizing, setResizing] = useState(false)
  const panelRef = useRef<HTMLElement | null>(null)
  const resizeFrameRef = useRef<number | null>(null)
  const activeResizeCleanupRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    return () => {
      activeResizeCleanupRef.current?.()
      if (resizeFrameRef.current !== null) {
        window.cancelAnimationFrame(resizeFrameRef.current)
      }
    }
  }, [])

  const handleResizeStart = (event: PointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    activeResizeCleanupRef.current?.()

    const resizeHandle = event.currentTarget
    if (typeof resizeHandle.setPointerCapture === 'function') {
      try {
        resizeHandle.setPointerCapture(event.pointerId)
      } catch {
        // Synthetic verification events do not create an active browser pointer.
      }
    }

    const startY = event.clientY
    const startHeight = height
    let nextHeight = startHeight

    const applyHeight = () => {
      resizeFrameRef.current = null
      if (panelRef.current) {
        panelRef.current.style.height = `${nextHeight}px`
      }
    }

    const handleMove = (moveEvent: globalThis.PointerEvent) => {
      nextHeight = clamp(
        startHeight + startY - moveEvent.clientY,
        BOTTOM_MIN_HEIGHT,
        BOTTOM_MAX_HEIGHT
      )
      if (resizeFrameRef.current !== null) return

      resizeFrameRef.current = window.requestAnimationFrame(applyHeight)
    }

    const cleanupResize = () => {
      document.removeEventListener('pointermove', handleMove)
      document.removeEventListener('pointerup', handleUp)
      document.removeEventListener('pointercancel', handleCancel)
      if (resizeFrameRef.current !== null) {
        window.cancelAnimationFrame(resizeFrameRef.current)
        resizeFrameRef.current = null
      }
      if (resizeHandle.hasPointerCapture?.(event.pointerId)) {
        resizeHandle.releasePointerCapture(event.pointerId)
      }
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      activeResizeCleanupRef.current = null
    }

    const finishResize = () => {
      cleanupResize()
      if (panelRef.current) {
        panelRef.current.style.height = `${nextHeight}px`
      }
      setHeight(nextHeight)
      setResizing(false)
    }

    const handleUp = () => finishResize()
    const handleCancel = () => finishResize()

    setResizing(true)
    document.body.style.cursor = 'row-resize'
    document.body.style.userSelect = 'none'
    document.addEventListener('pointermove', handleMove)
    document.addEventListener('pointerup', handleUp)
    document.addEventListener('pointercancel', handleCancel)
    activeResizeCleanupRef.current = cleanupResize
  }

  return { height, resizing, panelRef, handleResizeStart }
}
