import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import '@/i18n'
import type { WorkbenchMessage } from '@/types/workbench'
import { StandInWorkConfirmation } from './StandInWorkConfirmation'

const mocks = vi.hoisted(() => ({
  submit: vi.fn(async () => true),
  ignore: vi.fn(),
  unsubscribe: vi.fn(),
  subscribe: vi.fn(),
  messages: [] as WorkbenchMessage[],
}))
vi.mock('@/components/layout/useWorkbenchPaneSession', () => ({
  useWorkbenchPaneSession: () => ({
    messages: mocks.messages,
    answeredRequestUserInputIds: new Set(),
    sendRequestUserInputResponse: mocks.submit,
    ignoreRequestUserInput: mocks.ignore,
  }),
}))
vi.mock('@/features/workbench/useWorkbench', () => ({
  useWorkbenchPaneContext: () => ({ subscribeRuntimeTaskStream: mocks.subscribe }),
}))

it('answers a live request from the list with its original identity and unsubscribes on close', async () => {
  mocks.subscribe.mockReturnValue(mocks.unsubscribe)
  mocks.messages = [
    {
      id: 'assistant',
      role: 'assistant',
      content: '拟回复：现在是北京时间13:25。',
      status: 'streaming',
      blocks: [
        {
          id: 'approval',
          type: 'tool',
          toolName: 'request_user_input',
          status: 'pending',
          renderPayload: {
            kind: 'request_user_input',
            requestId: 'approval-7',
            itemId: 'reply-7',
            questions: [
              {
                id: 'mcp_tool_call_approval_reply-7',
                question: '发送这条回复？',
                options: [{ label: 'Allow' }, { label: 'Cancel' }],
              },
            ],
          },
        },
      ],
    },
  ] as WorkbenchMessage[]
  const address = { taskId: 'work', deviceId: 'device' }
  const view = render(<StandInWorkConfirmation address={address} />)
  expect(screen.getByText('拟回复：现在是北京时间13:25。')).toBeVisible()
  await userEvent.click(
    screen.getByTestId('request-user-input-option-mcp_tool_call_approval_reply-7-0')
  )
  expect(mocks.submit).toHaveBeenCalledWith({
    requestId: 'approval-7',
    itemId: 'reply-7',
    answers: { 'mcp_tool_call_approval_reply-7': { answers: ['Allow'] } },
  })
  expect(mocks.subscribe).toHaveBeenCalledWith(address, expect.any(Object))
  view.unmount()
  expect(mocks.unsubscribe).toHaveBeenCalledOnce()
})
