import {
  observeElementOffset,
  useVirtualizer,
  type PartialKeys,
  type ReactVirtualizer,
  type ReactVirtualizerOptions,
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
  initialContentHeightPx: number
  initialDistanceFromBottomPx: number
  positionKey?: string | number | null
  scrollElementRef?: RefObject<TScrollElement | null>
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
  initialContentHeightPx,
  initialDistanceFromBottomPx,
  positionKey,
  scrollElementRef,
  shouldAdjustScrollPositionOnItemSizeChange,
  ...options
}: VirtualizerOptions<TScrollElement, TItemElement>): ReactVirtualizer<
  TScrollElement,
  TItemElement
> {
  // TanStack Virtual requires the current element for its synchronous initial measurement.
  const scrollElement = scrollElementRef?.current ?? null
  const viewportHeight = scrollElement?.clientHeight ?? 0
  const initialOffset = Math.max(
    0,
    initialContentHeightPx - viewportHeight - initialDistanceFromBottomPx
  )
  const observeBottomOriginOffset: NonNullable<
    ReactVirtualizerOptions<TScrollElement, TItemElement>['observeElementOffset']
  > = (instance, callback) =>
    observeElementOffset(instance, (_offset, isScrolling) => {
      const element = instance.scrollElement
      callback(element ? getVirtualizerOffset(element) : 0, isScrolling)
    })
  const scrollBottomOriginToOffset: NonNullable<
    ReactVirtualizerOptions<TScrollElement, TItemElement>['scrollToFn']
  > = (offset, { adjustments = 0, behavior }, instance) => {
    const element = instance.scrollElement
    if (!element) return
    element.scrollTo({
      top: offset + adjustments - getMaximumScrollOffset(element),
      behavior,
    })
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
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange =
    shouldAdjustScrollPositionOnItemSizeChange

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

  return virtualizer
}

function getMaximumScrollOffset(element: HTMLElement): number {
  return Math.max(0, element.scrollHeight - element.clientHeight)
}

function getVirtualizerOffset(element: HTMLElement): number {
  return Math.max(0, getMaximumScrollOffset(element) + element.scrollTop)
}
