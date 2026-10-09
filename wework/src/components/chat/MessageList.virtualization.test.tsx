import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { MessageList } from './MessageList'
import {
  clearRuntimeConversationCacheForTests,
  getConversationVirtualMeasurements,
} from '@/features/workbench/runtimeConversationCache'
import type { WorkbenchMessage } from '@/types/workbench'
import '@/i18n'

const {
  measureElementMock,
  nativeMeasureElementMock,
  observeElementOffsetMock,
  recordConversationDiagnosticMock,
  resizeItemMock,
  useVirtualizerMock,
  virtualizerInstances,
  virtualizerLayout,
  virtualizerMeasurementState,
  diagnosticsState,
} = vi.hoisted(() => ({
  measureElementMock: vi.fn(),
  nativeMeasureElementMock: vi.fn<
    (element: HTMLElement, entry: ResizeObserverEntry | undefined, instance: unknown) => number
  >((element, entry) => entry?.borderBoxSize[0]?.blockSize ?? element.offsetHeight),
  observeElementOffsetMock: vi.fn(),
  recordConversationDiagnosticMock: vi.fn(),
  resizeItemMock: vi.fn(),
  useVirtualizerMock: vi.fn(),
  virtualizerInstances: [] as Array<Record<string, unknown>>,
  virtualizerLayout: { height: 10_000, shift: 0 },
  virtualizerMeasurementState: { isScrolling: false, cachedSize: 100 },
  diagnosticsState: { enabled: false },
}))

vi.mock('../../../../packages/collaboration/src/conversation/conversationDiagnostics', () => ({
  getConversationDiagnosticContext: () => ({ scrollerId: 1 }),
  isConversationDiagnosticsEnabled: () => diagnosticsState.enabled,
  recordConversationDiagnostic: (...args: unknown[]) => recordConversationDiagnosticMock(...args),
}))

vi.mock('@/lib/runtime-environment', () => ({
  isDesktopRuntime: () => true,
  isElectronRuntime: () => true,
}))

vi.mock('@tanstack/react-virtual', () => ({
  measureElement: (
    element: HTMLElement,
    entry: ResizeObserverEntry | undefined,
    instance: unknown
  ) => nativeMeasureElementMock(element, entry, instance),
  observeElementOffset: (...args: unknown[]) => observeElementOffsetMock(...args),
  defaultRangeExtractor: (range: { startIndex: number; endIndex: number }) =>
    Array.from(
      { length: range.endIndex - range.startIndex + 1 },
      (_, index) => range.startIndex + index
    ),
  useVirtualizer: (options: {
    count: number
    getItemKey: (index: number) => string | number
    rangeExtractor: (range: {
      startIndex: number
      endIndex: number
      overscan: number
      count: number
    }) => number[]
  }) => {
    const visibleIndexes = options.rangeExtractor({
      startIndex: Math.max(0, options.count - 2),
      endIndex: options.count - 1,
      overscan: 2,
      count: options.count,
    })
    const virtualizer = {
      options,
      indexFromElement: (element: HTMLElement) => Number(element.dataset.index),
      itemSizeCache: new Map(
        visibleIndexes.map(index => [
          options.getItemKey(index),
          virtualizerMeasurementState.cachedSize,
        ])
      ),
      measurementsCache: Array.from({ length: options.count }, (_, index) => ({
        size: 100,
        start: index * 120,
        end: index * 120 + 100,
      })),
      isScrolling: virtualizerMeasurementState.isScrolling,
      range: { startIndex: Math.max(0, options.count - 2), endIndex: options.count - 1 },
      getDistanceFromEnd: () => 0,
      getTotalSize: () => virtualizerLayout.height,
      getVirtualItems: () =>
        visibleIndexes.map(index => ({
          index,
          key: options.getItemKey(index),
          start: index * 120 + (index === options.count - 1 ? virtualizerLayout.shift : 0),
          size:
            100 +
            (index === options.count - 2 ? virtualizerLayout.shift : 0) -
            (index === options.count - 1 ? virtualizerLayout.shift : 0),
          end: index * 120 + 100 + (index === options.count - 2 ? virtualizerLayout.shift : 0),
        })),
      measureElement: measureElementMock,
      resizeItem: resizeItemMock,
      takeSnapshot: () => [
        { index: 0, key: options.getItemKey(0), start: 32, end: 132, size: 100, lane: 0 },
      ],
    }
    useVirtualizerMock(options)
    virtualizerInstances.push(virtualizer)
    return virtualizer
  },
}))

