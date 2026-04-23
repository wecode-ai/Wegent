// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import FinalPromptMessage from '@/features/tasks/components/message/FinalPromptMessage'

const mockPush = jest.fn()
const mockToast = jest.fn()

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
    t: (key: string) => key,
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
})
