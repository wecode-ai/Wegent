import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { MessageList } from './MessageList'
import {
  clearRuntimeConversationCacheForTests,
  cacheConversationVirtualMeasurements,
  getConversationVirtualMeasurements,
} from '@/features/workbench/runtimeConversationCache'
import type { WorkbenchMessage } from '@/types/workbench'
import * as messagePretextLayout from '../../../../packages/collaboration/src/conversation/messagePretextLayout'
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
    enabled: boolean
    measureElement: (
      row: HTMLElement,
      entry: ResizeObserverEntry | undefined,
      instance: unknown
    ) => number
    count: number
    getItemKey: (index: number) => string | number
    rangeExtractor: (range: {
      startIndex: number
      endIndex: number
      overscan: number
      count: number
    }) => number[]
  }) => {
    const visibleIndexes = !options.enabled
      ? []
      : options.rangeExtractor({
          startIndex: Math.max(0, options.count - 2),
          endIndex: options.count - 1,
          overscan: 2,
          count: options.count,
        })
    const virtualizer = {
      options,
      elementsCache: new Map(),
      cancelScroll: vi.fn(),
      measure: vi.fn(),
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
            virtualizerMeasurementState.cachedSize +
            (index === options.count - 2 ? virtualizerLayout.shift : 0) -
            (index === options.count - 1 ? virtualizerLayout.shift : 0),
          end: index * 120 + 100 + (index === options.count - 2 ? virtualizerLayout.shift : 0),
        })),
      measureElement: (row: HTMLElement | null) => {
        measureElementMock(row)
        if (!row) return
        const index = Number(row.dataset.index)
        virtualizer.elementsCache.set(options.getItemKey(index), row)
        const size = options.measureElement(row, undefined, virtualizer)
        if (size !== virtualizerMeasurementState.cachedSize) resizeItemMock(index, size)
      },
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
  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800)
  })

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
    ).toBeUndefined()
    expect(intersectionObserver).not.toHaveBeenCalled()
  })

  test.each([0, 2523.78])(
    'measures rich historical Markdown while scrolling using actual row height %s',
    async rowHeight => {
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

      await act(async () => {})
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
      />
    )
    expect(heights).toEqual(['10000px'])

    virtualizerLayout.height = 10_040
    rerender(
      <MessageList
        messages={[...messages]}
        scrollElementRef={scrollElementRef}
        onVirtualLayoutChange={onVirtualLayoutChange}
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

  test('mounts an offscreen search match and expands only that user message', () => {
    const messages = buildMessages(100, 'search')
    messages[80] = { ...messages[80], content: 'search match\n'.repeat(100) }
    const props = {
      messages,
      scrollElementRef: { current: createScrollElement(200) },
      forceVirtualMessageId: 'user-80',
    }
    const { rerender } = render(<MessageList {...props} searchMessageId="user-80" />)
    const target = screen.getByText(/search match/).closest('[data-testid="user-message-content"]')
    expect(target).toBeInTheDocument()
    expect(target?.className).not.toContain('max-h-')
    expect(screen.getAllByTestId('message-user')).toHaveLength(3)
    rerender(<MessageList {...props} />)
    expect(target?.className).toContain('max-h-')
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
    expect(measureElementMock).toHaveBeenCalled()
    expect(useVirtualizerMock.mock.lastCall![0].measureElement).toEqual(expect.any(Function))
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
        anchorTo: 'end',
        scrollEndThreshold: -1,
        followOnAppend: false,
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

  test('invalidates measured heights when the message column narrows inside the same viewport', () => {
    const observers = new Map<Element, ResizeObserverCallback>()
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(private callback: ResizeObserverCallback) {}
        observe = (element: Element) => observers.set(element, this.callback)
        unobserve = (element: Element) => observers.delete(element)
        disconnect = vi.fn()
      }
    )
    const messages = buildMessages(20, 'column-resize')
    const view = render(
      <MessageList messages={messages} scrollElementRef={{ current: createScrollElement(200) }} />
    )
    const column = screen
      .getByText('column-resize message 19')
      .closest('[data-message-row]')!.parentElement!
    const previousInstanceCount = virtualizerInstances.length
    vi.spyOn(column, 'clientWidth', 'get').mockReturnValue(400)
    act(() => observers.get(column)!([], {} as ResizeObserver))
    expect(
      virtualizerInstances
        .slice(previousInstanceCount)
        .some(engine => vi.mocked(engine.measure as () => void).mock.calls.length > 0)
    ).toBe(true)
    view.unmount()
  })

  test('reuses measured heights without preparing the full transcript again on return', () => {
    const messages = buildMessages(20, 'reopened')
    cacheConversationVirtualMeasurements(
      'reopened-conversation',
      messages.map((message, index) => ({
        key: message.id,
        index,
        size: 987,
        start: 32 + index * 1003,
        end: 32 + index * 1003 + 987,
        lane: 0,
      })),
      measurementLayout(messages)
    )
    const estimate = vi.spyOn(messagePretextLayout, 'getMessagePretextIntrinsicHeight')
    render(
      <MessageList
        conversationKey="reopened-conversation"
        messages={messages}
        scrollElementRef={{ current: createScrollElement(200) }}
      />
    )
    expect(estimate).not.toHaveBeenCalled()
    const options = useVirtualizerMock.mock.lastCall![0]
    expect(options.estimateSize(0)).toBe(987)
    expect(options.initialOffset()).toBe(32 + 20 * 987 + 19 * 16 + 8 - 200)
  })

  test('estimates only rows missing from a restored measurement snapshot', () => {
    const messages = buildMessages(2, 'partial')
    cacheConversationVirtualMeasurements(
      'partial-measurements',
      [{ key: 'user-0', index: 0, size: 987, start: 32, end: 1019, lane: 0 }],
      measurementLayout(messages)
    )
    const estimate = vi.spyOn(messagePretextLayout, 'getMessagePretextIntrinsicHeight')
    render(
      <MessageList
        conversationKey="partial-measurements"
        messages={messages}
        scrollElementRef={{ current: createScrollElement(200) }}
      />
    )
    expect(estimate).toHaveBeenCalled()
    expect(new Set(estimate.mock.calls.map(([message]) => message.id))).toEqual(new Set(['user-1']))
  })

  test('does not prepare intrinsic heights when no virtual viewport is used', () => {
    const estimate = vi.spyOn(messagePretextLayout, 'getMessagePretextIntrinsicHeight')
    render(<MessageList messages={buildMessages(2, 'ordinary')} />)
    expect(screen.getAllByTestId('message-user')).toHaveLength(2)
    expect(estimate).not.toHaveBeenCalled()
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

function measurementLayout(messages: WorkbenchMessage[]) {
  return {
    key: JSON.stringify([
      800,
      null,
      messagePretextLayout.readMessageLayoutTypography(createScrollElement(200)),
      0,
    ]),
    messages: new Map(
      messages.map(message => [message.id, messagePretextLayout.getMessageLayoutSignature(message)])
    ),
  }
}
