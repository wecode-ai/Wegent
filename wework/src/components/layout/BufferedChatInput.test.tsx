import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'
import { BufferedChatInput } from './BufferedChatInput'

describe('BufferedChatInput', () => {
  test('syncs external value changes into the draft', async () => {
    const { rerender } = render(
      <BufferedChatInput value="" onChange={vi.fn()} onSubmit={vi.fn()} disabled={false} />
    )

    rerender(
      <BufferedChatInput
        value="queued message"
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
      />
    )

    await waitFor(() => {
      expect(screen.getByTestId('chat-message-input')).toHaveValue('queued message')
    })
  })

  test('appends an insertion without replacing the buffered draft', async () => {
    const props = {
      value: '',
      onChange: vi.fn(),
      onSubmit: vi.fn(),
      disabled: false,
    }
    const { rerender } = render(<BufferedChatInput {...props} />)
    await userEvent.type(screen.getByTestId('chat-message-input'), 'Existing draft')

    rerender(<BufferedChatInput {...props} insertion={{ id: 1, text: 'Selected response' }} />)

    await waitFor(() => {
      expect(screen.getByTestId('chat-message-input')).toHaveValue(
        'Existing draft\nSelected response'
      )
    })
  })

  test('discards the previous buffered draft when the chat scope changes', async () => {
    const onSubmit = vi.fn()
    const baseProjectChat = {
      models: [],
      skills: [],
      selectedModel: null,
      selectedModelOptions: {},
      selectedSkills: [],
      attachments: [],
      uploadingFiles: new Map(),
      errors: new Map(),
      isOptionsLocked: false,
      setSelectedModel: vi.fn(),
      setSelectedModelOption: vi.fn(),
      toggleSkill: vi.fn(),
      handleFileSelect: vi.fn(),
      removeAttachment: vi.fn(),
      listLocalSkills: vi.fn(),
    }
    const { rerender } = render(
      <BufferedChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={onSubmit}
        disabled={false}
        projectChat={{ ...baseProjectChat, scopeKey: 'chat-1' }}
      />
    )
    await userEvent.type(screen.getByTestId('chat-message-input'), 'previous message')

    rerender(
      <BufferedChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={onSubmit}
        disabled={false}
        projectChat={{ ...baseProjectChat, scopeKey: 'chat-2' }}
      />
    )
    const input = screen.getByTestId('chat-message-input')
    input.focus()
    fireEvent.paste(input, {
      clipboardData: {
        files: [],
        getData: (type: string) => (type === 'text/plain' ? 'previous message' : ''),
        types: ['text/plain'],
      },
    })
    await userEvent.keyboard('{Enter}')

    expect(onSubmit).toHaveBeenCalledOnce()
    expect(onSubmit).toHaveBeenCalledWith('previous message')
  })
})
