import {
  observeElementOffset,
  useVirtualizer,
  type PartialKeys,
  type ReactVirtualizer,
  type ReactVirtualizerOptions,
  type Virtualizer,
} from '@tanstack/react-virtual'
import { useLayoutEffect, useRef } from 'react'
import type { RefObject } from 'react'

const UNINITIALIZED_POSITION = Symbol('uninitialized-bottom-origin-position')

type VirtualizerOptions<TScrollElement extends HTMLElement, TItemElement extends Element> = Omit<
  PartialKeys<
    ReactVirtualizerOptions<TScrollElement, TItemElement>,
    'observeElementRect' | 'observeElementOffset' | 'scrollToFn'
  >,
  'getScrollElement' | 'initialOffset' | 'initialRect'
> & {
  bottomOrigin: boolean
  bottomOriginAnchorItemKeys?: ReadonlySet<string | number | bigint>
  initialContentHeightPx: number
  initialDistanceFromBottomPx: number
  positionKey?: string | number | null
  preserveBottomOriginItemResizeAnchor?: boolean
  scrollElementRef?: RefObject<TScrollElement | null>
  /**
   * Reports that a row was re-measured. A re-measured row changes the content under the reader without
   * changing the scroller's own box, so it never reaches the scroll owner through its ResizeObserver;
   * this is how the owner gets to re-measure the reader's position for it.
   */
  onItemSizeChange?: () => void
  shouldAdjustScrollPositionOnItemSizeChange?: ReactVirtualizer<
    TScrollElement,
    TItemElement
  >['shouldAdjustScrollPositionOnItemSizeChange']
}

export function useBottomOriginVirtualizer<
  TScrollElement extends HTMLElement,
  TItemElement extends Element,
>({
  bottomOrigin,
  bottomOriginAnchorItemKeys,
  initialContentHeightPx,
  initialDistanceFromBottomPx,
  positionKey,
  preserveBottomOriginItemResizeAnchor = false,
  scrollElementRef,
  onItemSizeChange,
  shouldAdjustScrollPositionOnItemSizeChange,
  ...options
}: VirtualizerOptions<TScrollElement, TItemElement>): ReactVirtualizer<
  TScrollElement,
  TItemElement
