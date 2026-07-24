import { flushSync } from 'react-dom'
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { RefObject } from 'react'
import {
  cacheConversationVirtualHeights,
  getConversationVirtualHeights,
} from '@/features/workbench/runtimeConversationCache'
import {
  buildMessageVirtualLayout,
  findMeasuredViewportAnchor,
  getAnchoredDistanceFromBottom,
  getMessageVirtualRange,
  type MessageVirtualEntry,
} from './messageVirtualization'

const DEFAULT_VIEWPORT_HEIGHT_PX = 800
const PINNED_TO_BOTTOM_THRESHOLD_PX = 24

export interface MessageVirtualRow {
  index: number
  key: string
  startPx: number
}

export function useMessageVirtualizer({
  cacheKey,
  enabled,
  entries,
  forceKey,
  gapPx,
  initialDistanceFromBottomPx,
  listRef,
  overscanCount,
  paddingBottomPx,
  paddingTopPx,
  scrollElementRef,
}: {
  cacheKey: string | null
  enabled: boolean
  entries: MessageVirtualEntry[]
  forceKey: string | null
  gapPx: number
  initialDistanceFromBottomPx: number
  listRef: RefObject<HTMLDivElement | null>
  overscanCount: number
  paddingBottomPx: number
  paddingTopPx: number
  scrollElementRef: RefObject<HTMLDivElement | null>
}) {
  const initialHeights = useMemo(() => filterCachedHeights(cacheKey, entries), [cacheKey, entries])
  const [measuredHeightsByKey, setMeasuredHeightsByKey] = useState(initialHeights)
  const measuredHeightsRef = useRef(measuredHeightsByKey)
  const [viewport, setViewport] = useState(() => ({
    distanceFromBottomPx: Math.max(0, initialDistanceFromBottomPx),
    heightPx: DEFAULT_VIEWPORT_HEIGHT_PX,
  }))
  const viewportRef = useRef(viewport)
  const rowElementsRef = useRef(new Map<string, HTMLElement>())
  const elementKeysRef = useRef(new WeakMap<Element, string>())
  const rowRefCallbacksRef = useRef(new Map<string, (element: HTMLDivElement | null) => void>())
  const rowResizeObserverRef = useRef<ResizeObserver | null>(null)
  const previousCacheKeyRef = useRef(cacheKey)
  const enabledRef = useRef(enabled)
  const layoutConfigRef = useRef({
    entries,
    gapPx,
    paddingBottomPx,
    paddingTopPx,
  })

  const layout = useMemo(
    () =>
      buildMessageVirtualLayout({
        entries,
        gapPx,
        measuredHeightsByKey,
        paddingBottomPx,
        paddingTopPx,
      }),
    [entries, gapPx, measuredHeightsByKey, paddingBottomPx, paddingTopPx]
  )
  const layoutRef = useRef(layout)

  useLayoutEffect(() => {
    enabledRef.current = enabled
    layoutConfigRef.current = {
      entries,
      gapPx,
      paddingBottomPx,
      paddingTopPx,
    }
    layoutRef.current = layout
    measuredHeightsRef.current = measuredHeightsByKey
    viewportRef.current = viewport
  }, [
    enabled,
    entries,
    gapPx,
    layout,
    measuredHeightsByKey,
    paddingBottomPx,
    paddingTopPx,
    viewport,
  ])

  const updateViewport = useCallback(() => {
    if (!enabledRef.current) return
    const scrollElement = scrollElementRef.current
    const listElement = listRef.current
    if (!scrollElement || !listElement) return

    const nextViewport = measureViewportFromBottom(scrollElement, listElement)
    viewportRef.current = nextViewport
    setViewport(current =>
      current.distanceFromBottomPx === nextViewport.distanceFromBottomPx &&
      current.heightPx === nextViewport.heightPx
        ? current
        : nextViewport
    )
  }, [listRef, scrollElementRef])

  const applyMeasurements = useCallback(
    (measurements: Map<string, number>) => {
      if (!enabledRef.current) return
      if (measurements.size === 0) return

      const previousHeights = measuredHeightsRef.current
      let nextHeights = previousHeights
      for (const [key, measuredHeight] of measurements) {
        const nextHeight = Math.max(1, Math.ceil(measuredHeight))
        if (previousHeights[key] === nextHeight) continue
        if (nextHeights === previousHeights) nextHeights = { ...previousHeights }
        nextHeights[key] = nextHeight
      }
      if (nextHeights === previousHeights) return

      const previousLayout = layoutRef.current
      const currentViewport = viewportRef.current
      const {
        entries: currentEntries,
        gapPx: currentGapPx,
        paddingBottomPx: currentPaddingBottomPx,
        paddingTopPx: currentPaddingTopPx,
      } = layoutConfigRef.current
      const anchorKey = findMeasuredViewportAnchor({
        distanceFromBottomPx: currentViewport.distanceFromBottomPx,
        layout: previousLayout,
        measuredHeightsByKey: previousHeights,
        viewportHeightPx: currentViewport.heightPx,
      })
      const nextLayout = buildMessageVirtualLayout({
        entries: currentEntries,
        gapPx: currentGapPx,
        measuredHeightsByKey: nextHeights,
        paddingBottomPx: currentPaddingBottomPx,
        paddingTopPx: currentPaddingTopPx,
      })
      const targetDistanceFromBottomPx =
        anchorKey === null || currentViewport.distanceFromBottomPx <= PINNED_TO_BOTTOM_THRESHOLD_PX
          ? null
          : getAnchoredDistanceFromBottom({
              anchorKey,
              currentDistanceFromBottomPx: currentViewport.distanceFromBottomPx,
              nextLayout,
              previousLayout,
            })

      flushSync(() => {
        layoutRef.current = nextLayout
        measuredHeightsRef.current = nextHeights
        setMeasuredHeightsByKey(nextHeights)
      })

      if (targetDistanceFromBottomPx !== null) {
        restoreDistanceFromBottom(
          scrollElementRef.current,
          listRef.current,
          targetDistanceFromBottomPx
        )
      }
      updateViewport()
    },
    [listRef, scrollElementRef, updateViewport]
  )

  const observeRow = useCallback(
    (key: string, element: HTMLElement | null) => {
      if (!enabled) return
      const previousElement = rowElementsRef.current.get(key)
      if (previousElement === element) return
      if (previousElement) {
        rowResizeObserverRef.current?.unobserve(previousElement)
        rowElementsRef.current.delete(key)
      }
      if (!element) return

      rowElementsRef.current.set(key, element)
      elementKeysRef.current.set(element, key)
      rowResizeObserverRef.current?.observe(element)
      const height = element.getBoundingClientRect().height
      if (height > 0) applyMeasurements(new Map([[key, height]]))
    },
    [applyMeasurements, enabled]
  )
  const getRowRef = useCallback(
    (key: string) => {
      const existing = rowRefCallbacksRef.current.get(key)
      if (existing) return existing
      const callback = (element: HTMLDivElement | null) => {
        observeRow(key, element)
      }
      rowRefCallbacksRef.current.set(key, callback)
      return callback
    },
    [observeRow]
  )

  useLayoutEffect(() => {
    if (!enabled) return
    if (previousCacheKeyRef.current === cacheKey) return
    if (previousCacheKeyRef.current !== null) {
      cacheConversationVirtualHeights(previousCacheKeyRef.current, measuredHeightsRef.current)
    }
    previousCacheKeyRef.current = cacheKey
    const nextHeights = filterCachedHeights(cacheKey, entries)
    measuredHeightsRef.current = nextHeights
    setMeasuredHeightsByKey(nextHeights)
  }, [cacheKey, enabled, entries])

  useLayoutEffect(() => {
    if (!enabled) return
    const currentKeys = new Set(entries.map(entry => entry.key))
    for (const key of rowRefCallbacksRef.current.keys()) {
      if (!currentKeys.has(key)) rowRefCallbacksRef.current.delete(key)
    }
    const currentHeights = measuredHeightsRef.current
    if (Object.keys(currentHeights).every(key => currentKeys.has(key))) return

    const nextHeights = Object.fromEntries(
      Object.entries(currentHeights).filter(([key]) => currentKeys.has(key))
    )
    measuredHeightsRef.current = nextHeights
    setMeasuredHeightsByKey(nextHeights)
  }, [enabled, entries])

  useLayoutEffect(() => {
    if (!enabled) return
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(entries => {
      const measurements = new Map<string, number>()
      for (const entry of entries) {
        const key = elementKeysRef.current.get(entry.target)
        if (key === undefined) continue
        const height = resizeObserverHeight(entry)
        if (height > 0) measurements.set(key, height)
      }
      applyMeasurements(measurements)
    })
    rowResizeObserverRef.current = observer
    for (const element of rowElementsRef.current.values()) observer.observe(element)
    return () => {
      observer.disconnect()
      rowResizeObserverRef.current = null
    }
  }, [applyMeasurements, enabled])

  useLayoutEffect(() => {
    if (!enabled) return
    const scrollElement = scrollElementRef.current
    if (!scrollElement) return

    let frame: number | null = null
    const scheduleViewportUpdate = () => {
      if (frame !== null) return
      frame = window.requestAnimationFrame(() => {
        frame = null
        updateViewport()
      })
    }
    const resizeObserver =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(scheduleViewportUpdate)
    resizeObserver?.observe(scrollElement)
    scrollElement.addEventListener('scroll', scheduleViewportUpdate, { passive: true })
    updateViewport()
    return () => {
      scrollElement.removeEventListener('scroll', scheduleViewportUpdate)
      resizeObserver?.disconnect()
      if (frame !== null) window.cancelAnimationFrame(frame)
    }
  }, [enabled, scrollElementRef, updateViewport])

  useLayoutEffect(() => {
    if (!enabled) return
    updateViewport()
  }, [enabled, layout.totalHeightPx, updateViewport])

  useLayoutEffect(
    () => () => {
      const previousCacheKey = previousCacheKeyRef.current
      if (previousCacheKey !== null) {
        cacheConversationVirtualHeights(previousCacheKey, measuredHeightsRef.current)
      }
    },
    []
  )

  const range = getMessageVirtualRange({
    distanceFromBottomPx: viewport.distanceFromBottomPx,
    layout,
    overscanCount,
    viewportHeightPx: viewport.heightPx,
  })
  const indexes = Array.from(
    { length: Math.max(0, range.endIndex - range.startIndex) },
    (_, offset) => range.startIndex + offset
  )
  const forcedIndex = forceKey === null ? undefined : layout.indexByKey.get(forceKey)
  if (forcedIndex !== undefined && !indexes.includes(forcedIndex)) {
    indexes.push(forcedIndex)
    indexes.sort((left, right) => left - right)
  }

  return {
    getRowRef,
    layout,
    rows: indexes.flatMap<MessageVirtualRow>(index => {
      const key = layout.keys[index]
      const startPx = layout.topOffsetsPx[index]
      return key === undefined || startPx === undefined ? [] : [{ index, key, startPx }]
    }),
  }
}

