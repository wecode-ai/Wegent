// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { act, render, screen } from '@testing-library/react'

import { useChatStatusIndicator } from '@/features/tasks/hooks/useChatStatusIndicator'
import type { ChatStatusUpdatedPayload } from '@/types/socket'

const registerChatHandlers = jest.fn()
const useUser = jest.fn()
const useOptionalTaskSession = jest.fn()
let registeredHandlers: {
  onChatStatusUpdated?: (payload: ChatStatusUpdatedPayload) => void
} = {}

jest.mock('@/contexts/SocketContext', () => ({
  useSocket: () => ({
    registerChatHandlers,
  }),
}))

jest.mock('@/features/common/UserContext', () => ({
  useUser: () => useUser(),
}))

jest.mock('@/features/tasks/session/TaskSession', () => ({
  useOptionalTaskSession: () => useOptionalTaskSession(),
}))

function Harness() {
  const status = useChatStatusIndicator()
  return (
    <div>
      <div data-testid="enabled">{String(status.enabled)}</div>
      <div data-testid="task-id">{String(status.currentTaskId)}</div>
      <div data-testid="percent">{status.display?.percent ?? 'none'}</div>
    </div>
  )
}

describe('useChatStatusIndicator', () => {
  beforeEach(() => {
    registerChatHandlers.mockReset()
    registeredHandlers = {}
    useUser.mockReturnValue({
      user: {
        preferences: {
          chat_status_items: ['context-remaining'],
        },
      },
    })
    useOptionalTaskSession.mockReturnValue({
      currentTaskId: 12,
      selectedTask: { id: 12 },
      selectedTaskDetail: { id: 12 },
    })
    registerChatHandlers.mockImplementation(handlers => {
      registeredHandlers = handlers
      return () => {}
    })
  })

  test('formats the latest snapshot for the current task', () => {
    render(<Harness />)

    act(() => {
      registeredHandlers.onChatStatusUpdated?.({
        task_id: 12,
        subtask_id: 88,
        phase: 'tool_end',
        context_metrics: {
          context_window: 262144,
          reserved_output_tokens: 96000,
          available_input_tokens: 166144,
          used_input_tokens: 113167,
          remaining_input_tokens: 52977,
          remaining_percent: 31,
          display_remaining_tokens: 148977,
          display_remaining_percent: 57,
          trigger_limit: 149529,
          target_limit: 116300,
          is_over_trigger: false,
        },
      })
    })

    expect(screen.getByTestId('enabled')).toHaveTextContent('true')
    expect(screen.getByTestId('task-id')).toHaveTextContent('12')
    expect(screen.getByTestId('percent')).toHaveTextContent('57')
  })

  test('keeps the formatted snapshot even when rendering is delegated to the caller', () => {
    render(<Harness />)

    act(() => {
      registeredHandlers.onChatStatusUpdated?.({
        task_id: 12,
        subtask_id: 88,
        phase: 'tool_end',
        context_metrics: {
          context_window: 262144,
          reserved_output_tokens: 96000,
          available_input_tokens: 166144,
          used_input_tokens: 113167,
          remaining_input_tokens: 52977,
          remaining_percent: 31,
          display_remaining_tokens: 148977,
          display_remaining_percent: 57,
          trigger_limit: 149529,
          target_limit: 116300,
          is_over_trigger: false,
        },
      })
    })

    expect(screen.getByTestId('enabled')).toHaveTextContent('true')
    expect(screen.getByTestId('task-id')).toHaveTextContent('12')
    expect(screen.getByTestId('percent')).toHaveTextContent('57')
  })

  test('falls back to persisted snapshot from latest AI message before any live event arrives', () => {
    const messages = new Map<string, unknown>([
      [
        'm1',
        {
          id: 'm1',
          type: 'ai',
          subtaskId: 41,
          timestamp: 100,
          result: {
            context_metrics: {
              context_window: 262144,
              reserved_output_tokens: 96000,
              available_input_tokens: 166144,
              used_input_tokens: 50000,
              remaining_input_tokens: 116144,
              remaining_percent: 70,
              display_remaining_tokens: 212144,
              display_remaining_percent: 81,
              trigger_limit: 149529,
              target_limit: 116300,
              is_over_trigger: false,
            },
          },
        },
      ],
      [
        'm2',
        {
          id: 'm2',
          type: 'ai',
          subtaskId: 42,
          timestamp: 200,
          result: {
            context_metrics: {
              context_window: 262144,
              reserved_output_tokens: 96000,
              available_input_tokens: 166144,
              used_input_tokens: 113167,
              remaining_input_tokens: 52977,
              remaining_percent: 31,
              display_remaining_tokens: 148977,
              display_remaining_percent: 42,
              trigger_limit: 149529,
              target_limit: 116300,
              is_over_trigger: false,
            },
          },
        },
      ],
    ])
    useOptionalTaskSession.mockReturnValue({
      currentTaskId: 12,
      selectedTask: { id: 12 },
      selectedTaskDetail: { id: 12 },
      messages,
    })

    render(<Harness />)

    expect(screen.getByTestId('percent')).toHaveTextContent('42')
  })

  test('live event overrides the persisted fallback', () => {
    const messages = new Map<string, unknown>([
      [
        'm1',
        {
          id: 'm1',
          type: 'ai',
          subtaskId: 41,
          timestamp: 100,
          result: {
            context_metrics: {
              context_window: 262144,
              reserved_output_tokens: 96000,
              available_input_tokens: 166144,
              used_input_tokens: 50000,
              remaining_input_tokens: 116144,
              remaining_percent: 70,
              display_remaining_tokens: 212144,
              display_remaining_percent: 81,
              trigger_limit: 149529,
              target_limit: 116300,
              is_over_trigger: false,
            },
          },
        },
      ],
    ])
    useOptionalTaskSession.mockReturnValue({
      currentTaskId: 12,
      selectedTask: { id: 12 },
      selectedTaskDetail: { id: 12 },
      messages,
    })

    render(<Harness />)
    expect(screen.getByTestId('percent')).toHaveTextContent('81')

    act(() => {
      registeredHandlers.onChatStatusUpdated?.({
        task_id: 12,
        subtask_id: 88,
        phase: 'tool_end',
        context_metrics: {
          context_window: 262144,
          reserved_output_tokens: 96000,
          available_input_tokens: 166144,
          used_input_tokens: 113167,
          remaining_input_tokens: 52977,
          remaining_percent: 31,
          display_remaining_tokens: 148977,
          display_remaining_percent: 25,
          trigger_limit: 149529,
          target_limit: 116300,
          is_over_trigger: false,
        },
      })
    })

    expect(screen.getByTestId('percent')).toHaveTextContent('25')
  })
})
