import { render, screen } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import { MessageList } from './MessageList'
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
  useVirtualizer: (options: { count: number }) => {
    useVirtualizerMock(options)
    return {
      getTotalSize: () => 10_000,
      getVirtualItems: () =>
        [
          { index: 0, key: 'user-0', start: 0 },
          { index: 1, key: 'user-1', start: 120 },
        ].slice(0, options.count),
      measureElement: vi.fn(),
      takeSnapshot: () => [{ index: 0, key: 'user-0', start: 32, end: 132, size: 100, lane: 0 }],
    }
  },
}))

describe('MessageList Tauri virtualization', () => {
  test('keeps short conversations in normal document flow', () => {
    const scrollElement = document.createElement('div')

    render(
      <MessageList
        messages={Array.from({ length: 3 }, (_, index) => ({
          id: `short-user-${index}`,
          role: 'user' as const,
          content: `short message ${index}`,
          status: 'done' as const,
          createdAt: '2026-07-24T00:00:00Z',
        }))}
        scrollElementRef={{ current: scrollElement }}
      />
    )

    expect(screen.getAllByTestId('message-user')).toHaveLength(3)
    expect(
      screen.getByText('short message 0').closest('[data-message-id]')?.parentElement
    ).not.toHaveStyle({ position: 'absolute' })
  })

  test('keeps messages outside the virtual range out of the DOM', () => {
    const scrollElement = document.createElement('div')

    render(
      <MessageList
        messages={Array.from({ length: 100 }, (_, index) => ({
          id: `user-${index}`,
          role: 'user' as const,
          content: `message ${index}`,
          status: 'done' as const,
          createdAt: '2026-07-24T00:00:00Z',
        }))}
        scrollElementRef={{ current: scrollElement }}
      />
    )

    expect(screen.getAllByTestId('message-user')).toHaveLength(2)
    expect(screen.getByText('message 0')).toBeInTheDocument()
    expect(screen.getByText('message 1')).toBeInTheDocument()
    expect(screen.queryByText('message 99')).not.toBeInTheDocument()
  })

  test('restores measured message geometry after the conversation remounts', () => {
    const messages = Array.from({ length: 100 }, (_, index) => ({
      id: `user-${index}`,
      role: 'user' as const,
      content: index === 0 ? 'restored message' : `message ${index}`,
      status: 'done' as const,
      createdAt: '2026-07-24T00:00:00Z',
    }))
    const props = {
      messages,
      conversationKey: 'conversation-with-measurements',
      scrollElementRef: { current: document.createElement('div') },
    }
    const firstRender = render(<MessageList {...props} />)
    firstRender.unmount()
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

  test('keeps a navigation target in the virtual range while it settles', () => {
    const messages = Array.from({ length: 100 }, (_, index) => ({
      id: `user-${index}`,
      role: 'user' as const,
      content: `message ${index}`,
      status: 'done' as const,
      createdAt: '2026-07-24T00:00:00Z',
    }))

    render(
      <MessageList
        messages={messages}
        scrollElementRef={{ current: document.createElement('div') }}
        forceVirtualMessageId="user-80"
      />
    )

    const options = useVirtualizerMock.mock.lastCall?.[0] as {
      rangeExtractor: (range: {
        startIndex: number
        endIndex: number
        overscan: number
        count: number
      }) => number[]
    }
    expect(options.rangeExtractor({ startIndex: 0, endIndex: 2, overscan: 2, count: 100 })).toEqual(
      [0, 1, 2, 80]
    )
  })
})
