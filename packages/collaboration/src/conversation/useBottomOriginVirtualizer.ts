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
import {
  CONVERSATION_SCROLL_WRITE_SOURCE,
  recordConversationScrollWrite,
} from './conversationScrollWrite'
import {
  getConversationDiagnosticContext,
  isConversationDiagnosticsEnabled,
  recordConversationDiagnostic,
} from './conversationDiagnostics'

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
      if (element && isConversationDiagnosticsEnabled()) {
        recordConversationDiagnostic('virtual-scroll-offset', {
          ...getConversationDiagnosticContext(element),
          rawScrollOffset: _offset,
          virtualScrollOffset: offset,
          ...getVirtualizerDiagnosticGeometry(instance, element),
          scrollTop: element.scrollTop,
          scrolling: isScrolling,
        })
      }
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
    const top = distanceFromBottom === 0 ? 0 : -distanceFromBottom
    recordConversationScrollWrite(
      element,
      CONVERSATION_SCROLL_WRITE_SOURCE.virtualizerOffset,
      top,
      () => element.scrollTo({ top, behavior }),
      () => getVirtualizerDiagnosticGeometry(instance, element)
    )
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
    ? () => false // ScrollableMessageArea owns anchoring after the measured layout commits.
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
    const top = distanceFromBottom === 0 ? 0 : -distanceFromBottom
    recordConversationScrollWrite(
      element,
      CONVERSATION_SCROLL_WRITE_SOURCE.virtualizerInitialPosition,
      top,
      () => {
        element.scrollTop = top
      },
      () => getVirtualizerDiagnosticGeometry(virtualizer, element)
    )
  }, [bottomOrigin, initialDistanceFromBottomPx, positionKey, scrollElementRef, virtualizer])

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

function getVirtualizerDiagnosticGeometry<
  TScrollElement extends HTMLElement,
  TItemElement extends Element,
>(instance: Virtualizer<TScrollElement, TItemElement>, element: TScrollElement) {
  const totalSize = instance.getTotalSize()
  const clientHeight = element.clientHeight
  const scrollHeight = element.scrollHeight
  return {
    totalSize,
    scrollHeight,
    clientHeight,
    virtualMaximumOffset: Math.max(0, totalSize - clientHeight),
    nativeMaximumOffset: Math.max(0, scrollHeight - clientHeight),
  }
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
