import { DEFAULT_CODE_FONT_SIZE } from '@/features/appearance/typography'
import { usePanelResizeDrag } from '../usePanelResizeDrag'
import { useDOMEvent, useWindowEvent } from '@wegent/collaboration/dom-events'
import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type PointerEvent,
  type RefObject,
} from 'react'
import { createRightSplitResizeState } from './rightSplitResizeState'

const RIGHT_SPLIT_CHAT_DEFAULT_WIDTH = 420
export const RIGHT_WORKSPACE_COMPACT_PANEL_DEFAULT_WIDTH = 420
const RIGHT_SPLIT_CHAT_MIN_WIDTH = 360
const RIGHT_SPLIT_CHAT_MAX_WIDTH = 620
export const RIGHT_SPLIT_PANEL_MIN_WIDTH = 260
const RIGHT_WORKSPACE_PANEL_WIDTH_RATIO_STORAGE_KEY =
  'wework.desktop.right-workspace.panel-width-ratio'
const RIGHT_WORKSPACE_PANEL_WIDTH_RATIO_EVENT = 'wework:right-workspace-panel-width-ratio'
const BOTTOM_DEFAULT_HEIGHT = 320
const BOTTOM_MAX_HEIGHT = 560
const BOTTOM_PANEL_BORDER_HEIGHT = 1
const BOTTOM_PANEL_TAB_BAR_HEIGHT = 40
const BOTTOM_TERMINAL_VERTICAL_PADDING = 24
const TERMINAL_LINE_HEIGHT = 1.2

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max)
}

function getRightSplitChatMaxWidth(containerWidth: number) {
  if (containerWidth <= 0) return RIGHT_SPLIT_CHAT_MAX_WIDTH

  return Math.max(RIGHT_SPLIT_CHAT_MIN_WIDTH, containerWidth - RIGHT_SPLIT_PANEL_MIN_WIDTH)
}

function getRightWorkspacePanelWidthRange(containerWidth: number) {
  const maximum = Math.max(RIGHT_SPLIT_PANEL_MIN_WIDTH, containerWidth - RIGHT_SPLIT_CHAT_MIN_WIDTH)
  return {
    minimum: Math.min(RIGHT_SPLIT_PANEL_MIN_WIDTH, maximum),
    maximum,
  }
}

function getRightSplitChatDefaultWidth(containerWidth: number, defaultPanelWidth?: number) {
  if (containerWidth <= 0) return RIGHT_SPLIT_CHAT_DEFAULT_WIDTH

  return clamp(
    defaultPanelWidth === undefined
      ? RIGHT_SPLIT_CHAT_DEFAULT_WIDTH
      : containerWidth - defaultPanelWidth,
    RIGHT_SPLIT_CHAT_MIN_WIDTH,
    getRightSplitChatMaxWidth(containerWidth)
  )
}

function getRightSplitChatWidthFromPanelRatio(containerWidth: number, ratio: number) {
  if (containerWidth <= 0) return RIGHT_SPLIT_CHAT_DEFAULT_WIDTH

  const range = getRightWorkspacePanelWidthRange(containerWidth)
  const panelWidth = range.minimum + clamp(ratio, 0, 1) * (range.maximum - range.minimum)
  return clamp(
    containerWidth - panelWidth,
    RIGHT_SPLIT_CHAT_MIN_WIDTH,
    getRightSplitChatMaxWidth(containerWidth)
  )
}

function getRightWorkspacePanelRatio(panelWidth: number, containerWidth: number) {
  const range = getRightWorkspacePanelWidthRange(containerWidth)
  const span = range.maximum - range.minimum
  if (span <= 0) return 0
  return clamp((panelWidth - range.minimum) / span, 0, 1)
}

function readStoredRightWorkspacePanelWidthRatio() {
  if (typeof window === 'undefined') return undefined

  try {
    const value = window.localStorage.getItem(RIGHT_WORKSPACE_PANEL_WIDTH_RATIO_STORAGE_KEY)
    if (!value) return undefined
    const parsed = Number(value)
    return Number.isFinite(parsed) ? clamp(parsed, 0, 1) : undefined
  } catch {
    return undefined
  }
}

function storeRightWorkspacePanelWidthRatio(ratio: number) {
  if (typeof window === 'undefined') return

  const clampedRatio = clamp(ratio, 0, 1)
  try {
    window.localStorage.setItem(RIGHT_WORKSPACE_PANEL_WIDTH_RATIO_STORAGE_KEY, String(clampedRatio))
  } catch {
    // Ignore storage failures; the in-memory resize state still updates.
  }

  window.dispatchEvent(
    new CustomEvent(RIGHT_WORKSPACE_PANEL_WIDTH_RATIO_EVENT, { detail: { ratio: clampedRatio } })
  )
}

interface ResizableRightSplitChatOptions {
  containerRef?: RefObject<HTMLElement | null>
  onCollapse?: () => void
  defaultPanelWidth?: number
}

