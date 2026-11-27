import '@testing-library/jest-dom'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Profiler, type ReactNode } from 'react'
import userEvent from '@testing-library/user-event'

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
  default: () => <div data-testid="mention-autocomplete" />,
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

test.each([
  { pendingCatalog: false, method: 'type', action: 'click' },
  { pendingCatalog: true, method: 'type', action: 'click' },
  { pendingCatalog: false, method: 'paste query', action: 'click' },
  { pendingCatalog: false, method: 'paste within command', action: 'click' },
  { pendingCatalog: false, method: 'paste command', action: 'click' },
  { pendingCatalog: true, method: 'paste command', action: 'click' },
  { pendingCatalog: false, method: 'paste command', action: 'send unmatched path' },
  { pendingCatalog: false, method: 'type', action: 'send unmatched path' },
  { pendingCatalog: false, method: 'type', action: 'send with modifier' },
  { pendingCatalog: false, method: 'type', action: 'move caret' },
  { pendingCatalog: false, method: 'type', action: 'switch from mention' },
  { pendingCatalog: false, method: 'type', action: 'keyboard' },
])(
  'preserves the draft for slash $method followed by $action (pending catalog: $pendingCatalog)',
  async ({ pendingCatalog, method, action }) => {
    const user = userEvent.setup()
    const originalRect = Object.getOwnPropertyDescriptor(Range.prototype, 'getBoundingClientRect')
    const viewportHeight = jest.replaceProperty(window, 'innerHeight', 800)
    let caretTop = 120
    Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
      configurable: true,
      value: function (this: Range) {
        return this.startContainer.nodeType === Node.TEXT_NODE
          ? { top: caretTop, bottom: caretTop + 26, left: window.innerWidth - 16 }
          : { top: 0, bottom: 0, left: 0 }
      },
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
        enableTaskMentions: action === 'switch from mention',
      }
      const suffix = action === 'switch from mention' ? ' @' : ' and keep this path /tmp'
      const command = action === 'send unmatched path' ? '/tmp/notes.txt' : '/docs/pdf'
      const editingCommand = method === 'paste within command'
      const draft = 'Check ' + command + (editingCommand ? 'pdf' : '') + suffix
      const { rerender } = render(
        <ChatInput
          {...props}
          message={'Check ' + (editingCommand ? '/pdf' : '') + suffix}
          availableSkills={pendingCatalog ? [] : [skill]}
        />
      )
      const input = screen.getByTestId('message-input')
      input.focus()
      const editorViewport = input.parentElement!.parentElement!
      let editorBottom = 800
      jest
        .spyOn(editorViewport, 'getBoundingClientRect')
        .mockImplementation(() => ({ top: 0, bottom: editorBottom }) as DOMRect)
      if (action === 'switch from mention') {
        fireEvent.input(input)
        expect(screen.getByTestId('mention-autocomplete')).toBeInTheDocument()
      }
      function typeCommand(value: string) {
        input.textContent = 'Check ' + value + suffix
        window.getSelection()?.collapse(input.firstChild, 'Check '.length + value.length)
        fireEvent.input(input)
      }
      if (method === 'paste command') {
        window.getSelection()?.collapse(input.firstChild, 'Check '.length)
        await user.paste(command)
      } else if (editingCommand) {
        window.getSelection()?.collapse(input.firstChild, 'Check /'.length)
        await user.paste('docs/pdf')
      } else {
        typeCommand('/')
        if (method === 'paste query') await user.paste('docs/pdf')
        else typeCommand(command)
      }
      rerender(<ChatInput {...props} message={draft} availableSkills={[skill]} />)

      if (action === 'send unmatched path') {
        const pasted = method === 'paste command'
        const emptyMenu = screen.queryByText('common:skillSelector.no_available_skills')
        if (pasted) {
          expect(emptyMenu).not.toBeInTheDocument()
          expect(screen.getByText('chat:send_shortcut')).toBeInTheDocument()
        } else {
          expect(emptyMenu).toBeVisible()
        }
        await user.keyboard('{Enter}')
        expect(props.handleSendMessage).toHaveBeenCalledTimes(1)
        expect(props.setMessage).toHaveBeenLastCalledWith(draft)
        expect(props.onSkillSelect).not.toHaveBeenCalled()
        return
      }

      const option = await screen.findByTestId('slash-skill-option')
      expect(option).toBeVisible()
      if (action === 'send with modifier') {
        await user.keyboard('{Control>}{Enter}{/Control}')
        expect(props.handleSendMessage).toHaveBeenCalledTimes(1)
        expect(props.onSkillSelect).not.toHaveBeenCalled()
        return
      }
      if (action === 'switch from mention') {
        expect(screen.queryByTestId('mention-autocomplete')).not.toBeInTheDocument()
      }
      if (action === 'move caret') {
        window.getSelection()?.collapse(input.firstChild, 0)
        fireEvent(document, new Event('selectionchange'))
        expect(option).not.toBeInTheDocument()
        expect(input.textContent).toBe(draft)
        expect(props.onSkillSelect).not.toHaveBeenCalled()
        return
      }

      if (action === 'keyboard') {
        const menu = screen.getByTestId('slash-skill-menu')
        expect(menu).toHaveStyle({ top: '154px', left: `${window.innerWidth - 408}px` })
        expect(screen.queryByText('chat:send_shortcut')).not.toBeInTheDocument()

        caretTop = 135
        await waitFor(() => expect(menu).toHaveStyle({ top: '169px' }))

        editorBottom = 100
        fireEvent.scroll(editorViewport)
        expect(menu).not.toBeVisible()
        expect(fireEvent.keyDown(input, { key: 'ArrowDown' })).toBe(true)
        expect(screen.getByText('chat:send_shortcut')).toBeInTheDocument()
        editorBottom = 800

        caretTop = 180
        window.getSelection()?.collapse(input.firstChild, 'Check /'.length)
        fireEvent(document, new Event('selectionchange'))
        expect(menu).toHaveStyle({ top: '214px' })

        caretTop = 560
        fireEvent.scroll(input)
        expect(menu).toHaveStyle({ top: '552px', transform: 'translateY(-100%)' })

        Object.defineProperty(menu, 'scrollHeight', { value: 300 })
        viewportHeight.replaceValue(240)
        caretTop = 112
        fireEvent.resize(window)
        expect(menu).toHaveStyle({ top: '104px', maxHeight: '96px' })

        await user.tab({ shift: true })
        expect(option).toHaveFocus()
        fireEvent(document, new Event('selectionchange'))
        await user.keyboard('{Enter}')
      } else {
        await user.click(option)
      }
      expect(props.onSkillSelect).toHaveBeenCalledWith(skill)
      expect(screen.getByText('chat:send_shortcut')).toBeInTheDocument()
      expect(props.setMessage).toHaveBeenLastCalledWith('Check ' + suffix)
      expect(window.getSelection()?.anchorOffset).toBe('Check '.length)
    } finally {
      viewportHeight.restore()
      if (originalRect)
        Object.defineProperty(Range.prototype, 'getBoundingClientRect', originalRect)
      else Reflect.deleteProperty(Range.prototype, 'getBoundingClientRect')
    }
  }
)
