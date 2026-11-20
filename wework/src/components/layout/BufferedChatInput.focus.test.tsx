import { render, screen } from '@testing-library/react'
import { useImperativeHandle, useRef } from 'react'
import { expect, it, vi } from 'vitest'
import type { ChatInputHandle } from '@/components/chat/ChatInput'
import { WORKBENCH_NEW_CHAT_FOCUS_EVENT } from '@/lib/workbenchComposerFocus'
import type { Ref } from 'react'
import { BufferedChatInput } from './BufferedChatInput'
import { DesktopEmptyTaskLauncher } from './DesktopEmptyTaskLauncher'

vi.mock('@/components/chat/ChatInput', () => ({
  ChatInput({ ref }: { ref: Ref<ChatInputHandle> }) {
    const input = useRef<HTMLInputElement>(null)
    useImperativeHandle(ref, () => ({
      get element() {
        return input.current
      },
      focus: () => input.current?.focus(),
      getValue: () => '',
      setValue: () => {},
      insertReference: () => {},
    }))
    return <input ref={input} aria-label="Chat message" />
  },
}))

it('preserves a notification setting focus when the workbench composer mounts', () => {
  function Workbench({ ready }: { ready: boolean }) {
    return (
      <>
        <div role="dialog" aria-label="Notifications">
          <button type="button">System notifications</button>
        </div>
        <div data-active-workbench-pane="true">
          {ready && (
            <BufferedChatInput
              autoFocus
              value=""
              disabled={false}
              onChange={vi.fn()}
              onSubmit={vi.fn()}
            />
          )}
        </div>
      </>
    )
  }

  const view = render(<Workbench ready={false} />)
  const setting = screen.getByRole('button', { name: 'System notifications' })
  setting.focus()

  view.rerender(<Workbench ready />)

  expect(screen.getByRole('textbox', { name: 'Chat message' })).toBeInTheDocument()
  expect(setting).toHaveFocus()

  view.rerender(<Workbench ready={false} />)
  setting.blur()
  view.rerender(<Workbench ready />)

  expect(screen.getByRole('textbox', { name: 'Chat message' })).toHaveFocus()
})

it('preserves a notification setting focus when the empty-task launcher mounts', () => {
  function Workbench({ ready }: { ready: boolean }) {
    return (
      <>
        <div role="dialog" aria-label="Notifications">
          <button type="button">System notifications</button>
        </div>
        {ready && (
          <DesktopEmptyTaskLauncher
            compact
            onOpenProjectSelector={vi.fn()}
            onSelectSuggestion={vi.fn()}
            composer={<input data-testid="chat-message-input" aria-label="New chat message" />}
          />
        )}
      </>
    )
  }

  const view = render(<Workbench ready={false} />)
  const setting = screen.getByRole('button', { name: 'System notifications' })
  setting.focus()

  view.rerender(<Workbench ready />)

  expect(setting).toHaveFocus()
  window.dispatchEvent(new Event(WORKBENCH_NEW_CHAT_FOCUS_EVENT))
  expect(screen.getByRole('textbox', { name: 'New chat message' })).toHaveFocus()
})