describe('MessageList desktop virtualization', () => {
  afterEach(() => {
    clearRuntimeConversationCacheForTests()
    measureElementMock.mockClear()
    nativeMeasureElementMock.mockClear()
    observeElementOffsetMock.mockClear()
    resizeItemMock.mockClear()
    useVirtualizerMock.mockClear()
    recordConversationDiagnosticMock.mockClear()
    diagnosticsState.enabled = false
    virtualizerInstances.length = 0
    virtualizerLayout.height = 10_000
    virtualizerLayout.shift = 0
    virtualizerMeasurementState.isScrolling = false
    virtualizerMeasurementState.cachedSize = 100
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  test('uses the unified virtual layout for short conversations', () => {
    const intersectionObserver = vi.fn()
    vi.stubGlobal('IntersectionObserver', intersectionObserver)

    render(
      <MessageList
        messages={buildMessages(5, 'short')}
        scrollElementRef={{ current: createScrollElement(1_000) }}
      />
    )

    expect(screen.getAllByTestId('message-user')).toHaveLength(5)
    expect(screen.getByText('short message 0').closest('[data-index]')).toHaveStyle({
      position: 'absolute',
    })
    expect(useVirtualizerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        anchorTo: 'end',
        count: 5,
        enabled: true,
        overscan: 2,
      })
    )
    const virtualizer = virtualizerInstances.at(-1)
    expect(
      (virtualizer?.shouldAdjustScrollPositionOnItemSizeChange as (() => boolean) | undefined)?.()
    ).toBe(false)
    expect(intersectionObserver).not.toHaveBeenCalled()
  })

  test('records ordinary historical row measurements with native results and size deltas', () => {
    diagnosticsState.enabled = true
    render(
      <MessageList
        messages={buildMessages(3, 'private-history')}
        scrollElementRef={{ current: createScrollElement(200) }}
      />
    )
    const options = useVirtualizerMock.mock.calls.at(-1)?.[0] as {
      getItemKey: (index: number) => string
      estimateSize: (index: number) => number
      measureElement: (
        element: HTMLElement,
        entry: ResizeObserverEntry | undefined,
        instance: Record<string, unknown>
      ) => number
    }
    const instance = {
      options,
      indexFromElement: (element: HTMLElement) => Number(element.dataset.index),
      itemSizeCache: new Map([['user-1', 90]]),
      measurementsCache: Array.from({ length: 3 }, (_, index) => ({
        size: 100,
        start: index * 116,
        end: index * 116 + 100,
      })),
      getTotalSize: () => 372,
      isScrolling: true,
    }
    const rows = screen
      .getAllByTestId('message-user')
      .map(article => article.closest<HTMLElement>('[data-index]')!)
    rows.forEach((row, index) => {
      Object.defineProperty(row, 'offsetHeight', { configurable: true, value: 110 + index })
      expect(options.measureElement(row, undefined, instance)).toBe(110 + index)
      expect(nativeMeasureElementMock).toHaveBeenLastCalledWith(row, undefined, instance)
    })
    const resizeEntry = { borderBoxSize: [{ blockSize: 136 }] } as ResizeObserverEntry
    expect(options.measureElement(rows[1], resizeEntry, instance)).toBe(136)
    expect(nativeMeasureElementMock).toHaveBeenLastCalledWith(rows[1], resizeEntry, instance)

    const measurements = recordConversationDiagnosticMock.mock.calls.filter(
      ([name]) => name === 'virtual-measurement'
    )
    expect(measurements).toHaveLength(4)
    expect(measurements.slice(0, 3).map(([, details]) => details.rowIndex)).toEqual([0, 1, 2])
    expect(measurements.at(-1)).toEqual([
      'virtual-measurement',
      expect.objectContaining({
        rowIndex: 1,
        previousSize: 90,
        measuredSize: 136,
        sizeDelta: 46,
        rowStart: 116,
        rowEnd: 216,
        scrolling: true,
      }),
    ])
    expect(JSON.stringify(measurements)).not.toContain('private-history')
    expect(JSON.stringify(measurements)).not.toContain('user-1')
  })

  test('leaves native measurement unchanged without diagnostic layout reads when disabled', () => {
    render(
      <MessageList
        messages={buildMessages(1, 'diagnostics-disabled')}
        scrollElementRef={{ current: createScrollElement(200) }}
      />
    )
    const options = useVirtualizerMock.mock.calls.at(-1)?.[0] as {
      measureElement: (
        element: HTMLElement,
        entry: ResizeObserverEntry | undefined,
        instance: Record<string, unknown>
      ) => number
    }
    const row = screen.getByTestId('message-user').closest<HTMLElement>('[data-index]')!
    Object.defineProperty(row, 'offsetHeight', { value: 123 })
    const getBoundingClientRect = vi.spyOn(row, 'getBoundingClientRect')
    // A disabled recorder must not inspect virtual measurements or add a DOM measurement.
    expect(options.measureElement(row, undefined, {})).toBe(123)
    expect(nativeMeasureElementMock).toHaveBeenLastCalledWith(row, undefined, {})
    expect(getBoundingClientRect).not.toHaveBeenCalled()
    expect(recordConversationDiagnosticMock).not.toHaveBeenCalled()
  })

  test.each([0, 2523.78])(
    'measures rich historical Markdown while scrolling using actual row height %s',
    rowHeight => {
      diagnosticsState.enabled = true
      virtualizerMeasurementState.isScrolling = true
      virtualizerMeasurementState.cachedSize = 1313
      const getBoundingClientRect = vi
        .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
        .mockImplementation(function (this: HTMLElement) {
          const height = this.hasAttribute('data-index') ? rowHeight : 2406.78
          return {
            width: 736,
            height,
            top: 0,
            bottom: height,
            left: 0,
            right: 736,
            x: 0,
            y: 0,
            toJSON: () => ({}),
          }
        })
      const messages = buildMessages(3, 'history')
      messages[1] = {
        ...messages[1],
        role: 'assistant',
        content: '**Rich historical content.** '.repeat(200),
      }

      render(
        <MessageList messages={messages} scrollElementRef={{ current: createScrollElement(800) }} />
      )

      if (rowHeight === 0) {
        expect(resizeItemMock).not.toHaveBeenCalled()
        expect(recordConversationDiagnosticMock.mock.calls.map(([name]) => name)).not.toContain(
          'virtual-measurement'
        )
      } else {
        expect(resizeItemMock).toHaveBeenCalledWith(1, 2524)
        expect(recordConversationDiagnosticMock).toHaveBeenCalledWith(
          'virtual-measurement',
          expect.objectContaining({
            rowIndex: 1,
            previousSize: 1313,
            measuredSize: 2524,
            sizeDelta: 1211,
            scrolling: true,
          })
        )
        expect(nativeMeasureElementMock).not.toHaveBeenCalled()
      }
      getBoundingClientRect.mockRestore()
    }
  )

  test.each([
    { rowHeight: 606.47, expectedSize: 606 },
    { rowHeight: 1334.31, expectedSize: 1334 },
    { rowHeight: 2523.78, expectedSize: 2524 },
  ])(
    'keeps synchronous rich row height $rowHeight consistent with native ref and ResizeObserver measurements',
    async ({ rowHeight, expectedSize }) => {
      const { measureElement: nativeMeasureElement } =
        await vi.importActual<typeof import('@tanstack/react-virtual')>('@tanstack/react-virtual')
      diagnosticsState.enabled = true
      virtualizerMeasurementState.isScrolling = true
      virtualizerMeasurementState.cachedSize = expectedSize
      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
        this: HTMLElement
      ) {
        return new DOMRect(0, 0, 736, this.hasAttribute('data-index') ? rowHeight : rowHeight - 64)
      })
      const messages = buildMessages(3, 'fractional-history')
      messages[1] = {
        ...messages[1],
        role: 'assistant',
        content: '**Rich historical content.** '.repeat(200),
      }
      render(
        <MessageList messages={messages} scrollElementRef={{ current: createScrollElement(800) }} />
      )
      const row = screen.getByTestId('message-assistant').closest<HTMLElement>('[data-index]')!
      const instance = virtualizerInstances.at(-1)! as unknown as Parameters<
        typeof nativeMeasureElement
      >[2]
      const options = useVirtualizerMock.mock.calls.at(-1)![0] as {
        measureElement: typeof nativeMeasureElement
      }
      expect(resizeItemMock).toHaveBeenCalledWith(1, expectedSize)
      const size = resizeItemMock.mock.calls.findLast(([index]) => index === 1)![1] as number
      Object.defineProperty(row, 'offsetHeight', { configurable: true, value: expectedSize })
      instance.itemSizeCache.delete(instance.options.getItemKey(1))
      // The first native ref measurement reads integer offsetHeight before a cache exists.
      expect(nativeMeasureElement(row, undefined, instance)).toBe(size)
      instance.itemSizeCache.set(instance.options.getItemKey(1), size)
      const resizeEntry = { borderBoxSize: [{ blockSize: rowHeight }] } as ResizeObserverEntry
      expect(nativeMeasureElement(row, resizeEntry, instance)).toBe(expectedSize)
      recordConversationDiagnosticMock.mockClear()

      for (const entry of [undefined, resizeEntry]) {
        nativeMeasureElementMock.mockImplementationOnce((element, resize, virtualizer) =>
          nativeMeasureElement(element, resize, virtualizer as typeof instance)
        )
        expect(options.measureElement(row, entry, instance)).toBe(size)
        expect(recordConversationDiagnosticMock).toHaveBeenLastCalledWith(
          'virtual-measurement',
          expect.objectContaining({
            rowIndex: 1,
            previousSize: size,
            measuredSize: size,
            sizeDelta: 0,
          })
        )
      }
    }
  )

  test('records the committed virtual range before the scroll owner compensates it', () => {
    diagnosticsState.enabled = true
    const scrollElement = createScrollElement(200)
    scrollElement.scrollTop = 40
    const onVirtualLayoutChange = vi.fn(() => {
      expect(recordConversationDiagnosticMock).toHaveBeenLastCalledWith(
        'virtual-range',
        expect.objectContaining({
          rangeStart: 18,
          rangeEnd: 19,
          renderedCount: 2,
          scrollTop: 40,
          clientHeight: 200,
          clientWidth: 800,
          totalSize: 10_000,
        })
      )
      scrollElement.scrollTop = 80
    })
    render(
      <MessageList
        messages={buildMessages(20, 'range-diagnostic')}
        scrollElementRef={{ current: scrollElement }}
        onVirtualLayoutChange={onVirtualLayoutChange}
      />
    )
    expect(onVirtualLayoutChange).toHaveBeenCalledOnce()
  })

  test('adapts the virtualizer to the desktop bottom-origin scroller', () => {
    const scrollElement = createScrollElement(200)
    const messages = buildMessages(20, 'bottom-origin')
    messages[19] = {
      ...messages[19],
      role: 'assistant',
      status: 'streaming',
    }
    Object.defineProperty(scrollElement, 'scrollHeight', {
      configurable: true,
      value: 10_178,
    })
    scrollElement.scrollTop = -178
    const scrollTo = vi.fn(({ top }: ScrollToOptions) => {
      scrollElement.scrollTop = top ?? scrollElement.scrollTop
    })
    scrollElement.scrollTo = scrollTo

    render(
      <MessageList messages={messages} scrollElementRef={{ current: scrollElement }} bottomOrigin />
    )

    expect(useVirtualizerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        anchorTo: 'start',
        followOnAppend: false,
        observeElementOffset: expect.any(Function),
        scrollToFn: expect.any(Function),
      })
    )
    expect(scrollElement.scrollTop).toBe(0)

    const options = useVirtualizerMock.mock.calls.at(-1)?.[0] as {
      observeElementOffset: (
        instance: Record<string, unknown>,
        callback: (offset: number, isScrolling: boolean) => void
      ) => void
      scrollToFn: (
        offset: number,
        options: { adjustments?: number; behavior?: ScrollBehavior },
        instance: Record<string, unknown>
      ) => void
    }
    const instance = {
      elementsCache: new Map<string, HTMLElement>(),
      getTotalSize: () => 10_000,
      scrollElement,
    }
    const listElement = document.createElement('div')
    const itemElement = document.createElement('div')
    listElement.style.height = '3900px'
    listElement.append(itemElement)
    instance.elementsCache.set('user-19', itemElement)
    const shouldAdjustScrollPosition = virtualizerInstances.at(-1)
      ?.shouldAdjustScrollPositionOnItemSizeChange as
      | ((
          item: { key: string; start: number },
          delta: number,
          instance: typeof instance
        ) => boolean)
      | undefined

    scrollElement.scrollTop = -160
    expect(shouldAdjustScrollPosition?.({ key: 'user-19', start: 9_000 }, 40, instance)).toBe(false)
    expect(shouldAdjustScrollPosition?.({ key: 'user-19', start: 9_000 }, -40, instance)).toBe(
      false
    )
    expect(shouldAdjustScrollPosition?.({ key: 'user-18', start: 8_000 }, 40, instance)).toBe(false)
    expect(listElement).toHaveStyle({ height: '3900px' })
    expect(scrollElement.scrollTop).toBe(-160)

    useVirtualizerMock.mockClear()
    render(
      <MessageList
        messages={messages}
        scrollElementRef={{ current: scrollElement }}
        bottomOrigin
        virtualAnchorToEnd={false}
      />
    )
    const shouldPreserveScrollPosition = virtualizerInstances.at(-1)
      ?.shouldAdjustScrollPositionOnItemSizeChange as
      | ((
          item: { key: string; start: number },
          delta: number,
          instance: typeof instance
        ) => boolean)
      | undefined

    scrollElement.scrollTop = -160
    expect(shouldPreserveScrollPosition?.({ key: 'user-19', start: 9_000 }, 40, instance)).toBe(
      false
    )
    expect(listElement).toHaveStyle({ height: '3900px' })
    expect(scrollElement.scrollTop).toBe(-160)

    expect(shouldPreserveScrollPosition?.({ key: 'user-19', start: 9_000 }, -40, instance)).toBe(
      false
    )
    expect(listElement).toHaveStyle({ height: '3900px' })
    expect(scrollElement.scrollTop).toBe(-160)

    expect(shouldPreserveScrollPosition?.({ key: 'user-18', start: 8_000 }, 40, instance)).toBe(
      false
    )
    expect(listElement).toHaveStyle({ height: '3900px' })
    expect(scrollElement.scrollTop).toBe(-160)

    scrollElement.scrollTop = 0
    expect(shouldPreserveScrollPosition?.({ key: 'user-19', start: 9_000 }, 40, instance)).toBe(
      false
    )
    expect(listElement).toHaveStyle({ height: '3900px' })
    expect(scrollElement.scrollTop).toBe(0)

    Object.defineProperty(scrollElement, 'scrollHeight', {
      configurable: true,
      value: 10_218,
    })
    scrollElement.scrollTop = -200
    observeElementOffsetMock.mockImplementationOnce(
      (_instance: unknown, callback: (offset: number, isScrolling: boolean) => void) => {
        callback(123, true)
        return () => undefined
      }
    )
    const onOffset = vi.fn()
    options.observeElementOffset(instance, onOffset)
    expect(onOffset).toHaveBeenLastCalledWith(9_600, true)

    onOffset.mockClear()
    options.scrollToFn(9_800, {}, instance)
    expect(scrollTo).toHaveBeenLastCalledWith({ behavior: undefined, top: 0 })
    expect(onOffset).toHaveBeenLastCalledWith(9_800, false)

    options.scrollToFn(9_600, {}, instance)
    expect(scrollTo).toHaveBeenLastCalledWith({ behavior: undefined, top: -200 })
    expect(onOffset).toHaveBeenLastCalledWith(9_600, false)

    options.scrollToFn(9_560, { adjustments: 40 }, instance)
    expect(scrollTo).toHaveBeenLastCalledWith({ behavior: undefined, top: -200 })
    expect(onOffset).toHaveBeenLastCalledWith(9_600, false)

    options.scrollToFn(9_760, { adjustments: 40 }, instance)
    expect(scrollTo).toHaveBeenLastCalledWith({ behavior: undefined, top: 0 })
    expect(onOffset).toHaveBeenLastCalledWith(9_800, false)
  })

  test('normalizes a restored bottom-origin distance in the task-switch layout commit', () => {
    const scrollElement = createScrollElement(200)
    scrollElement.scrollTop = -178

    render(
      <MessageList
        conversationKey="restored-bottom-origin"
        messages={buildMessages(20, 'restored-bottom-origin')}
        scrollElementRef={{ current: scrollElement }}
        initialDistanceFromBottomPx={72}
        bottomOrigin
      />
    )

    expect(scrollElement.scrollTop).toBe(-72)
  })

  test('notifies the scroll owner in the commit that changes the virtual list height', () => {
    const messages = buildMessages(20, 'layout')
    const scrollElementRef = { current: createScrollElement(200) }
    const heights: string[] = []
    const onVirtualLayoutChange = () => {
      const list = screen.getByText('layout message 19').closest('[data-index]')?.parentElement
      heights.push(list?.style.height ?? '')
    }
    const { rerender } = render(
      <MessageList
        messages={messages}
        scrollElementRef={scrollElementRef}
        onVirtualLayoutChange={onVirtualLayoutChange}
        bottomOrigin
      />
    )
    expect(heights).toEqual(['10000px'])

    virtualizerLayout.height = 10_040
    rerender(
      <MessageList
        messages={[...messages]}
        scrollElementRef={scrollElementRef}
        onVirtualLayoutChange={onVirtualLayoutChange}
        bottomOrigin
      />
    )
    // No ResizeObserver callback or animation frame has run between commit and this assertion.
    expect(heights).toEqual(['10000px', '10040px'])
  })

  test('notifies the scroll owner when inverse row measurements preserve total height', () => {
    const messages = buildMessages(20, 'layout')
    const scrollElementRef = { current: createScrollElement(200) }
    const positions: string[] = []
    const onVirtualLayoutChange = () => {
      const row = screen.getByText('layout message 19').closest<HTMLElement>('[data-index]')!
      expect(row.parentElement).toHaveStyle({ height: '10000px' })
      positions.push(row.style.transform)
    }
    const { rerender } = render(
      <MessageList
        messages={messages}
        scrollElementRef={scrollElementRef}
        onVirtualLayoutChange={onVirtualLayoutChange}
        bottomOrigin
      />
    )
    expect(positions).toEqual(['translateY(2280px)'])

    // The preceding row grows by 40px and this row shrinks by 40px in the same commit.
    virtualizerLayout.shift = 40
    rerender(
      <MessageList
        messages={[...messages]}
        scrollElementRef={scrollElementRef}
        onVirtualLayoutChange={onVirtualLayoutChange}
        bottomOrigin
      />
    )
    expect(positions).toEqual(['translateY(2280px)', 'translateY(2320px)'])
  })

  test('keeps only the end-anchored overscan range mounted for long conversations', () => {
    render(
      <MessageList
        messages={buildMessages(100, 'long')}
        scrollElementRef={{ current: createScrollElement(200) }}
      />
    )

    expect(screen.getByText('long message 99')).toBeInTheDocument()
    expect(screen.getByText('long message 98')).toBeInTheDocument()
    expect(screen.queryByText('long message 0')).not.toBeInTheDocument()
    expect(screen.getAllByTestId('message-user')).toHaveLength(2)
  })

  test('keeps a forced navigation target in the virtual range', () => {
    render(
      <MessageList
        messages={buildMessages(100, 'navigation')}
        scrollElementRef={{ current: createScrollElement(200) }}
        forceVirtualMessageId="user-80"
      />
    )

    expect(screen.getByText('navigation message 80')).toBeInTheDocument()
    expect(screen.getByText('navigation message 99')).toBeInTheDocument()
  })

  test('keeps an active streaming message mounted outside the visible range', () => {
    const messages = buildMessages(100, 'streaming')
    messages[80] = {
      ...messages[80],
      role: 'assistant',
      status: 'streaming',
    }

    render(
      <MessageList messages={messages} scrollElementRef={{ current: createScrollElement(200) }} />
    )

    expect(screen.getByText('streaming message 80')).toBeInTheDocument()
    expect(screen.getByText('streaming message 99')).toBeInTheDocument()
  })

  test('lets the last streaming message use its normal measurement path', () => {
    const messages = buildMessages(100, 'last-streaming')
    messages[99] = {
      ...messages[99],
      role: 'assistant',
      status: 'streaming',
    }

    render(
      <MessageList messages={messages} scrollElementRef={{ current: createScrollElement(200) }} />
    )

    expect(screen.getByText('last-streaming message 99')).toBeInTheDocument()
    expect(resizeItemMock).not.toHaveBeenCalled()
    expect(
      measureElementMock.mock.calls.some(
        ([element]) => element instanceof HTMLElement && element.dataset.index === '99'
      )
    ).toBe(true)
  })

  test('follows the end when a user and streaming assistant are appended', () => {
    const messages = buildMessages(100, 'appended-user')
    const latestUserMessage = {
      ...buildMessages(1, 'latest-user')[0],
      id: 'user-100',
    }
    const streamingAssistantMessage = {
      ...buildMessages(1, 'streaming-assistant')[0],
      id: 'assistant-101',
      role: 'assistant' as const,
      status: 'streaming' as const,
    }
    const { rerender } = render(
      <MessageList messages={messages} scrollElementRef={{ current: createScrollElement(200) }} />
    )

    rerender(
      <MessageList
        messages={[...messages, latestUserMessage, streamingAssistantMessage]}
        scrollElementRef={{ current: createScrollElement(200) }}
      />
    )

    expect(useVirtualizerMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        anchorTo: 'end',
        followOnAppend: 'auto',
      })
    )
  })

  test('reconfigures the virtualizer when end anchoring is released', () => {
    const messages = buildMessages(100, 'anchor-switch')
    const props = {
      messages,
      scrollElementRef: { current: createScrollElement(200) },
    }
    const view = render(<MessageList {...props} virtualAnchorToEnd />)

    expect(useVirtualizerMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        anchorTo: 'end',
      })
    )

    useVirtualizerMock.mockClear()
    view.rerender(<MessageList {...props} virtualAnchorToEnd={false} />)

    expect(useVirtualizerMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        anchorTo: 'start',
        followOnAppend: false,
      })
    )
  })

  test('reconfigures the virtualizer when the scroll origin changes', () => {
    const props = {
      messages: buildMessages(20, 'origin-switch'),
      scrollElementRef: { current: createScrollElement(200) },
    }
    const view = render(<MessageList {...props} />)

    expect(useVirtualizerMock).toHaveBeenLastCalledWith(
      expect.not.objectContaining({
        observeElementOffset: expect.any(Function),
      })
    )

    useVirtualizerMock.mockClear()
    view.rerender(<MessageList {...props} bottomOrigin />)

    expect(useVirtualizerMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        observeElementOffset: expect.any(Function),
        scrollToFn: expect.any(Function),
      })
    )
  })

  test.each([180, 180.47, 180.78])(
    'remeasures mounted rows after guidance changes the message sequence at height %s',
    async rowHeight => {
      const { measureElement: nativeMeasureElement } =
        await vi.importActual<typeof import('@tanstack/react-virtual')>('@tanstack/react-virtual')
      const messages = buildMessages(3, 'guidance-layout')
      const guidanceMessage = {
        ...buildMessages(1, 'mid-turn-guidance')[0],
        id: 'guidance-message',
        runtimeGuidance: true,
      }
      const props = {
        messages: [messages[0], guidanceMessage, messages[2]],
        scrollElementRef: { current: createScrollElement(200) },
      }
      const view = render(<MessageList {...props} />)
      const guidanceRow = screen.getByText('mid-turn-guidance message 0').closest('[data-index]')
      expect(guidanceRow).not.toBeNull()
      vi.spyOn(guidanceRow!, 'getBoundingClientRect').mockReturnValue({
        bottom: rowHeight,
        height: rowHeight,
        left: 0,
        right: 800,
        top: 0,
        width: 800,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      })
      resizeItemMock.mockClear()

      const assistantContinuation = {
        ...buildMessages(1, 'assistant-continuation')[0],
        id: 'assistant-continuation',
        role: 'assistant' as const,
        status: 'streaming' as const,
      }
      view.rerender(
        <MessageList
          {...props}
          messages={[messages[0], assistantContinuation, guidanceMessage, messages[2]]}
        />
      )

      const expectedSize = nativeMeasureElement(
        guidanceRow! as HTMLElement,
        { borderBoxSize: [{ blockSize: rowHeight }] } as ResizeObserverEntry,
        virtualizerInstances.at(-1)! as unknown as Parameters<typeof nativeMeasureElement>[2]
      )
      expect(resizeItemMock).toHaveBeenCalledWith(2, expectedSize)
    }
  )

  test('deduplicates a streaming message that is also a forced navigation target', () => {
    const messages = buildMessages(100, 'streaming-navigation')
    messages[80] = {
      ...messages[80],
      role: 'assistant',
      status: 'streaming',
    }

    render(
      <MessageList
        messages={messages}
        scrollElementRef={{ current: createScrollElement(200) }}
        forceVirtualMessageId="user-80"
      />
    )

    expect(screen.getAllByText('streaming-navigation message 80')).toHaveLength(1)
  })

  test.each([320, 320.31, 320.78])(
    'synchronously remeasures an active streaming row after its content changes at height %s',
    async rowHeight => {
      const { measureElement: nativeMeasureElement } =
        await vi.importActual<typeof import('@tanstack/react-virtual')>('@tanstack/react-virtual')
      const messages = buildMessages(100, 'streaming-resize')
      messages[80] = {
        ...messages[80],
        role: 'assistant',
        status: 'streaming',
      }
      const props = {
        messages,
        scrollElementRef: { current: createScrollElement(200) },
      }
      const view = render(<MessageList {...props} />)
      const row = screen.getByText('streaming-resize message 80').closest('[data-index]')
      expect(row).not.toBeNull()
      vi.spyOn(row!, 'getBoundingClientRect').mockReturnValue({
        bottom: rowHeight,
        height: rowHeight,
        left: 0,
        right: 800,
        top: 0,
        width: 800,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      })
      resizeItemMock.mockClear()

      const updatedMessages = [...messages]
      updatedMessages[80] = {
        ...updatedMessages[80],
        content: `${updatedMessages[80].content} appended`,
      }
      view.rerender(<MessageList {...props} messages={updatedMessages} />)

      const expectedSize = nativeMeasureElement(
        row! as HTMLElement,
        { borderBoxSize: [{ blockSize: rowHeight }] } as ResizeObserverEntry,
        virtualizerInstances.at(-1)! as unknown as Parameters<typeof nativeMeasureElement>[2]
      )
      expect(resizeItemMock).toHaveBeenCalledWith(80, expectedSize)
    }
  )

  test('restores and persists the TanStack measurement snapshot', () => {
    const messages = buildMessages(20, 'measured')
    const props = {
      conversationKey: 'measured-conversation',
      messages,
      scrollElementRef: { current: createScrollElement(200) },
    }
    const firstRender = render(<MessageList {...props} />)
    firstRender.unmount()

    expect(getConversationVirtualMeasurements('measured-conversation')).toEqual([
      expect.objectContaining({ key: 'user-0', size: 100, start: 32 }),
    ])

    useVirtualizerMock.mockClear()
    render(<MessageList {...props} />)

    expect(useVirtualizerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        initialMeasurementsCache: [
          expect.objectContaining({ key: 'user-0', size: 100, start: 32 }),
        ],
      })
    )
  })
})

function buildMessages(count: number, prefix: string): WorkbenchMessage[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `user-${index}`,
    role: 'user' as const,
    content: `${prefix} message ${index}`,
    status: 'done' as const,
    createdAt: '2026-07-24T00:00:00Z',
  }))
}

function createScrollElement(clientHeight: number): HTMLDivElement {
  const scrollElement = document.createElement('div')
  Object.defineProperty(scrollElement, 'clientHeight', {
    configurable: true,
    value: clientHeight,
  })
  Object.defineProperty(scrollElement, 'clientWidth', {
    configurable: true,
    value: 800,
  })
  return scrollElement
}
