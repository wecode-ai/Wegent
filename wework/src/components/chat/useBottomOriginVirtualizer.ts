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
import { scrollDiag } from './scrollDiagnostics'

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
  /**
   * Reports a scroll offset this hook wrote by itself, so the scroll owner can keep telling the
   * reader's own scrolling apart from the correction it already applied.
   */
  onScrollOffsetWrite?: (amount: number) => void
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
  onScrollOffsetWrite,
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
    // TEMP-DIAG (WORK-447): the virtualizer's own scroll writer.
    scrollDiag(
      `VDISPATCH offset=${Math.round(offset)} adjustments=${Math.round(adjustments)} target=${Math.round(targetOffset)} d=${Math.round(distanceFromBottom)} behavior=${String(behavior)}`,
      true
    )
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
        if (!element) return false
        const offset = getVirtualizerOffset(instance, element)
        const streamingRow = bottomOriginAppendOnlyItemKeys?.has(item.key) === true
        if (element.scrollTop < -0.5 && Math.abs(delta) >= 0.5) {
          scrollDiag(
            `ITEM-SIZE key=${String(item.key)} start=${Math.round(item.start)} end=${Math.round(item.start + (item.size ?? 0))} delta=${Math.round(delta)} streaming=${streamingRow} offset=${Math.round(offset)} client=${element.clientHeight} scrollTop=${Math.round(element.scrollTop)}`,
            true
          )
        }
        if (element.scrollTop >= -0.5 || delta === 0) return false
        if (streamingRow && delta > 0 && item.start < offset) {
          // The streaming row is the last one, so nothing underneath it absorbs its growth: the
          // extra height pushes the whole history up under the reader. This is the same correction
          // `ScrollableMessageArea` applies after a layout change, but it has to happen here and
          // now: the commit that grew the row runs before the frame's paint, while a ResizeObserver
          // correction would only land in the next frame and show a one-frame jump.
          // Grow the spacer with the row so the offset can be shifted without the scroller
          // clamping at the end of the history.
          const itemElement = instance.elementsCache.get(item.key)
          const listElement = itemElement?.parentElement
          if (listElement instanceof HTMLElement) {
            const currentHeight =
              Number.parseFloat(listElement.style.height) ||
              listElement.getBoundingClientRect().height
            listElement.style.height = `${Math.max(0, currentHeight + delta)}px`
          }
          element.scrollTop -= delta
          onScrollOffsetWrite?.(-delta)
          return false
        }

        // Everything else (a whole-list reflow, a re-measured row above the viewport) is left to the
        // scroll owner, which measures how far the text under the reader actually moved once the
        // layout lands.
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
