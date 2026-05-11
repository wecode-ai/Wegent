// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import PipelineNextStepDialog from '@/features/tasks/components/chat/PipelineNextStepDialog'
import type { PipelineNextStepMessage } from '@/features/tasks/components/chat/pipelineNextStep'

const mockTranslations: Record<string, Record<string, string>> = {
  chat: {
    'pipeline.next_step_dialog.title': 'Continue to next step',
    'pipeline.next_step_dialog.description':
      'Choose the message and context to carry into the next pipeline stage.',
    'pipeline.next_step_dialog.message_placeholder':
      'Add an optional instruction for the next stage...',
    'pipeline.next_step_dialog.text_contexts': 'Message context',
    'pipeline.next_step_dialog.structured_contexts': 'Attached context',
    'pipeline.next_step_dialog.no_text_contexts': 'No message context is available.',
    'pipeline.next_step_dialog.no_structured_contexts':
      'No attachment, knowledge base, or table context is available.',
    'pipeline.next_step_dialog.confirm': 'Continue',
    'pipeline.next_step_dialog.confirming': 'Continuing...',
    'pipeline.next_step_dialog.text_items.user_message': 'User message',
    'pipeline.next_step_dialog.text_items.ai_response': 'AI response',
    'pipeline.next_step_dialog.text_items.history_message': 'History message',
  },
  common: {
    'actions.cancel': 'Cancel',
  },
}

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: (namespace?: string) => ({
    t: (key: string) => {
      if (key.includes(':')) {
        const [keyNamespace, namespacedKey] = key.split(':')
        return mockTranslations[keyNamespace]?.[namespacedKey] ?? key
      }

      return mockTranslations[namespace ?? 'common']?.[key] ?? key
    },
  }),
}))

const messages: PipelineNextStepMessage[] = [
  {
    id: 'user-1',
    type: 'user',
    status: 'completed',
    content: 'Original request',
    timestamp: 1,
    contexts: [
      {
        id: 10,
        context_type: 'attachment',
        name: 'spec.md',
        status: 'ready',
      },
    ],
  },
  {
    id: 'ai-1',
    type: 'ai',
    status: 'completed',
    content: ['## Final Requirement Prompt', 'Build this feature'].join('\n'),
    timestamp: 2,
  },
]

const renderDialog = (props: Partial<React.ComponentProps<typeof PipelineNextStepDialog>> = {}) => {
  const defaultProps: React.ComponentProps<typeof PipelineNextStepDialog> = {
    open: true,
    messages,
    isConfirming: false,
    onOpenChange: jest.fn(),
    onConfirm: jest.fn(),
  }

  return render(<PipelineNextStepDialog {...defaultProps} {...props} />)
}

describe('PipelineNextStepDialog', () => {
  it('leaves the editable message empty and shows translated copy', () => {
    renderDialog()

    expect(screen.getByTestId('pipeline-next-step-message')).toHaveValue('')
    expect(screen.getByText('Continue to next step')).toBeInTheDocument()
    expect(
      screen.getByText('Choose the message and context to carry into the next pipeline stage.')
    ).toBeInTheDocument()
    expect(screen.getByTestId('pipeline-next-step-message')).toHaveAttribute(
      'placeholder',
      'Add an optional instruction for the next stage...'
    )
  })

  it('selects the AI response by default without selecting the previous user message', () => {
    renderDialog()

    expect(
      screen.getByTestId('pipeline-next-step-text-checkbox-user_message:user-1')
    ).not.toBeChecked()
    expect(screen.getByTestId('pipeline-next-step-text-checkbox-ai_response:ai-1')).toBeChecked()
    expect(screen.getByText('User message')).toBeInTheDocument()
    expect(screen.getByText('AI response')).toBeInTheDocument()
    expect(
      screen.queryByTestId('pipeline-next-step-text-checkbox-user_message')
    ).not.toBeInTheDocument()
  })

  it('submits selected message and contexts', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    const onConfirm = jest.fn()
    renderDialog({ onConfirm })

    await user.click(screen.getByTestId('pipeline-next-step-confirm-button'))

    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('[AI]\nBuild this feature'),
        attachmentIds: [10],
        pendingContexts: [
          expect.objectContaining({
            id: 10,
            context_type: 'attachment',
            name: 'spec.md',
          }),
        ],
      })
    )
    expect(onConfirm.mock.calls[0][0].message).not.toContain('[User]\nOriginal request')
  })

  it('disables confirm when there is no message or context', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    renderDialog()

    await user.clear(screen.getByTestId('pipeline-next-step-message'))
    await user.click(screen.getByTestId('pipeline-next-step-text-checkbox-ai_response:ai-1'))
    await user.click(screen.getByTestId('pipeline-next-step-structured-checkbox-attachment-10'))

    expect(screen.getByTestId('pipeline-next-step-confirm-button')).toBeDisabled()
  })

  it('omits the attachment when the attachment checkbox is deselected', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    const onConfirm = jest.fn()
    renderDialog({ onConfirm })

    await user.click(screen.getByTestId('pipeline-next-step-structured-checkbox-attachment-10'))
    await user.click(screen.getByTestId('pipeline-next-step-confirm-button'))

    expect(onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({
        attachmentIds: [],
        pendingContexts: [],
      })
    )
  })

  it('renders empty states when text and structured contexts are unavailable', () => {
    renderDialog({
      messages: [],
    })

    expect(screen.getByText('No message context is available.')).toBeInTheDocument()
    expect(
      screen.getByText('No attachment, knowledge base, or table context is available.')
    ).toBeInTheDocument()
  })
})
