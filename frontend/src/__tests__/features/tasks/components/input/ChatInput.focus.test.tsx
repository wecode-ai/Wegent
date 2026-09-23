import '@testing-library/jest-dom'
import { act, render, screen, waitFor } from '@testing-library/react'
import { Profiler, type ReactNode } from 'react'

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

jest.mock('@/components/ui/tooltip', () => ({
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children, className }: { children: ReactNode; className?: string }) => (
    <div className={className}>{children}</div>
  ),
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
  afterEach(() => {
    jest.useRealTimers()
  })

  test('keeps badge spacing stable during typing and updates it when the badge changes', () => {
    let width = 120
    const onRender = jest.fn()
    const props = {
      setMessage: jest.fn(),
      handleSendMessage: jest.fn(),
      isLoading: false,
    }
    const renderInput = (message: string, hasBadge = true) => (
      <Profiler id="chat-input" onRender={onRender}>
        <ChatInput
          {...props}
          message={message}
          badge={
            hasBadge ? (
              <span
                ref={element => {
                  if (element?.parentElement) {
                    Object.defineProperty(element.parentElement, 'offsetWidth', {
                      configurable: true,
                      get: () => width,
                    })
                  }
                }}
              >
                Agent
              </span>
            ) : undefined
          }
        />
      </Profiler>
    )
    const { rerender } = render(renderInput('message'))
    const input = screen.getByTestId('message-input')
    expect(input).toHaveStyle({ textIndent: '128px' })

    for (let index = 0; index < 100; index += 1) {
      onRender.mockClear()
      rerender(renderInput(`message ${index}`))
      expect(input).toHaveTextContent(`message ${index}`)
      expect(input).toHaveStyle({ textIndent: '128px' })
      expect(onRender).toHaveBeenCalledTimes(1)
    }

    width = 180
    rerender(renderInput('message with a wider badge'))
    expect(input).toHaveStyle({ textIndent: '188px' })

    rerender(renderInput('message without a badge', false))
    expect(input).toHaveStyle({ textIndent: '0' })
  })

  test('auto focuses when no other control has focus', () => {
    jest.useFakeTimers()
    render(
      <ChatInput
        message=""
        setMessage={jest.fn()}
        handleSendMessage={jest.fn()}
        isLoading={false}
        autoFocus
      />
    )

    const input = screen.getByTestId('message-input')
    expect(input).not.toHaveFocus()

    act(() => jest.advanceTimersByTime(100))

    expect(input).toHaveFocus()
  })

  test('does not steal focus from another control after delayed auto focus was scheduled', () => {
    jest.useFakeTimers()
    render(
      <>
        <button type="button" data-testid="external-control">
          External control
        </button>
        <ChatInput
          message=""
          setMessage={jest.fn()}
          handleSendMessage={jest.fn()}
          isLoading={false}
          autoFocus
        />
      </>
    )

    const externalControl = screen.getByTestId('external-control')
    const input = screen.getByTestId('message-input')
    externalControl.focus()

    act(() => jest.advanceTimersByTime(100))

    expect(externalControl).toHaveFocus()
    expect(input).not.toHaveFocus()
  })

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

  test('hides keyboard shortcut guidance below the desktop breakpoint', () => {
    render(
      <ChatInput
        message=""
        setMessage={jest.fn()}
        handleSendMessage={jest.fn()}
        isLoading={false}
      />
    )

    expect(screen.getByText('chat:send_shortcut').parentElement).toHaveClass('hidden', 'md:block')
  })
})
