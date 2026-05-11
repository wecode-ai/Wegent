// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import FinalPromptMessage from '@/features/tasks/components/message/FinalPromptMessage'

const mockPush = jest.fn()
const mockToast = jest.fn()
const mockTranslations: Record<string, Record<string, string>> = {
  chat: {
    'pipeline.confirm_stage': 'Confirm',
    'pipeline.confirmation_hint':
      "Review and edit the prompt if needed, then click 'Continue to Next Stage' to proceed.",
    'pipeline.edit_prompt': 'Edit Prompt',
  },
}

jest.mock('next/navigation', () => ({
  useRouter: () => ({
    push: mockPush,
  }),
}))

jest.mock('@/hooks/use-toast', () => ({
  useToast: () => ({
    toast: mockToast,
  }),
}))

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      if (key.includes(':')) {
        const [namespace, namespacedKey] = key.split(':')
        return mockTranslations[namespace]?.[namespacedKey] ?? key
      }

      return key
    },
  }),
}))

jest.mock('@/features/theme/ThemeProvider', () => ({
  useTheme: () => ({
    theme: 'light',
  }),
}))

jest.mock('@/components/common/EnhancedMarkdown', () => ({
  __esModule: true,
  default: ({ source }: { source: string }) => <div>{source}</div>,
}))

jest.mock('@/components/common/SmartUrlRenderer', () => ({
  createSmartMarkdownComponents: () => ({}),
}))

jest.mock('@/features/tasks/contexts/chatStreamContext', () => ({
  useOptionalChatStreamContext: () => null,
}))

describe('FinalPromptMessage', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('shows a forward button for final prompt messages and forwards the current subtask', async () => {
    const user = userEvent.setup()
    const onForwardClick = jest.fn()
    const props: React.ComponentProps<typeof FinalPromptMessage> = {
      data: {
        type: 'final_prompt',
        final_prompt: 'Implement the feature',
      },
      taskId: 42,
      subtaskId: 7,
      onForwardClick,
    }

    render(<FinalPromptMessage {...props} />)

    await user.click(screen.getByTestId('final-prompt-forward-button'))

    expect(onForwardClick).toHaveBeenCalledWith(7)
  })

  it('renders pipeline confirmation actions with translated labels', () => {
    render(
      <FinalPromptMessage
        data={{
          type: 'final_prompt',
          final_prompt: 'Implement the feature',
        }}
        taskId={42}
        selectedTeam={{ id: 7 } as React.ComponentProps<typeof FinalPromptMessage>['selectedTeam']}
        isPendingConfirmation
      />
    )

    expect(screen.getByText('Edit Prompt')).toBeInTheDocument()
    expect(screen.getByText('Confirm')).toBeInTheDocument()
    expect(
      screen.getByText(
        "Review and edit the prompt if needed, then click 'Continue to Next Stage' to proceed."
      )
    ).toBeInTheDocument()
  })
})
