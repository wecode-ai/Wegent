// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { PipelineNextStepDialog } from '@/features/tasks/components/chat/PipelineNextStepDialog'
import type { PipelineNextStepMessage } from '@/features/tasks/components/chat/pipelineNextStep'

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
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
  it('prefills the editable message from final_prompt', () => {
    renderDialog()

    expect(screen.getByTestId('pipeline-next-step-message')).toHaveValue('Build this feature')
  })

  it('submits selected message and contexts', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    const onConfirm = jest.fn()
    renderDialog({ onConfirm })

    await user.click(screen.getByTestId('pipeline-next-step-confirm-button'))

    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('Build this feature'),
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
  })

  it('disables confirm when there is no message or context', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    renderDialog()

    await user.clear(screen.getByTestId('pipeline-next-step-message'))
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
})