> {
  const observedOffsetCallbackRef = useRef<((offset: number, isScrolling: boolean) => void) | null>(
    null
  )
  // TanStack Virtual requires the current element for its synchronous initial measurement.
  const scrollElement = scrollElementRef?.current ?? null
  const viewportHeight = scrollElement?.clientHeight ?? 0
  const initialOffset = Math.max(
    0,
    initialContentHeightPx - viewportHeight - initialDistanceFromBottomPx
  )
  const observeBottomOriginOffset: NonNullable<
    ReactVirtualizerOptions<TScrollElement, TItemElement>['observeElementOffset']
  > = (instance, callback) => {
    observedOffsetCallbackRef.current = callback
    const cleanup = observeElementOffset(instance, (_offset, isScrolling) => {
      const element = instance.scrollElement
      const offset = element ? getVirtualizerOffset(instance, element) : 0
      callback(offset, isScrolling)
    })
    return () => {
      if (observedOffsetCallbackRef.current === callback) {
        observedOffsetCallbackRef.current = null
      }
      cleanup?.()
    }
  }
  const scrollBottomOriginToOffset: NonNullable<
    ReactVirtualizerOptions<TScrollElement, TItemElement>['scrollToFn']
  > = (offset, { adjustments = 0, behavior }, instance) => {
    const element = instance.scrollElement
    if (!element) return
    const maximumOffset = getVirtualizerMaximumOffset(instance, element)
    const targetOffset = Math.min(maximumOffset, Math.max(0, offset + adjustments))
    const distanceFromBottom = maximumOffset - targetOffset
    element.scrollTo({
      top: distanceFromBottom === 0 ? 0 : -distanceFromBottom,
      behavior,
    })
    if (behavior !== 'smooth') {
      observedOffsetCallbackRef.current?.(targetOffset, false)
    }
  }

  // TanStack Virtual owns mutable measurement callbacks that React Compiler must not memoize.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer<TScrollElement, TItemElement>(
    bottomOrigin
      ? {
          ...options,
          getScrollElement: () => scrollElementRef?.current ?? null,
          initialOffset,
          initialRect: {
            width: scrollElement?.clientWidth ?? 0,
            height: viewportHeight,
          },
          anchorTo: 'start',
          followOnAppend: false,
          observeElementOffset: observeBottomOriginOffset,
          scrollToFn: scrollBottomOriginToOffset,
        }
      : {
          ...options,
          getScrollElement: () => scrollElementRef?.current ?? null,
          initialOffset,
          initialRect: {
            width: scrollElement?.clientWidth ?? 0,
            height: viewportHeight,
          },
        }
  )
  // TanStack exposes this policy as a mutable instance callback rather than an option.
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = bottomOrigin
    ? (item, delta, instance) => {
        const element = instance.scrollElement
        if (element && element.scrollTop < -0.5 && delta !== 0) {
          const preserveAnchor =
            preserveBottomOriginItemResizeAnchor &&
            delta > 0 &&
            bottomOriginAnchorItemKeys?.has(item.key) === true
          if (preserveAnchor) {
            const offset = getVirtualizerOffset(instance, element)
            if (item.start < offset) {
              // The streaming row is the last one, so nothing underneath it absorbs its growth: the
              // extra height pushes the whole history up under the reader. This is the same correction
              // `ScrollableMessageArea` applies after a layout change, but it has to happen here and
              // now: the commit that grew the row runs before the frame's paint, while a ResizeObserver
              // correction would only land in the next frame and show a one-frame jump.
              // Grow the spacer with the row so the offset can be shifted without the scroller
              // clamping at the end of the history. The shift is deliberately not reported to the
              // scroll owner: it is the same offset movement the scroller performs by itself for this
              // height change, and the owner already leaves that movement out of the reader's own
              // scrolling.
              const itemElement = instance.elementsCache.get(item.key)
              const listElement = itemElement?.parentElement
              if (listElement instanceof HTMLElement) {
                const currentHeight =
                  Number.parseFloat(listElement.style.height) ||
                  listElement.getBoundingClientRect().height
                listElement.style.height = `${Math.max(0, currentHeight + delta)}px`
              }
              element.scrollTop -= delta
              return false
            }
          }
          // Everything else (a whole-list reflow, a re-measured row above or below the viewport) is left
          // to the scroll owner, which measures how far the text under the reader actually moved once the
          // layout lands. Unlike a box resize this never reaches its ResizeObserver, so the owner is told
          // here, in the same frame as the measurement, rather than a frame later.
          onItemSizeChange?.()
        }
        return false
      }
    : shouldAdjustScrollPositionOnItemSizeChange

  const normalizedPositionKeyRef = useRef<string | number | null | typeof UNINITIALIZED_POSITION>(
    UNINITIALIZED_POSITION
  )
  useLayoutEffect(() => {
    if (!bottomOrigin || normalizedPositionKeyRef.current === positionKey) return
    const element = scrollElementRef?.current
    if (!element) return

    normalizedPositionKeyRef.current = positionKey ?? null
    const distanceFromBottom = Math.max(0, initialDistanceFromBottomPx)
    element.scrollTop = distanceFromBottom === 0 ? 0 : -distanceFromBottom
  }, [bottomOrigin, initialDistanceFromBottomPx, positionKey, scrollElementRef])

  const virtualTotalSize = virtualizer.getTotalSize()
  useLayoutEffect(() => {
    if (!bottomOrigin) return
    const element = scrollElementRef?.current
    const callback = observedOffsetCallbackRef.current
    if (!element || !callback) return

    const offset = getVirtualizerOffset(virtualizer, element)
    callback(offset, false)
  }, [
    bottomOrigin,
    options.count,
    positionKey,
    scrollElementRef,
    virtualTotalSize,
    virtualizer,
    viewportHeight,
  ])

  return virtualizer
}

function getVirtualizerMaximumOffset<
  TScrollElement extends HTMLElement,
  TItemElement extends Element,
>(instance: Virtualizer<TScrollElement, TItemElement>, element: TScrollElement): number {
  return Math.max(0, instance.getTotalSize() - element.clientHeight)
}

function getVirtualizerOffset<TScrollElement extends HTMLElement, TItemElement extends Element>(
  instance: Virtualizer<TScrollElement, TItemElement>,
  element: TScrollElement
): number {
  const maximumOffset = getVirtualizerMaximumOffset(instance, element)
  return Math.min(maximumOffset, Math.max(0, maximumOffset + element.scrollTop))
}
