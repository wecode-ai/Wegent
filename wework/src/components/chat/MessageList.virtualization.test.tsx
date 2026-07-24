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
    const message = {
      id: 'user-0',
      role: 'user' as const,
      content: 'restored message',
      status: 'done' as const,
      createdAt: '2026-07-24T00:00:00Z',
    }
    const props = {
      messages: [message],
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
})
