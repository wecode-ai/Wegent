import '@testing-library/jest-dom'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
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

test.each([false, true])(
  'consumes only the slash query with a pending catalog: %s',
  async pendingCatalog => {
    const originalRect = Object.getOwnPropertyDescriptor(Range.prototype, 'getBoundingClientRect')
    Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ top: 0, left: 0 }),
    })
    try {
      const skill = {
        id: 1,
        name: 'pdf',
        namespace: 'default',
        description: 'Read docs/pdf files',
        user_id: 1,
        is_public: false,
        is_active: true,
      }
      const props = {
        setMessage: jest.fn(),
        handleSendMessage: jest.fn(),
        onSkillSelect: jest.fn(),
        isLoading: false,
      }
      const suffix = pendingCatalog ? ' and keep this path /tmp' : ''
      const draft = 'Check /docs/pdf' + suffix
      const { rerender } = render(
        <ChatInput
          {...props}
          message={'Check ' + suffix}
          availableSkills={pendingCatalog ? [] : [skill]}
        />
      )
      const input = screen.getByTestId('message-input')
      input.focus()
      function typeCommand(value: string) {
        input.textContent = 'Check ' + value + suffix
        window.getSelection()?.collapse(input.firstChild, 'Check '.length + value.length)
        fireEvent.input(input)
      }
      typeCommand('/')
      typeCommand('/docs/pdf')
      rerender(<ChatInput {...props} message={draft} availableSkills={[skill]} />)

      fireEvent.click(await screen.findByTestId('slash-skill-option'))
      expect(props.onSkillSelect).toHaveBeenCalledWith(skill)
      expect(props.setMessage).toHaveBeenLastCalledWith('Check ' + suffix)
      expect(window.getSelection()?.anchorOffset).toBe('Check '.length)
    } finally {
      if (originalRect)
        Object.defineProperty(Range.prototype, 'getBoundingClientRect', originalRect)
      else Reflect.deleteProperty(Range.prototype, 'getBoundingClientRect')
    }
  }
)
