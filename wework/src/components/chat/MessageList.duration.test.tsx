import {
  mergeRuntimeConversationTurns,
  projectRuntimeConversationTurns,
} from '@/features/workbench/runtimeConversationTurns'
import '@/i18n'
import type { RuntimeConversationTurn } from '@/types/workbench'
import { act, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { MessageList } from './MessageList'
import { ScrollableMessageArea } from './ScrollableMessageArea'

afterEach(() => vi.useRealTimers())

describe('MessageList processing duration', () => {
  test('times only the latest native turn without rewriting unfinished historical state', () => {
    vi.useFakeTimers()
    const startedAt = Date.parse('2026-09-17T00:00:00Z')
    vi.setSystemTime(startedAt + 24 * 60 * 60_000)
    const turns: RuntimeConversationTurn[] = ['old', 'current'].map((id, index) => ({
      id,
      status: 'streaming',
      startedAt: index ? Date.now() : startedAt,
      items: [
        {
          id: `${id}-tool`,
          type: 'block',
          block: {
            id: `${id}-tool`,
            type: 'tool',
            toolName: 'exec_command',
            status: 'streaming',
            createdAt: index ? Date.now() : startedAt,
            toolInput: { command: 'pwd' },
          },
        },
      ],
    }))
    const { container } = render(
      <MessageList messages={projectRuntimeConversationTurns(turns)} turns={turns} />
    )
    const old = container.querySelector('[data-message-id="runtime-view:old:assistant"]')!
    const current = container.querySelector('[data-message-id="runtime-view:current:assistant"]')!
    expect(old.querySelector('[data-testid="processing-duration-label"]')).toBeNull()
    act(() => vi.advanceTimersByTime(10_000))
    expect(current.querySelector('[data-testid="processing-duration-label"]')).toHaveTextContent(
      '已处理 10秒'
    )
    expect(turns[0].status).toBe('streaming')
    expect(turns[0].completedAt).toBeUndefined()
  })
  test.each([
    { name: 'message list', Conversation: MessageList },
    { name: 'scrollable conversation', Conversation: ScrollableMessageArea },
  ])(
    'updates turn metadata without requiring a different message array in $name',
    ({ Conversation }) => {
      const startedAt = Date.parse('2026-10-28T00:00:00Z')
      const turn: RuntimeConversationTurn = {
        id: 'metadata-only',
        status: 'failed',
        startedAt,
        completedAt: startedAt + 5000,
        durationMs: 5000,
        error: 'upstream unavailable',
        items: [],
      }
      const messages = projectRuntimeConversationTurns([turn])
      const view = render(<Conversation messages={messages} turns={[turn]} />)
      expect(screen.getByTestId('processing-duration-label')).toHaveTextContent('用时 5秒')
      view.rerender(
        <Conversation
          messages={messages}
          turns={[{ ...turn, completedAt: startedAt + 12000, durationMs: 12000 }]}
        />
      )
      expect(screen.getByTestId('processing-duration-label')).toHaveTextContent('用时 12秒')
    }
  )

  test.each(['failed', 'cancelled'] as const)(
    'preserves a %s turn duration when transcript timestamps lose millisecond precision',
    status => {
      vi.useFakeTimers()
      const start = Date.parse('2026-09-17T02:18:14.982Z')
      const end = Date.parse('2026-09-17T02:18:32.300Z')
      vi.setSystemTime(end)
      const turn: RuntimeConversationTurn = {
        id: 'rounded-transcript',
        status,
        startedAt: start,
        durationMs: end - start,
        completedAt: new Date(end).toISOString(),
        items: [
          {
            id: 'user',
            type: 'user_message',
            message: {
              id: 'user',
              role: 'user',
              content: 'Check',
              createdAt: new Date(start).toISOString(),
            },
          },
          {
            id: 'tool',
            type: 'block',
            block: {
              id: 'tool',
              type: 'tool',
              toolName: 'exec_command',
              status: 'done',
              createdAt: start + 200,
              completedAt: end - 2000,
            },
          },
        ],
      }
      const first = render(
        <MessageList messages={projectRuntimeConversationTurns([turn])} turns={[turn]} />
      )
      const selector =
        status === 'cancelled' ? 'assistant-stopped-notice' : 'processing-duration-label'
      const frozen = screen.getByTestId(selector).textContent
      expect(frozen).toContain(status === 'cancelled' ? '17s' : '17秒')
      first.unmount()
      const snapshot: RuntimeConversationTurn = {
        ...turn,
        completedAt: Math.floor(end / 1000) * 1000,
        items: turn.items.map(item =>
          item.type === 'user_message'
            ? {
                ...item,
                message: {
                  ...item.message,
                  createdAt: new Date(Math.floor(start / 1000) * 1000).toISOString(),
                },
              }
            : item
        ),
      }
      const merged = mergeRuntimeConversationTurns([turn], [snapshot])
      const restored = render(<MessageList messages={projectRuntimeConversationTurns(merged)} />)
      restored.rerender(
        <MessageList messages={projectRuntimeConversationTurns(merged)} turns={merged} />
      )
      expect(screen.getByTestId(selector).textContent).toBe(frozen)
      act(() => vi.advanceTimersByTime(10000))
      restored.rerender(
        <MessageList
          messages={projectRuntimeConversationTurns(
            mergeRuntimeConversationTurns(merged, [snapshot])
          )}
          turns={mergeRuntimeConversationTurns(merged, [snapshot])}
        />
      )
      expect(screen.getByTestId(selector).textContent).toBe(frozen)
    }
  )
})
