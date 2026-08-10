import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { BufferedChatInput } from './BufferedChatInput'

describe('BufferedChatInput', () => {
  afterEach(() => {
    vi.useRealTimers()
  })
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

  test('restores submitted text when it is externally returned for editing', async () => {
    const onSubmit = vi.fn()
    const props = {
      onChange: vi.fn(),
      onSubmit,
      disabled: false,
    }
    const { rerender } = render(<BufferedChatInput {...props} value="queued message" />)

    await userEvent.click(screen.getByTestId('send-message-button'))
    expect(onSubmit).toHaveBeenCalledWith('queued message')

    rerender(<BufferedChatInput {...props} value="" />)
    rerender(<BufferedChatInput {...props} value="queued message" />)

    await waitFor(() => {
      expect(screen.getByTestId('chat-message-input')).toHaveValue('queued message')
    })
  })

  test('keeps the submitted draft when an async send is rejected', async () => {
    let resolveSubmission: (accepted: boolean) => void = () => undefined
    const onDraftEdit = vi.fn()
    const onSubmit = vi.fn(
      () =>
        new Promise<boolean>(resolve => {
          resolveSubmission = resolve
        })
    )

    function Harness() {
      const [value, setValue] = useState('retry this message')
      return (
        <BufferedChatInput
          value={value}
          onChange={setValue}
          onDraftEdit={onDraftEdit}
          onSubmit={onSubmit}
          disabled={false}
        />
      )
    }

    render(<Harness />)
    await userEvent.click(screen.getByTestId('send-message-button'))
    resolveSubmission(false)

    await waitFor(() => {
      expect(screen.getByTestId('chat-message-input')).toHaveValue('retry this message')
    })
    expect(onDraftEdit).not.toHaveBeenCalled()

    await userEvent.type(screen.getByTestId('chat-message-input'), ' updated')
    expect(onDraftEdit).toHaveBeenCalled()
  })

  test('restores the submitted draft when an async send promise rejects', async () => {
    let rejectSubmission: (error: Error) => void = () => undefined
    const unhandledRejection = vi.fn()
    const onSubmit = vi.fn(
      () =>
        new Promise<boolean>((_resolve, reject) => {
          rejectSubmission = reject
        })
    )

    function Harness() {
      const [value, setValue] = useState('retry rejected promise')
      return (
        <BufferedChatInput value={value} onChange={setValue} onSubmit={onSubmit} disabled={false} />
      )
    }

    window.addEventListener('unhandledrejection', unhandledRejection)
    render(<Harness />)
    await userEvent.click(screen.getByTestId('send-message-button'))
    rejectSubmission(new Error('send failed'))

    await waitFor(() => {
      expect(screen.getByTestId('chat-message-input')).toHaveValue('retry rejected promise')
    })
    await Promise.resolve()
    expect(unhandledRejection).not.toHaveBeenCalled()
    window.removeEventListener('unhandledrejection', unhandledRejection)
  })

  test('keeps a newer draft when an earlier async send promise rejects', async () => {
    let rejectSubmission: (error: Error) => void = () => undefined
    const onSubmit = vi.fn(
      () =>
        new Promise<boolean>((_resolve, reject) => {
          rejectSubmission = reject
        })
    )

    function Harness() {
      const [value, setValue] = useState('submitted draft')
      return (
        <BufferedChatInput value={value} onChange={setValue} onSubmit={onSubmit} disabled={false} />
      )
    }

    render(<Harness />)
    await userEvent.click(screen.getByTestId('send-message-button'))
    await userEvent.type(screen.getByTestId('chat-message-input'), 'newer draft')
    rejectSubmission(new Error('send failed'))

    await waitFor(() => {
      expect(screen.getByTestId('chat-message-input')).toHaveValue('newer draft')
    })
  })

  test('clears only the draft accepted by an async send', async () => {
    let resolveSubmission: (accepted: boolean) => void = () => undefined
    const onSubmit = vi.fn(
      () =>
        new Promise<boolean>(resolve => {
          resolveSubmission = resolve
        })
    )

    function Harness() {
      const [value, setValue] = useState('accepted message')
      return (
        <BufferedChatInput value={value} onChange={setValue} onSubmit={onSubmit} disabled={false} />
      )
    }

    render(<Harness />)
    await userEvent.click(screen.getByTestId('send-message-button'))
    resolveSubmission(true)

    await waitFor(() => {
      expect(screen.getByTestId('chat-message-input')).toHaveValue('')
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

  test('flushes the draft on blur before the debounce window elapses', async () => {
    const onChange = vi.fn()
    render(<BufferedChatInput value="" onChange={onChange} onSubmit={vi.fn()} disabled={false} />)

    const input = screen.getByTestId('chat-message-input')
    await userEvent.type(input, 'unfinished draft')
    expect(onChange).not.toHaveBeenCalled()

    // Blur flushes on the next animation frame, well inside the 300ms debounce
    // window, so onChange must fire without waiting for the debounce timer.
    vi.useFakeTimers({ toFake: ['requestAnimationFrame'] })
    fireEvent.blur(input)
    vi.advanceTimersByTime(20)

    expect(onChange).toHaveBeenLastCalledWith('unfinished draft')
  })

  test('debounces onChange during the 300ms window', async () => {
    const onChange = vi.fn()
    render(<BufferedChatInput value="" onChange={onChange} onSubmit={vi.fn()} disabled={false} />)

    await userEvent.type(screen.getByTestId('chat-message-input'), 'draft')
    // onChange must not fire synchronously with typing; it is deferred by the debounce.
    expect(onChange).not.toHaveBeenCalled()

    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith('draft')
    })
  })

  test('flushes the draft on composition end before the debounce window elapses', async () => {
    const onChange = vi.fn()
    render(<BufferedChatInput value="" onChange={onChange} onSubmit={vi.fn()} disabled={false} />)

    const input = screen.getByTestId('chat-message-input')
    await userEvent.type(input, 'draft')
    expect(onChange).not.toHaveBeenCalled()

    // Composition end flushes on the next animation frame, well inside the
    // 300ms debounce window, so onChange must fire without the debounce timer.
    vi.useFakeTimers({ toFake: ['requestAnimationFrame'] })
    fireEvent.compositionEnd(input)
    vi.advanceTimersByTime(20)

    expect(onChange).toHaveBeenLastCalledWith('draft')
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
