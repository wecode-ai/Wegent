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
  bottomOriginAppendOnlyItemKeys?: ReadonlySet<string | number | bigint>
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
  bottomOriginAppendOnlyItemKeys,
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
        if (
          !element ||
          element.scrollTop >= -0.5 ||
          delta <= 0 ||
          !bottomOriginAppendOnlyItemKeys?.has(item.key)
        ) {
          return false
        }

        const offset = getVirtualizerOffset(instance, element)
        if (item.start < offset) {
          const itemElement = instance.elementsCache.get(item.key)
          const listElement = itemElement?.parentElement
          if (listElement instanceof HTMLElement) {
            const currentHeight =
              Number.parseFloat(listElement.style.height) ||
              listElement.getBoundingClientRect().height
            listElement.style.height = `${Math.max(0, currentHeight + delta)}px`
          }
          element.scrollTop -= delta
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
  return Math.min(
    getVirtualizerMaximumOffset(instance, element),
    Math.max(0, getVirtualizerMaximumOffset(instance, element) + element.scrollTop)
  )
}
