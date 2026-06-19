import '@/i18n'

import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { ToolBlocksDisplay } from './ToolBlocksDisplay'
import type { ProcessingBlock } from '@/types/workbench'

const completedCommandBlock: ProcessingBlock = {
  id: 'call-1',
  subtaskId: 1,
  type: 'tool',
  toolName: 'bash',
  toolInput: { command: 'pwd' },
  status: 'done',
  createdAt: 1770000000000,
}

const TURN_STARTED_AT = new Date('2026-06-05T00:00:00.000Z').getTime()
const TURN_COMPLETED_AT = new Date('2026-06-05T00:00:03.000Z').getTime()

describe('ToolBlocksDisplay', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  test('groups completed tools into an activity summary', () => {
    render(
      <ToolBlocksDisplay
        blocks={[completedCommandBlock]}
        isStreaming={false}
        startedAt={TURN_STARTED_AT}
        endedAt={TURN_COMPLETED_AT}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /用时/ }))

    expect(screen.getByText('已运行 1 条命令')).toBeInTheDocument()
    expect(screen.queryByText('已运行 pwd')).not.toBeInTheDocument()
  })

  test('uses the persisted completion time when the run finishes', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-05T00:00:00.000Z'))

    const runningBlock: ProcessingBlock = {
      ...completedCommandBlock,
      status: 'streaming',
      createdAt: Date.now(),
    }
    const { rerender } = render(
      <ToolBlocksDisplay
        blocks={[runningBlock]}
        isStreaming={true}
        startedAt={TURN_STARTED_AT}
      />
    )

    act(() => {
      vi.advanceTimersByTime(3000)
    })

    rerender(
      <ToolBlocksDisplay
        blocks={[{ ...runningBlock, status: 'done' }]}
        isStreaming={false}
        startedAt={TURN_STARTED_AT}
        endedAt={TURN_COMPLETED_AT}
      />
    )

    expect(screen.getByRole('button', { name: /用时 3 秒/ })).toBeInTheDocument()
  })

  test('formats live duration with natural Chinese units', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-05T00:00:00.000Z'))

    const runningBlock: ProcessingBlock = {
      ...completedCommandBlock,
      status: 'streaming',
      createdAt: Date.now(),
    }

    render(
      <ToolBlocksDisplay
        blocks={[runningBlock]}
        isStreaming={true}
        startedAt={Date.now()}
      />
    )

    act(() => {
      vi.advanceTimersByTime(62000)
    })

    expect(screen.getByText(/已处理 1 分 2 秒/)).toBeInTheDocument()
  })

  test('keeps ticking while streaming even when all tool blocks are done', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-05T00:00:00.000Z'))

    // All blocks are done but the model is still streaming (pure thinking
    // phase with no new tool output). The timer must keep advancing.
    const doneBlock: ProcessingBlock = {
      ...completedCommandBlock,
      status: 'done',
      createdAt: Date.now(),
    }

    render(
      <ToolBlocksDisplay blocks={[doneBlock]} isStreaming={true} startedAt={Date.now()} />
    )

    act(() => {
      vi.advanceTimersByTime(5000)
    })

    expect(screen.getByText('已处理 5 秒')).toBeInTheDocument()
  })

  test('anchors the running duration to the turn start, surviving a refresh', () => {
    vi.useFakeTimers()
    // The page was refreshed 10s into a still-running turn.
    vi.setSystemTime(new Date('2026-06-05T00:00:10.000Z'))

    // After a refresh the in-progress blocks are re-streamed with fresh client
    // timestamps (createdAt === now), so anchoring to the first block would
    // restart the timer. The turn actually started 10s ago.
    const restreamedBlock: ProcessingBlock = {
      ...completedCommandBlock,
      status: 'streaming',
      createdAt: Date.now(),
    }
    const turnStart = new Date('2026-06-05T00:00:00.000Z').getTime()

    render(
      <ToolBlocksDisplay blocks={[restreamedBlock]} isStreaming={true} startedAt={turnStart} />
    )

    act(() => {
      vi.advanceTimersByTime(0)
    })

    expect(screen.getByText('已处理 10 秒')).toBeInTheDocument()
  })

  test('uses the message completion time for restored history when the answer is not a block', () => {
    const turnStart = new Date('2026-06-05T00:00:00.000Z').getTime()
    const turnEnd = new Date('2026-06-05T00:00:47.000Z').getTime()
    const thinkingOnlyBlock: ProcessingBlock = {
      id: 'thinking-1',
      subtaskId: 1,
      type: 'thinking',
      content: 'Drafting the answer',
      status: 'done',
      createdAt: turnStart + 3000,
    }

    render(
      <ToolBlocksDisplay
        blocks={[thinkingOnlyBlock]}
        isStreaming={false}
        startedAt={turnStart}
        endedAt={turnEnd}
      />
    )

    expect(screen.getByRole('button', { name: /用时 47 秒/ })).toBeInTheDocument()
  })

  test('renders the header as plain text (not a button) while running', () => {
    const startedAt = Date.now()
    const runningBlock: ProcessingBlock = {
      ...completedCommandBlock,
      status: 'streaming',
      createdAt: startedAt,
    }

    render(
      <ToolBlocksDisplay blocks={[runningBlock]} isStreaming={true} startedAt={startedAt} />
    )

    // While running the summary is informational only and must not be clickable.
    expect(screen.queryByRole('button', { name: /已处理/ })).not.toBeInTheDocument()
    expect(screen.getByText(/已处理 .* 秒/)).toBeInTheDocument()
  })

  test('does not duplicate the generic thinking indicator when live thinking is visible', () => {
    const thinkingBlock: ProcessingBlock = {
      id: 'thinking-1',
      subtaskId: 1,
      type: 'thinking',
      content: 'Reading files',
      status: 'streaming',
      createdAt: 1770000000000,
    }

    render(
      <ToolBlocksDisplay
        blocks={[thinkingBlock]}
        isStreaming={true}
        startedAt={thinkingBlock.createdAt}
      />
    )

    expect(screen.getByTestId('thinking-live-preview')).toBeInTheDocument()
    expect(screen.queryByTestId('thinking-indicator')).not.toBeInTheDocument()
  })

  test('does not duplicate the generic thinking indicator when live process text is visible', () => {
    const textBlock: ProcessingBlock = {
      id: 'text-1',
      subtaskId: 1,
      type: 'text',
      content: 'Let me explore the repository structure.',
      status: 'streaming',
      createdAt: 1770000000000,
    }

    render(
      <ToolBlocksDisplay blocks={[textBlock]} isStreaming={true} startedAt={textBlock.createdAt} />
    )

    expect(screen.getByTestId('process-text-block')).toBeInTheDocument()
    expect(screen.queryByTestId('thinking-indicator')).not.toBeInTheDocument()
  })

  test('can suppress the generic thinking indicator while a turn remains streaming', () => {
    const startedAt = Date.now()
    render(
      <ToolBlocksDisplay
        blocks={[{ ...completedCommandBlock, createdAt: startedAt }]}
        isStreaming={true}
        startedAt={startedAt}
        showThinkingIndicator={false}
      />
    )

    expect(screen.getByText(/已处理 .* 秒/)).toBeInTheDocument()
    expect(screen.queryByTestId('thinking-indicator')).not.toBeInTheDocument()
  })
})