function filterCachedHeights(
  cacheKey: string | null,
  entries: MessageVirtualEntry[]
): Record<string, number> {
  if (cacheKey === null) return {}
  const cachedHeights = getConversationVirtualHeights(cacheKey)
  if (!cachedHeights) return {}
  const keys = new Set(entries.map(entry => entry.key))
  return Object.fromEntries(Object.entries(cachedHeights).filter(([key]) => keys.has(key)))
}

function measureViewportFromBottom(
  scrollElement: HTMLElement,
  listElement: HTMLElement
): { distanceFromBottomPx: number; heightPx: number } {
  const scrollRect = scrollElement.getBoundingClientRect()
  const listRect = listElement.getBoundingClientRect()
  const viewportStartPx = Math.max(0, scrollRect.top - listRect.top)
  const viewportEndPx = Math.max(
    viewportStartPx,
    Math.min(listRect.height, scrollRect.bottom - listRect.top)
  )
  return {
    distanceFromBottomPx: Math.max(0, listRect.height - viewportEndPx),
    heightPx: Math.max(0, viewportEndPx - viewportStartPx) || scrollElement.clientHeight,
  }
}

function restoreDistanceFromBottom(
  scrollElement: HTMLElement | null,
  listElement: HTMLElement | null,
  targetDistanceFromBottomPx: number
) {
  if (!scrollElement || !listElement) return
  const currentDistanceFromBottomPx = measureViewportFromBottom(
    scrollElement,
    listElement
  ).distanceFromBottomPx
  scrollElement.scrollTop += currentDistanceFromBottomPx - targetDistanceFromBottomPx
}

function resizeObserverHeight(entry: ResizeObserverEntry): number {
  const borderBoxSize = entry.borderBoxSize
  if (Array.isArray(borderBoxSize) && borderBoxSize.length > 0) {
    return borderBoxSize[0]?.blockSize ?? entry.contentRect.height
  }
  return entry.target.getBoundingClientRect().height
}
