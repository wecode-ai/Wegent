import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { MessageList } from './MessageList'
import {
  clearRuntimeConversationCacheForTests,
  getConversationVirtualMeasurements,
} from '@/features/workbench/runtimeConversationCache'
import type { WorkbenchMessage } from '@/types/workbench'
import '@/i18n'

const { measureElementMock, resizeItemMock, useVirtualizerMock, virtualizerInstances } = vi.hoisted(
  () => ({
    measureElementMock: vi.fn(),
    resizeItemMock: vi.fn(),
    useVirtualizerMock: vi.fn(),
    virtualizerInstances: [] as Array<Record<string, unknown>>,
  })
)

vi.mock('@/lib/runtime-environment', () => ({
  isTauriRuntime: () => true,
}))

vi.mock('@tanstack/react-virtual', () => ({
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

describe('MessageList Tauri virtualization', () => {
  afterEach(() => {
    clearRuntimeConversationCacheForTests()
    measureElementMock.mockClear()
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
      })
    )
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
