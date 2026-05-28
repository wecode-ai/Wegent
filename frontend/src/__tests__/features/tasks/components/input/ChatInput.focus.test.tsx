import '@testing-library/jest-dom'
import { render, screen, waitFor } from '@testing-library/react'

import ChatInput from '@/features/tasks/components/input/ChatInput'

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en' },
  }),
}))

jest.mock('@/features/layout/hooks/useMediaQuery', () => ({
  useIsMobile: () => false,
}))

jest.mock('@/features/common/UserContext', () => ({
  useUser: () => ({
    user: {
      preferences: {
        send_key: 'enter',
      },
    },
  }),
}))

jest.mock('@/features/tasks/components/chat/MentionAutocomplete', () => ({
  __esModule: true,
  default: () => null,
}))

jest.mock('@/features/tasks/components/chat/SkillAutocomplete', () => ({
  __esModule: true,
  default: () => null,
}))

jest.mock('@/features/tasks/components/chat/SkillFlyAnimation', () => ({
  __esModule: true,
  default: () => null,
}))

describe('ChatInput external focus', () => {
  test('moves the cursor to the end when focusAtEndSignal changes', async () => {
    const props = {
      setMessage: jest.fn(),
      handleSendMessage: jest.fn(),
      isLoading: false,
    }
    const { rerender } = render(<ChatInput {...props} message="" focusAtEndSignal={0} />)
    const input = screen.getByTestId('message-input')

    rerender(<ChatInput {...props} message="quick phrase" focusAtEndSignal={1} />)

    await waitFor(() => expect(input).toHaveFocus())
    const selection = window.getSelection()
    expect(selection?.rangeCount).toBe(1)

    const range = selection?.getRangeAt(0)
    expect(range?.collapsed).toBe(true)
    expect(range?.startContainer).toBe(input.firstChild)
    expect(range?.startOffset).toBe('quick phrase'.length)
  })
})
