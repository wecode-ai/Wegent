import {
  elementScroll,
  observeElementOffset,
  useVirtualizer,
  type Virtualizer,
  type VirtualizerOptions,
} from '@tanstack/react-virtual'
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import {
  CONVERSATION_SCROLL_WRITE_SOURCE,
  recordConversationScrollWrite,
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
  const [prefix, setPrefix] = useState(0)
  const readOffsetRef = useRef<((offset: number, scrolling: boolean) => void) | null>(null)
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer<HTMLDivElement, HTMLElement>({
    ...options,
    scrollMargin: prefix,
    paddingEnd: (options.paddingEnd ?? 0) + scrollTailHeight,
    getScrollElement: () => scrollElementRef?.current ?? null,
    observeElementOffset: (instance, callback) => {
      readOffsetRef.current = callback
      const dispose = observeElementOffset(instance, callback)
      return () => {
        readOffsetRef.current = null
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
      // A clamped no-op write emits no native scroll event. Without its read-back,
      // the engine can retain an estimated offset beyond a short conversation.
      if (
        element &&
        settings.behavior !== 'smooth' &&
        after === before &&
        Math.abs(after - offset - (settings.adjustments ?? 0)) > 1
      )
        readOffsetRef.current?.(after, false)
      onScrollAdjustment?.(after - before)
    },
  })

  useLayoutEffect(() => {
    if (virtualizerRef) virtualizerRef.current = options.enabled ? virtualizer : null
    return () => {
      virtualizer.cancelScroll()
      if (virtualizerRef?.current === virtualizer) virtualizerRef.current = null
    }
  }, [options.enabled, virtualizer, virtualizerRef])

  useEffect(() => {
    const list = listRef.current
    const viewport = scrollElementRef?.current
    if (!list || !viewport || !viewport.contains(list) || !options.enabled) return
    const update = () => {
      const rect = list.getBoundingClientRect()
      const prefix = Math.max(
        0,
        Math.round(rect.top - viewport.getBoundingClientRect().top + viewport.scrollTop)
      )
      setPrefix(prefix)
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
    return () => observer.disconnect()
  }, [listRef, options.enabled, scrollElementRef])
  return { virtualizer, tailHeight: scrollTailHeight, scrollMargin: prefix }
}
