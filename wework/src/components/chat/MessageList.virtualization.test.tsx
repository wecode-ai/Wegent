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
  observeElementOffsetMock,
  resizeItemMock,
  useVirtualizerMock,
  virtualizerInstances,
} = vi.hoisted(() => ({
  measureElementMock: vi.fn(),
  observeElementOffsetMock: vi.fn(),
  resizeItemMock: vi.fn(),
  useVirtualizerMock: vi.fn(),
  virtualizerInstances: [] as Array<Record<string, unknown>>,
}))

vi.mock('@/lib/runtime-environment', () => ({
  isDesktopRuntime: () => true,
  isElectronRuntime: () => true,
}))

vi.mock('@tanstack/react-virtual', () => ({
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
      getDistanceFromEnd: () => 0,
      getTotalSize: () => 10_000,
      getVirtualItems: () =>
        visibleIndexes.map(index => ({
          index,
          key: options.getItemKey(index),
          start: index * 120,
          size: 100,
          end: index * 120 + 100,
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
    observeElementOffsetMock.mockClear()
    resizeItemMock.mockClear()
    useVirtualizerMock.mockClear()
    virtualizerInstances.length = 0
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
    expect(listElement).toHaveStyle({ height: '3940px' })
    expect(scrollElement.scrollTop).toBe(-200)

    expect(shouldAdjustScrollPosition?.({ key: 'user-18', start: 8_000 }, 40, instance)).toBe(false)
    expect(listElement).toHaveStyle({ height: '3940px' })
    expect(scrollElement.scrollTop).toBe(-200)

    expect(shouldAdjustScrollPosition?.({ key: 'user-19', start: 9_000 }, -40, instance)).toBe(
      false
    )
    expect(listElement).toHaveStyle({ height: '3940px' })
    expect(scrollElement.scrollTop).toBe(-200)

    scrollElement.scrollTop = 0
    expect(shouldAdjustScrollPosition?.({ key: 'user-19', start: 9_000 }, 40, instance)).toBe(false)
    expect(listElement).toHaveStyle({ height: '3940px' })
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

  test('remeasures mounted rows after guidance changes the message sequence', () => {
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
      bottom: 180,
      height: 180,
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

    expect(resizeItemMock).toHaveBeenCalledWith(2, 180)
  })

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

  test('synchronously remeasures an active streaming row after its content changes', () => {
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
      bottom: 320,
      height: 320,
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

    expect(resizeItemMock).toHaveBeenCalledWith(80, 320)
  })

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