export function useResizableRightSplitChat({
  containerRef,
  onCollapse,
  defaultPanelWidth,
}: ResizableRightSplitChatOptions = {}) {
  const [resizeState] = useState(() => createRightSplitResizeState(RIGHT_SPLIT_CHAT_DEFAULT_WIDTH))
  const { width, resizing } = useSyncExternalStore(
    resizeState.subscribe,
    resizeState.getSnapshot,
    resizeState.getSnapshot
  )
  const { setWidth, setResizing } = resizeState
  const { startResize, stopResize } = usePanelResizeDrag()
  const panelWidthRatioRef = useRef<number | undefined>(readStoredRightWorkspacePanelWidthRatio())

  useLayoutEffect(() => {
    const container = containerRef?.current
    if (!container) return

    const applyDefaultWidth = () => {
      if (resizeState.getSnapshot().resizing) return
      const containerWidth = container.getBoundingClientRect().width
      setWidth(
        defaultPanelWidth !== undefined || panelWidthRatioRef.current === undefined
          ? getRightSplitChatDefaultWidth(containerWidth, defaultPanelWidth)
          : getRightSplitChatWidthFromPanelRatio(containerWidth, panelWidthRatioRef.current)
      )
    }

    applyDefaultWidth()
    if (typeof ResizeObserver === 'undefined') return

    const observer = new ResizeObserver(applyDefaultWidth)
    observer.observe(container)
    return () => observer.disconnect()
  }, [containerRef, defaultPanelWidth, resizeState, setWidth])

  const handleStoredPanelWidthRatioChange = (event: Event) => {
    if (defaultPanelWidth !== undefined) return
    const detail = (event as CustomEvent<{ ratio?: number }>).detail
    const ratio = detail?.ratio ?? readStoredRightWorkspacePanelWidthRatio()
    if (ratio === undefined) return
    panelWidthRatioRef.current = ratio
    const containerWidth = containerRef?.current?.getBoundingClientRect().width ?? 0
    setWidth(getRightSplitChatWidthFromPanelRatio(containerWidth, ratio))
  }
  useDOMEvent('window', RIGHT_WORKSPACE_PANEL_WIDTH_RATIO_EVENT, handleStoredPanelWidthRatioChange)
  useWindowEvent('storage', handleStoredPanelWidthRatioChange)

  const handleResizeStart = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    stopResize()
    resizeState.cancelResize()
    const startX = event.clientX
    const startWidth = width
    const containerWidth = containerRef?.current?.getBoundingClientRect().width ?? 0
    const maxWidth = getRightSplitChatMaxWidth(containerWidth)
    let resizedPanelWidth = Math.max(RIGHT_SPLIT_PANEL_MIN_WIDTH, containerWidth - startWidth)
    let resized = false
    let collapsed = false

    function finishResize() {
      setResizing(false)
    }

    function collapsePanel() {
      if (collapsed) return

      collapsed = true
      stopResize()
      if (resizeState.getCollapseFrame() !== null) {
        window.cancelAnimationFrame(resizeState.getCollapseFrame()!)
      }
      const applyCollapse = () => {
        resizeState.setCollapseFrame(null)
        setWidth(
          defaultPanelWidth !== undefined || panelWidthRatioRef.current === undefined
            ? getRightSplitChatDefaultWidth(containerWidth, defaultPanelWidth)
            : getRightSplitChatWidthFromPanelRatio(containerWidth, panelWidthRatioRef.current)
        )
        onCollapse?.()
      }

      if (typeof window.requestAnimationFrame === 'function') {
        resizeState.setCollapseFrame(window.requestAnimationFrame(applyCollapse))
        return
      }

      applyCollapse()
    }

    function handleMove({ x }: { x: number }) {
      if (collapsed) return

      const rawWidth = startWidth + x - startX
      if (onCollapse && rawWidth > startWidth && rawWidth >= maxWidth) {
        collapsePanel()
        return
      }

      const nextWidth = clamp(rawWidth, RIGHT_SPLIT_CHAT_MIN_WIDTH, maxWidth)
      setWidth(nextWidth)
      resizedPanelWidth = Math.max(RIGHT_SPLIT_PANEL_MIN_WIDTH, containerWidth - nextWidth)
      resized = true
    }

    function handleUp() {
      if (collapsed) return
      if (resized && defaultPanelWidth === undefined) {
        const nextRatio = getRightWorkspacePanelRatio(resizedPanelWidth, containerWidth)
        panelWidthRatioRef.current = nextRatio
        storeRightWorkspacePanelWidthRatio(nextRatio)
      }
    }

    setResizing(true)
    startResize(event, {
      cursor: 'col-resize',
      onMove: handleMove,
      onFinish: finishResize,
      onEnd: canceled => {
        if (!canceled) handleUp()
      },
    })
  }

  return { width, resizing, handleResizeStart }
}

function getBottomPanelMinHeight(codeFontSize: number) {
  return (
    BOTTOM_PANEL_BORDER_HEIGHT +
    BOTTOM_PANEL_TAB_BAR_HEIGHT +
    BOTTOM_TERMINAL_VERTICAL_PADDING +
    Math.ceil(codeFontSize * TERMINAL_LINE_HEIGHT)
  )
}

export function useResizableBottomPanel(codeFontSize = DEFAULT_CODE_FONT_SIZE) {
  const [height, setHeight] = useState(BOTTOM_DEFAULT_HEIGHT)
  const [resizing, setResizing] = useState(false)
  const panelElementRef = useRef<HTMLElement | null>(null)
  const minimumHeight = getBottomPanelMinHeight(codeFontSize)
  const resolvedHeight = Math.max(height, minimumHeight)
  const { startResize, stopResize } = usePanelResizeDrag()

  const panelRef = useCallback((panel: HTMLElement | null) => {
    panelElementRef.current = panel
  }, [])

  const handleResizeStart = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    stopResize()
    const startY = event.clientY
    let nextHeight = resolvedHeight
    setResizing(true)
    startResize(event, {
      cursor: 'row-resize',
      onMove: ({ y }) => {
        nextHeight = clamp(resolvedHeight + startY - y, minimumHeight, BOTTOM_MAX_HEIGHT)
        if (panelElementRef.current) {
          panelElementRef.current.style.flexBasis = `${nextHeight}px`
          panelElementRef.current.style.height = `${nextHeight}px`
        }
      },
      onFinish: () => setResizing(false),
      onEnd: () => setHeight(nextHeight),
    })
  }

  return { height: resolvedHeight, resizing, panelRef, handleResizeStart }
}
