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
const usePathname = jest.fn()
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

jest.mock('next/navigation', () => ({
  usePathname: () => usePathname(),
}))

function Harness() {
  const status = useChatStatusIndicator()
  return (
    <div>
      <div data-testid="enabled">{String(status.enabled)}</div>
      <div data-testid="should-render">{String(status.shouldRender)}</div>
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
    usePathname.mockReturnValue('/chat')
    registerChatHandlers.mockImplementation(handlers => {
      registeredHandlers = handlers
      return () => {}
    })
  })

  test('renders on active conversation routes after receiving a status update', () => {
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
    expect(screen.getByTestId('should-render')).toHaveTextContent('true')
    expect(screen.getByTestId('percent')).toHaveTextContent('57')
  })

  test('stays hidden on non-conversation routes even with a task selected', () => {
    usePathname.mockReturnValue('/settings')

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
    expect(screen.getByTestId('should-render')).toHaveTextContent('false')
    expect(screen.getByTestId('percent')).toHaveTextContent('57')
  })
})
