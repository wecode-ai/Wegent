// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { renderHook } from '@testing-library/react'
import type { TaskRuntimeState } from '@wegent/chat-core'
import { useStreamingJoinWarning } from '@/features/tasks/components/chat/useStreamingJoinWarning'

function runtime(overrides: Partial<TaskRuntimeState>): TaskRuntimeState {
  return {
    taskId: 42,
    phase: 'unknown',
    joinedRoom: true,
    localStreamCursor: 0,
    ...overrides,
  }
}

describe('useStreamingJoinWarning', () => {
  it('does not notify when task join confirms no active stream', () => {
    const notify = jest.fn(() => ({ dismiss: jest.fn() }))

    renderHook(() =>
      useStreamingJoinWarning({
        taskId: 42,
        phase: 'unknown',
        runtime: runtime({ serverConfirmedNoStream: true }),
        translate: key => key,
        notify,
      })
    )

    expect(notify).not.toHaveBeenCalled()
  })

  it('dismisses an existing warning after task join confirms no active stream', () => {
    const dismiss = jest.fn()
    const notify = jest.fn(() => ({ dismiss }))
    const { rerender } = renderHook(
      ({ phase, taskRuntime }: { phase: string; taskRuntime: TaskRuntimeState }) =>
        useStreamingJoinWarning({
          taskId: 42,
          phase,
          runtime: taskRuntime,
          translate: key => key,
          notify,
        }),
      {
        initialProps: {
          phase: 'streaming',
          taskRuntime: runtime({
            phase: 'streaming',
            activeStreamSubtaskId: 77,
            activeStreamStartedAt: '2026-03-20T09:00:00.000Z',
            activeStreamLastActivityAt: '2026-03-20T09:01:00.000Z',
          }),
        },
      }
    )

    expect(notify).toHaveBeenCalledTimes(1)

    rerender({
      phase: 'unknown',
      taskRuntime: runtime({
        phase: 'unknown',
        serverConfirmedNoStream: true,
      }),
    })

    expect(dismiss).toHaveBeenCalledTimes(1)
  })

  it('dismisses an existing warning when streaming activity becomes fresh', () => {
    const dismiss = jest.fn()
    const notify = jest.fn(() => ({ dismiss }))
    const { rerender } = renderHook(
      ({ lastActivityAt }: { lastActivityAt: string }) =>
        useStreamingJoinWarning({
          taskId: 42,
          phase: 'streaming',
          runtime: runtime({
            phase: 'streaming',
            activeStreamSubtaskId: 77,
            activeStreamStartedAt: '2026-03-20T09:00:00.000Z',
            activeStreamLastActivityAt: lastActivityAt,
          }),
          translate: key => key,
          notify,
        }),
      {
        initialProps: {
          lastActivityAt: '2026-03-20T09:01:00.000Z',
        },
      }
    )

    expect(notify).toHaveBeenCalledTimes(1)

    rerender({ lastActivityAt: new Date().toISOString() })

    expect(dismiss).toHaveBeenCalledTimes(1)
  })
})
