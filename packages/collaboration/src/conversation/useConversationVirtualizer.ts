import {
  elementScroll,
  measureElement,
  observeElementOffset,
  useVirtualizer,
  type Virtualizer,
  type VirtualizerOptions,
} from '@tanstack/react-virtual'
import {
  useCallback,
  useState,
  useSyncExternalStore,
  useLayoutEffect,
  useRef,
  type RefObject,
} from 'react'
import {
  CONVERSATION_SCROLL_WRITE_SOURCE,
  observeConversationScrollWrites,
  recordConversationScrollWrite,
  SCROLLBAR_DRAG_POSITION_EVENT,
} from './conversationScrollWrite'

export type ConversationVirtualizer = Virtualizer<HTMLDivElement, HTMLElement>

interface Options extends Omit<
  VirtualizerOptions<HTMLDivElement, HTMLElement>,
  | 'getScrollElement'
  | 'observeElementRect'
  | 'observeElementOffset'
  | 'scrollToFn'
  | 'initialOffset'
> {
  scrollElementRef?: RefObject<HTMLDivElement | null>
  listRef: RefObject<HTMLDivElement | null>
  virtualizerRef?: RefObject<ConversationVirtualizer | null>
  initialDistanceFromBottomPx: number
  onScrollAdjustment?: (delta: number) => void
  scrollTailHeight?: number
}

/** Normal DOM coordinates. The list sizer excludes chrome already present in flow. */
export function useConversationVirtualizer({
  scrollElementRef,
  listRef,
  virtualizerRef,
  initialDistanceFromBottomPx,
  onScrollAdjustment,
  scrollTailHeight = 0,
  ...options
}: Options) {
  const [measurements] = useState(createListMeasurements)
  const subscribeMeasurements = useCallback(
    (listener: () => void) => measurements.subscribe(listener, listRef, scrollElementRef),
    [measurements, listRef, scrollElementRef]
  )
  const { prefix, viewportReady } = useSyncExternalStore(
    options.enabled ? subscribeMeasurements : noMeasurements,
    measurements.getSnapshot,
    () => EMPTY_MEASUREMENTS
  )
  const readOffsetRef = useRef<((offset: number) => void) | null>(null)
  // A hidden pane has no scroll range and cannot establish an initial offset.
  const enabled = options.enabled && viewportReady
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer<HTMLDivElement, HTMLElement>({
    // Row measurements may compensate scroll and commit new layout synchronously.
    // Keep those writes together, outside the browser's ResizeObserver delivery.
    useAnimationFrameWithResizeObserver: true,
    useScrollendEvent: true,
    ...options,
    enabled,
    scrollMargin: prefix,
    paddingEnd: (options.paddingEnd ?? 0) + scrollTailHeight,
    getScrollElement: () => scrollElementRef?.current ?? null,
    measureElement: (element, entry, instance) => {
      const viewport = instance.scrollElement
      // External scroll writes can precede native event delivery and row measurements.
      if (viewport && viewport.scrollTop !== instance.scrollOffset)
        readOffsetRef.current?.(viewport.scrollTop)
      return (options.measureElement ?? measureElement)(element, entry, instance)
    },
    observeElementOffset: (instance, callback) => {
      let acknowledgedOffset: number | undefined
      const acknowledge = (offset: number) => {
        if (acknowledgedOffset === offset) return
        acknowledgedOffset = offset
        callback(offset, false)
      }
      readOffsetRef.current = acknowledge
      const dispose = observeElementOffset(instance, (offset, scrolling) => {
        // A native echo of an instant write must not start another scroll cycle.
        if (acknowledgedOffset === offset) return
        acknowledgedOffset = undefined
        callback(offset, scrolling)
      })
      const element = instance.scrollElement
      const updateDragOffset = () => {
        acknowledgedOffset = undefined
        if (element) callback(element.scrollTop, true)
      }
      element?.addEventListener(SCROLLBAR_DRAG_POSITION_EVENT, updateDragOffset)
      const stopObservingWrites = element
        ? observeConversationScrollWrites(element, acknowledge)
        : undefined
      return () => {
        readOffsetRef.current = null
        element?.removeEventListener(SCROLLBAR_DRAG_POSITION_EVENT, updateDragOffset)
        stopObservingWrites?.()
        dispose?.()
      }
    },
    initialOffset: () =>
      Math.max(
        0,
        Array.from({ length: options.count }, (_, index) => options.estimateSize(index)).reduce(
          (sum, size) => sum + size,
          (options.paddingStart ?? 0) + Math.max(0, options.count - 1) * (options.gap ?? 0)
        ) +
          (options.paddingEnd ?? 0) +
          scrollTailHeight +
          prefix -
          (scrollElementRef?.current?.clientHeight ?? 0) -
          initialDistanceFromBottomPx
      ),
    scrollToFn: (offset, settings, instance) => {
      const element = instance.scrollElement
      const before = element?.scrollTop ?? 0
      if (element)
        recordConversationScrollWrite(
          element,
          CONVERSATION_SCROLL_WRITE_SOURCE.virtualizerOffset,
          offset + (settings.adjustments ?? 0),
          () => elementScroll(offset, settings, instance)
        )
      const after = element?.scrollTop ?? before
      // Attribute our write before offset observers can synchronously restore a reader anchor.
      onScrollAdjustment?.(after - before)
      // Instant writes have already landed. A native scroll event can be delayed
      // or absent, so acknowledge the actual offset before the next commit.
      if (element && settings.behavior !== 'smooth') readOffsetRef.current?.(after)
    },
  })

  useLayoutEffect(() => {
    if (virtualizerRef) virtualizerRef.current = enabled ? virtualizer : null
    return () => {
      virtualizer.cancelScroll()
      if (virtualizerRef?.current === virtualizer) virtualizerRef.current = null
    }
  }, [enabled, virtualizer, virtualizerRef])

  return {
    virtualizer,
    tailHeight: scrollTailHeight,
    scrollMargin: prefix,
    viewportReady,
  }
}

