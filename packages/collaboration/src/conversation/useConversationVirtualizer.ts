import {
  elementScroll,
  useVirtualizer,
  type Virtualizer,
  type VirtualizerOptions,
} from '@tanstack/react-virtual'
import { useEffect, useLayoutEffect, useState, type RefObject } from 'react'
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
  const [viewportReady, setViewportReady] = useState(
    () => (scrollElementRef?.current?.clientHeight ?? 0) > 0
  )
  // A hidden pane has no scroll range and cannot establish an initial offset.
  const enabled = options.enabled && viewportReady
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer<HTMLDivElement, HTMLElement>({
    ...options,
    enabled,
    scrollMargin: prefix,
    paddingEnd: (options.paddingEnd ?? 0) + scrollTailHeight,
    getScrollElement: () => scrollElementRef?.current ?? null,
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
      onScrollAdjustment?.((element?.scrollTop ?? before) - before)
    },
  })

  useLayoutEffect(() => {
    if (virtualizerRef) virtualizerRef.current = enabled ? virtualizer : null
    return () => {
      virtualizer.cancelScroll()
      if (virtualizerRef?.current === virtualizer) virtualizerRef.current = null
    }
  }, [enabled, virtualizer, virtualizerRef])

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
      setViewportReady(ready => ready || viewport.clientHeight > 0)
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
