import { render, screen, waitFor } from '@testing-library/react'
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

  test('restores a buffered draft after switching chat scopes', async () => {
    const drafts = new Map<string, string>()
    const onBlankChange = vi.fn((value: string) => drafts.set('blank', value))
    const onTaskChange = vi.fn((value: string) => drafts.set('task', value))
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
        onChange={onBlankChange}
        onSubmit={vi.fn()}
        disabled={false}
        projectChat={{ ...baseProjectChat, scopeKey: 'blank' }}
      />
    )
    await userEvent.type(screen.getByTestId('chat-message-input'), 'unfinished draft')

    rerender(
      <BufferedChatInput
        value=""
        onChange={onTaskChange}
        onSubmit={vi.fn()}
        disabled={false}
        projectChat={{ ...baseProjectChat, scopeKey: 'task' }}
      />
    )

    await waitFor(() => expect(onBlankChange).toHaveBeenCalledWith('unfinished draft'))
    expect(screen.getByTestId('chat-message-input')).toHaveValue('')

    rerender(
      <BufferedChatInput
        value={drafts.get('blank') ?? ''}
        onChange={onBlankChange}
        onSubmit={vi.fn()}
        disabled={false}
        projectChat={{ ...baseProjectChat, scopeKey: 'blank' }}
      />
    )

    await waitFor(() => {
      expect(screen.getByTestId('chat-message-input')).toHaveValue('unfinished draft')
    })
  })
})
