import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { MessageList } from './MessageList'
import {
  clearRuntimeConversationCacheForTests,
  getConversationVirtualMeasurements,
} from '@/features/workbench/runtimeConversationCache'
import type { WorkbenchMessage } from '@/types/workbench'
import '@/i18n'

const { useVirtualizerMock } = vi.hoisted(() => ({
  useVirtualizerMock: vi.fn(),
}))

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
    useVirtualizerMock(options)
    const visibleIndexes = options.rangeExtractor({
      startIndex: Math.max(0, options.count - 2),
      endIndex: options.count - 1,
      overscan: 2,
      count: options.count,
    })
    return {
      getDistanceFromEnd: () => 0,
      getTotalSize: () => 10_000,
      getVirtualItems: () =>
        visibleIndexes.map(index => ({
          index,
          key: options.getItemKey(index),
          start: index * 120,
        })),
      measureElement: vi.fn(),
      takeSnapshot: () => [
        { index: 0, key: options.getItemKey(0), start: 32, end: 132, size: 100, lane: 0 },
      ],
    }
  },
}))

describe('MessageList Tauri virtualization', () => {
  afterEach(() => {
    clearRuntimeConversationCacheForTests()
    useVirtualizerMock.mockClear()
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
