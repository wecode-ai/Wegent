import { act, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  mergeRuntimeConversationTurns,
  projectRuntimeConversationTurns,
  reduceRuntimeConversationTurns,
} from '@/features/workbench/runtimeConversationTurns'
import { runtimeTranscriptTurnsToConversationTurns } from '@/features/workbench/runtimePaneMessages'
import type { RuntimeTranscriptTurn } from '@/types/api'
import type { RuntimeConversationTurn, WorkbenchMessage } from '@/types/workbench'
import { MessageList } from './MessageList'
import '@/i18n'

afterEach(() => vi.useRealTimers())

describe('MessageList processing duration', () => {
  test('uses the completion timestamp of a hidden thinking block', () => {
    vi.useFakeTimers()
    const start = Date.parse('2026-09-17T00:00:00Z')
    const message: WorkbenchMessage = {
      id: 'thinking-only',
      role: 'assistant',
      content: 'Done',
      status: 'done',
      createdAt: new Date(start).toISOString(),
      blocks: [
        {
          id: 'thinking',
          type: 'thinking',
          content: 'Thinking',
          status: 'done',
          createdAt: start,
          completedAt: start + 5000,
        },
      ],
    }
    render(<MessageList messages={[message]} />)
    expect(screen.getByTestId('processing-duration-label')).toHaveTextContent('用时 5秒')
    act(() => vi.advanceTimersByTime(10000))
    expect(screen.getByTestId('processing-duration-label')).toHaveTextContent('用时 5秒')
  })

  test.each(['done', 'failed', 'cancelled'] as const)(
    'preserves a %s turn duration when transcript timestamps lose millisecond precision',
    status => {
      vi.useFakeTimers()
      const start = Date.parse('2026-09-17T02:18:14.982Z')
      const end = Date.parse('2026-09-17T02:18:32.300Z')
      vi.setSystemTime(end)
      const turn: RuntimeConversationTurn = {
        id: 'rounded-transcript',
        status,
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
      const first = render(<MessageList messages={projectRuntimeConversationTurns([turn])} />)
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
      expect(screen.getByTestId(selector).textContent).toBe(frozen)
      act(() => vi.advanceTimersByTime(10000))
      restored.rerender(
        <MessageList
          messages={projectRuntimeConversationTurns(
            mergeRuntimeConversationTurns(merged, [snapshot])
          )}
        />
      )
      expect(screen.getByTestId(selector).textContent).toBe(frozen)
    }
  )

  test.each(['failed', 'done', 'cancelled'] as const)(
    'freezes a %s turn despite a tool retaining its streaming status',
    status => {
      vi.useFakeTimers()
      const start = Date.parse('2026-09-17T00:00:00Z')
      vi.setSystemTime(start)
      let turns: RuntimeConversationTurn[] = [
        { id: 'terminal-timer', status: 'streaming', items: [] },
      ]
      turns = reduceRuntimeConversationTurns(turns, {
        type: 'block_created',
        subtaskId: 'terminal-timer',
        block: {
          id: 'unfinished-tool',
          type: 'tool',
          toolName: 'exec_command',
          toolInput: { command: 'pwd' },
          status: 'streaming',
          createdAt: start,
        },
      })
      const first = render(<MessageList messages={projectRuntimeConversationTurns(turns)} />)
      act(() => vi.advanceTimersByTime(5000))
      expect(screen.getByTestId('processing-duration-label')).toHaveTextContent('已处理 5秒')
      if (status === 'done') {
        turns = [{ ...turns[0], status, completedAt: new Date().toISOString() }]
      } else {
        turns = reduceRuntimeConversationTurns(
          turns,
          status === 'failed'
            ? {
                type: 'assistant_error',
                subtaskId: 'terminal-timer',
                error: 'upstream unavailable',
              }
            : { type: 'assistant_cancelled', subtaskId: 'terminal-timer' }
        )
      }
      expect(turns[0].completedAt).toBe(new Date(start + 5000).toISOString())
      expect(turns[0].items[0]).toMatchObject({ block: { status: 'streaming' } })
      const messages = projectRuntimeConversationTurns(turns)
      const expectFrozenDuration = () => {
        if (status === 'cancelled') {
          expect(screen.queryByTestId('processing-duration-label')).not.toBeInTheDocument()
          expect(screen.getByTestId('assistant-stopped-notice')).toHaveTextContent('5s')
        } else {
          expect(screen.getByTestId('processing-duration-label')).toHaveTextContent('用时 5秒')
        }
      }
      first.rerender(<MessageList messages={messages} />)
      expectFrozenDuration()
      act(() => vi.advanceTimersByTime(10000))
      expectFrozenDuration()
      first.unmount()
      render(<MessageList messages={messages} />)
      expectFrozenDuration()
    }
  )

  test('restores the stopped and resumed durations from their own turn completion timestamps', () => {
    const start = Date.parse('2026-09-16T15:41:32.813Z')
    const resumedStart = start + 17_000
    const transcript: RuntimeTranscriptTurn[] = [
      { id: 'stopped', status: 'cancelled', stoppedNotice: true, completedAt: start + 13_000 },
      { id: 'resumed', status: 'done', completedAt: resumedStart + 72_000 },
    ].map((turn, index) => {
      const createdAt = index === 0 ? start : resumedStart
      return {
        ...turn,
        items: [
          {
            id: `user-${turn.id}`,
            type: 'user_message',
            message: {
              id: `user-${turn.id}`,
              role: 'user',
              content: index === 0 ? '检查代码' : '继续',
              createdAt: new Date(createdAt).toISOString(),
            },
          },
          {
            id: `tool-${turn.id}`,
            type: 'block',
            block: {
              id: `tool-${turn.id}`,
              type: 'tool',
              toolName: 'exec_command',
              toolInput: { command: 'pwd' },
              status: 'done',
              createdAt,
              completedAt: turn.completedAt,
            },
          },
          {
            id: `answer-${turn.id}`,
            type: 'assistant_text',
            content: index === 0 ? '我检查计时边界。' : '继续检查完成。',
            // Transcript items without timestamps inherit the turn start.
            createdAt,
          },
        ],
      }
    })
    const messages = projectRuntimeConversationTurns(
      runtimeTranscriptTurnsToConversationTurns(transcript)
    )
    const first = render(<MessageList messages={messages} />)
    expect(screen.getByTestId('assistant-stopped-notice')).toHaveTextContent('13s')
    expect(screen.getByTestId('processing-duration-label')).toHaveTextContent('用时 1分钟 12秒')
    first.unmount()
    render(<MessageList messages={messages} />)
    expect(screen.getByTestId('processing-duration-label')).toHaveTextContent('用时 1分钟 12秒')
  })

  test('keeps timing a running tool when visible text has already arrived', () => {
    vi.useFakeTimers()
    const start = Date.parse('2026-09-16T10:00:00Z')
    vi.setSystemTime(start + 3000)
    const message: WorkbenchMessage = {
      id: 'running-tool-duration',
      role: 'assistant',
      content: '继续检查。',
      status: 'streaming',
      createdAt: new Date(start + 1000).toISOString(),
      runtimeTurnStartedAt: start,
      blocks: [
        {
          id: 'tool',
          type: 'tool',
          toolName: 'exec_command',
          status: 'streaming',
          createdAt: start + 2000,
        },
      ],
    }
    render(<MessageList messages={[message]} />)
    expect(screen.getByTestId('processing-duration-label')).toHaveTextContent('已处理 3秒')
    act(() => vi.advanceTimersByTime(2000))
    expect(screen.getByTestId('processing-duration-label')).toHaveTextContent('已处理 5秒')
  })

  test('keeps timing through final answer streaming and freezes only when the turn completes', () => {
    vi.useFakeTimers()
    const start = Date.parse('2026-09-16T10:00:00Z')
    vi.setSystemTime(start + 5000)
    const turn: RuntimeConversationTurn = {
      id: 'interleaved-duration',
      status: 'streaming',
      items: [
        {
          id: 'user',
          type: 'user_message',
          message: {
            id: 'user',
            role: 'user',
            content: '继续',
            createdAt: new Date(start).toISOString(),
          },
        },
        {
          id: 'partial',
          type: 'assistant_text',
          content: '继续检查。',
          createdAt: new Date(start + 1000).toISOString(),
        },
        {
          id: 'tool',
          type: 'block',
          block: {
            id: 'tool',
            type: 'tool',
            toolName: 'exec_command',
            status: 'done',
            createdAt: start + 2000,
            completedAt: start + 4000,
          },
        },
      ],
    }
    const pendingMessages = projectRuntimeConversationTurns([turn])
    const { rerender } = render(<MessageList messages={pendingMessages} />)
    expect(screen.getByTestId('processing-duration-label')).toHaveTextContent('已处理 5秒')
    act(() => vi.advanceTimersByTime(3000))
    expect(screen.getByTestId('processing-duration-label')).toHaveTextContent('已处理 8秒')

    const finalTurn: RuntimeConversationTurn = {
      ...turn,
      items: [
        ...turn.items,
        {
          id: 'final',
          type: 'assistant_text',
          content: '检查完成。',
          createdAt: new Date(start + 8000).toISOString(),
        },
      ],
    }
    const finalMessages = projectRuntimeConversationTurns([finalTurn])
    rerender(<MessageList messages={finalMessages} />)
    expect(screen.getByTestId('processing-duration-label')).toHaveTextContent('已处理 8秒')
    act(() => vi.advanceTimersByTime(1000))
    expect(screen.getByTestId('processing-duration-label')).toHaveTextContent('已处理 9秒')
    act(() => vi.advanceTimersByTime(1000))
    expect(screen.getByTestId('processing-duration-label')).toHaveTextContent('已处理 10秒')
    rerender(
      <MessageList
        messages={projectRuntimeConversationTurns([
          { ...finalTurn, status: 'done', completedAt: start + 10_000 },
        ])}
      />
    )
    expect(screen.getByTestId('processing-duration-label')).toHaveTextContent('用时 10秒')
    act(() => vi.advanceTimersByTime(5000))
    expect(screen.getByTestId('processing-duration-label')).toHaveTextContent('用时 10秒')
  })
})
