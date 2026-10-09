import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  getConversationDiagnosticsSnapshot,
  resetConversationDiagnosticsForTest,
  startConversationDiagnosticCapture,
} from '../../../../packages/collaboration/src/conversation/conversationDiagnostics'
import { useBottomOriginVirtualizer } from '../../../../packages/collaboration/src/conversation/useBottomOriginVirtualizer'

const { observeElementOffsetMock, virtualizerOptions } = vi.hoisted(() => ({
  observeElementOffsetMock: vi.fn(),
  virtualizerOptions: { current: {} as Record<string, unknown> },
}))

vi.mock('@tanstack/react-virtual', () => ({
  observeElementOffset: (...args: unknown[]) => observeElementOffsetMock(...args),
  useVirtualizer: (options: Record<string, unknown>) => {
    virtualizerOptions.current = options
    return { options, getTotalSize: () => 10000, shouldAdjustScrollPositionOnItemSizeChange: null }
  },
}))

function createHarness() {
  const element = document.createElement('div')
  element.dataset.scrollOrigin = 'bottom'
  Object.defineProperties(element, {
    clientHeight: { configurable: true, value: 200 },
    clientWidth: { configurable: true, value: 1200 },
    scrollHeight: { configurable: true, value: 10246 },
    scrollTop: { configurable: true, writable: true, value: -320 },
  })
  element.scrollTo = vi.fn(({ top }: ScrollToOptions) => {
    element.scrollTop = Number(top)
  })
  const { result } = renderHook(() =>
    useBottomOriginVirtualizer({
      bottomOrigin: true,
      count: 10,
      enabled: true,
      estimateSize: () => 1000,
      initialContentHeightPx: 10000,
      initialDistanceFromBottomPx: 400,
      positionKey: 'diagnostic-fixture',
      scrollElementRef: { current: element },
    })
  )
  const instance = { ...result.current, scrollElement: element }
  const options = virtualizerOptions.current as {
    observeElementOffset: (
      instance: typeof result.current,
      callback: (offset: number, scrolling: boolean) => void
    ) => void
    scrollToFn: (
      offset: number,
      options: { adjustments?: number; behavior?: ScrollBehavior },
      instance: typeof result.current
    ) => void
  }
  return { element, instance, options }
}

describe('bottom-origin virtualizer diagnostic geometry', () => {
  beforeEach(() => resetConversationDiagnosticsForTest())
  afterEach(() => {
    observeElementOffsetMock.mockReset()
    vi.restoreAllMocks()
  })

  test('records initial and adapted writes with both virtual and native ranges', () => {
    startConversationDiagnosticCapture()
    const { element, instance, options } = createHarness()
    expect(getConversationDiagnosticsSnapshot()!.events[0]).toMatchObject({
      name: 'scroll-write',
      details: {
        writeSource: 2,
        previousScrollTop: -320,
        targetScrollTop: -400,
        appliedCorrection: -80,
        totalSize: 10000,
        virtualMaximumOffset: 9800,
        nativeMaximumOffset: 10046,
      },
    })

    options.scrollToFn(9500, {}, instance)

    expect(element.scrollTo).toHaveBeenCalledExactlyOnceWith({ top: -300, behavior: undefined })
    expect(getConversationDiagnosticsSnapshot()!.events.at(-1)).toMatchObject({
      name: 'scroll-write',
      details: {
        writeSource: 1,
        previousScrollTop: -400,
        targetScrollTop: -300,
        appliedCorrection: 100,
        totalSize: 10000,
        virtualMaximumOffset: 9800,
        nativeMaximumOffset: 10046,
      },
    })
  })

  test.each([false, true])('preserves native offset conversion when capture is %s', enabled => {
    if (enabled) startConversationDiagnosticCapture()
    const { element, instance, options } = createHarness()
    let nativeCallback: ((offset: number, scrolling: boolean) => void) | undefined
    observeElementOffsetMock.mockImplementationOnce(
      (_instance: unknown, callback: typeof nativeCallback) => {
        nativeCallback = callback
      }
    )
    const callback = vi.fn()
    options.observeElementOffset(instance, callback)
    if (!enabled) {
      Object.defineProperty(element, 'scrollHeight', {
        get: () => {
          throw new Error('Unexpected native range diagnostic read')
        },
      })
    }

    nativeCallback!(400, true)

    expect(callback).toHaveBeenCalledExactlyOnceWith(9400, true)
    if (enabled) {
      expect(getConversationDiagnosticsSnapshot()!.events.at(-1)).toMatchObject({
        name: 'virtual-scroll-offset',
        details: {
          rawScrollOffset: 400,
          virtualScrollOffset: 9400,
          scrollTop: -400,
          totalSize: 10000,
          scrollHeight: 10246,
          virtualMaximumOffset: 9800,
          nativeMaximumOffset: 10046,
          scrolling: true,
        },
      })
    } else {
      expect(getConversationDiagnosticsSnapshot()).toBeNull()
      options.scrollToFn(9500, {}, instance)
      expect(element.scrollTo).toHaveBeenCalledExactlyOnceWith({ top: -300, behavior: undefined })
    }
  })
})
