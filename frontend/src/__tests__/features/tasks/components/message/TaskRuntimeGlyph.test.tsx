// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { act, render, screen } from '@testing-library/react'

import { TaskRuntimeGlyph } from '@/features/tasks/components/message/TaskRuntimeGlyph'
import type { TaskStateData } from '@/features/tasks/state'

function createTaskState(taskId: number): TaskStateData {
  return {
    taskId,
    status: 'ready',
    messages: new Map(),
    streamingSubtaskId: null,
    streamingInfo: null,
    error: null,
    isStopping: false,
    runtime: {
      taskId,
      phase: 'terminal',
      joinedRoom: false,
      localStreamCursor: 0,
    },
    derived: {
      isExecutionActive: false,
      isTerminal: true,
      isStreaming: false,
      shouldJoinRoom: false,
      canSendMessage: true,
      canQueueMessage: false,
      canCancelTask: false,
      blocksQueuedDispatch: false,
    },
  }
}

describe('TaskRuntimeGlyph', () => {
  beforeEach(() => {
    jest.useFakeTimers()
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it('shows the runtime glyph only after it remains visible for three seconds', () => {
    render(<TaskRuntimeGlyph taskState={createTaskState(713)} visible />)

    expect(screen.queryByTestId('task-runtime-watermark')).not.toBeInTheDocument()

    act(() => {
      jest.advanceTimersByTime(2999)
    })
    expect(screen.queryByTestId('task-runtime-watermark')).not.toBeInTheDocument()

    act(() => {
      jest.advanceTimersByTime(1)
    })
    expect(screen.getByTestId('task-runtime-watermark')).toHaveAttribute('data-task-id', '713')
  })

  it('restarts the delay when the task changes', () => {
    const { rerender } = render(<TaskRuntimeGlyph taskState={createTaskState(713)} visible />)

    act(() => {
      jest.advanceTimersByTime(3000)
    })
    expect(screen.getByTestId('task-runtime-watermark')).toHaveAttribute('data-task-id', '713')

    rerender(<TaskRuntimeGlyph taskState={createTaskState(714)} visible />)
    expect(screen.queryByTestId('task-runtime-watermark')).not.toBeInTheDocument()

    act(() => {
      jest.advanceTimersByTime(3000)
    })
    expect(screen.getByTestId('task-runtime-watermark')).toHaveAttribute('data-task-id', '714')
  })

  it('does not show a stale delayed glyph when the task changes again at the timeout boundary', () => {
    const { rerender } = render(<TaskRuntimeGlyph taskState={createTaskState(713)} visible />)

    act(() => {
      jest.advanceTimersByTime(3000)
    })
    expect(screen.getByTestId('task-runtime-watermark')).toHaveAttribute('data-task-id', '713')

    rerender(<TaskRuntimeGlyph taskState={createTaskState(714)} visible />)
    act(() => {
      jest.advanceTimersByTime(2999)
    })
    expect(screen.queryByTestId('task-runtime-watermark')).not.toBeInTheDocument()

    rerender(<TaskRuntimeGlyph taskState={createTaskState(715)} visible />)
    act(() => {
      jest.advanceTimersByTime(1)
    })
    expect(screen.queryByTestId('task-runtime-watermark')).not.toBeInTheDocument()

    act(() => {
      jest.advanceTimersByTime(2999)
    })
    expect(screen.getByTestId('task-runtime-watermark')).toHaveAttribute('data-task-id', '715')
  })
})
