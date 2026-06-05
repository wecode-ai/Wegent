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

describe('ToolBlocksDisplay', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  test('groups completed tools into an activity summary', () => {
    render(<ToolBlocksDisplay blocks={[completedCommandBlock]} isStreaming={false} />)

    fireEvent.click(screen.getByRole('button', { name: /已处理/ }))

    expect(screen.getByText('已运行 1 条命令')).toBeInTheDocument()
    expect(screen.queryByText('已运行 pwd')).not.toBeInTheDocument()
  })

  test('keeps live duration when the run finishes', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-05T00:00:00.000Z'))

    const runningBlock: ProcessingBlock = {
      ...completedCommandBlock,
      status: 'streaming',
      createdAt: Date.now(),
    }
    const { rerender } = render(
      <ToolBlocksDisplay blocks={[runningBlock]} isStreaming={true} />
    )

    act(() => {
      vi.advanceTimersByTime(3000)
    })

    rerender(
      <ToolBlocksDisplay
        blocks={[{ ...runningBlock, status: 'done' }]}
        isStreaming={false}
      />
    )

    act(() => {
      vi.advanceTimersByTime(0)
    })

    expect(
      screen.getByRole('button', { name: /已处理 3s 时间了/ })
    ).toBeInTheDocument()
  })
})