const EMPTY_MEASUREMENTS = { prefix: 0, viewportReady: false }
const noMeasurements = () => () => {}

function createListMeasurements() {
  let snapshot = { prefix: 0, viewportReady: false }
  let previousList: HTMLDivElement | null = null
  let previousViewport: HTMLDivElement | null = null
  return {
    getSnapshot: () => snapshot,
    subscribe(
      listener: () => void,
      listRef: RefObject<HTMLDivElement | null>,
      scrollRef?: RefObject<HTMLDivElement | null>
    ) {
      const list = listRef.current
      const viewport = scrollRef?.current
      if (!list || !viewport || !viewport.contains(list)) {
        previousList = null
        previousViewport = null
        if (snapshot.prefix !== 0 || snapshot.viewportReady) {
          snapshot = { prefix: 0, viewportReady: false }
          listener()
        }
        return () => {}
      }
      let active = true
      let resetReadiness = list !== previousList || viewport !== previousViewport
      previousList = list
      previousViewport = viewport
      const update = () => {
        if (!active) return
        const prefix = Math.max(
          0,
          Math.round(
            list.getBoundingClientRect().top -
              viewport.getBoundingClientRect().top +
              viewport.scrollTop
          )
        )
        const viewportReady =
          (!resetReadiness && snapshot.viewportReady) || viewport.clientHeight > 0
        resetReadiness = false
        if (prefix === snapshot.prefix && viewportReady === snapshot.viewportReady) return
        snapshot = { prefix, viewportReady }
        listener()
      }
      update()
      const observer = new ResizeObserver(update)
      observer.observe(viewport)
      for (
        let node: HTMLElement | null = list;
        node && node !== viewport;
        node = node.parentElement
      ) {
        observer.observe(node)
        if (node.nextElementSibling) observer.observe(node.nextElementSibling)
      }
      return () => {
        active = false
        observer.disconnect()
      }
    },
  }
}
