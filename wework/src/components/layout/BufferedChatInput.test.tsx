import { act, render, screen, waitFor, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  dispatchPendingWorkbenchComposerFocusRequest,
  requestWorkbenchComposerFocus,
} from '@/lib/workbenchComposerFocus'
import { BufferedChatInput } from './BufferedChatInput'
import { TextInputDialog } from '@/components/common/TextInputDialog'
import { useScopedDraftInput } from '@/features/workbench/useScopedDraftInput'

vi.mock('@/api/dsh/desktopHost', () => ({
  invokeDesktopHost: vi.fn(async (capability: string, params: Record<string, unknown> = {}) => {
    if (capability === 'preferences.get') return {}
    if (capability === 'preferences.update') return params.patch ?? {}
    return {}
  }),
}))

function createProjectChat(scopeKey: string) {
  return {
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
    scopeKey,
  }
}

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

  test('keeps the local draft when parent props change before the debounce flush', async () => {
    const onChange = vi.fn()

    function Harness() {
      const [expanded, setExpanded] = useState(false)
      return (
        <>
          <button
            type="button"
            data-testid="buffered-chat-input-toggle-mode"
            onClick={() => setExpanded(current => !current)}
          >
            Toggle composer mode
          </button>
          <BufferedChatInput
            value=""
            onChange={onChange}
            onSubmit={vi.fn()}
            disabled={false}
            showExecutionTools={expanded}
          />
        </>
      )
    }

    render(<Harness />)
    const input = screen.getByTestId('chat-message-input')
    await userEvent.type(input, 'draft')
    expect(onChange).not.toHaveBeenCalled()

    await userEvent.click(screen.getByRole('button', { name: 'Toggle composer mode' }))

    expect(input).toHaveValue('draft')
  })

  test('does not replace newer input when two parent acknowledgements are delayed', async () => {
    vi.useFakeTimers()
    const acknowledgeDrafts: Array<() => void> = []

    function Harness() {
      const [value, setValue] = useState('')
      return (
        <BufferedChatInput
          value={value}
          onChange={nextValue => {
            acknowledgeDrafts.push(() => setValue(nextValue))
          }}
          onSubmit={vi.fn()}
          disabled={false}
        />
      )
    }

    render(<Harness />)
    const input = screen.getByTestId('chat-message-input') as HTMLElement & { value: string }
    act(() => {
      input.value = 'a'
      vi.advanceTimersByTime(300)
    })
    expect(acknowledgeDrafts).toHaveLength(1)
    act(() => {
      input.value = 'ab'
      vi.advanceTimersByTime(300)
    })
    expect(acknowledgeDrafts).toHaveLength(2)

    act(() => acknowledgeDrafts[0]?.())
    expect(input).toHaveValue('ab')

    act(() => acknowledgeDrafts[1]?.())
    expect(input).toHaveValue('ab')
  })

  test('restores an earlier draft after synchronous publications are batched', () => {
    vi.useFakeTimers()
    const publications: string[] = []
    function Harness() {
      const { inputs, setInput } = useScopedDraftInput(() => ({}))
      return (
        <>
          <button onClick={() => setInput('scope', 'first')}>Restore first draft</button>
          <span data-testid="parent-draft">{inputs.scope ?? ''}</span>
          <BufferedChatInput
            variant="desktop"
            projectChat={createProjectChat('scope')}
            value={inputs.scope ?? ''}
            onChange={next => {
              publications.push(next)
              setInput('scope', next)
              return { appliedSynchronously: true }
            }}
            onSubmit={vi.fn()}
            disabled={false}
          />
        </>
      )
    }
    render(<Harness />)
    const input = screen.getByTestId('chat-message-input') as HTMLElement & { value: string }
    act(() => {
      for (const value of ['first', 'second']) {
        input.value = value
        vi.advanceTimersByTime(300)
      }
    })
    expect(publications).toEqual(['first', 'second'])
    expect(screen.getByTestId('parent-draft')).toHaveTextContent('second')
    expect(input).toHaveValue('second')
    act(() => {
      input.value = 'third'
      vi.advanceTimersByTime(300)
    })
    expect(screen.getByTestId('parent-draft')).toHaveTextContent('third')
    expect(input).toHaveValue('third')

    fireEvent.click(screen.getByRole('button', { name: 'Restore first draft' }))

    expect(screen.getByTestId('parent-draft')).toHaveTextContent('first')
    expect(input).toHaveValue('first')
  })

  test('retires batched publications when the final value equals the committed value', () => {
    vi.useFakeTimers()
    function Harness() {
      const { inputs, setInput } = useScopedDraftInput(() => ({ scope: 'first' }))
      return (
        <>
          <button onClick={() => setInput('scope', 'second')}>Restore second draft</button>
          <span data-testid="parent-draft">{inputs.scope}</span>
          <BufferedChatInput
            variant="desktop"
            value={inputs.scope!}
            onChange={next => {
              setInput('scope', next)
              return { appliedSynchronously: true }
            }}
            onSubmit={vi.fn()}
            disabled={false}
          />
        </>
      )
    }
    render(<Harness />)
    const input = screen.getByTestId('chat-message-input') as HTMLElement & { value: string }
    act(() => {
      for (const value of ['second', 'first']) {
        input.value = value
        vi.advanceTimersByTime(300)
      }
    })
    expect(screen.getByTestId('parent-draft')).toHaveTextContent('first')
    expect(input).toHaveValue('first')

    fireEvent.click(screen.getByRole('button', { name: 'Restore second draft' }))

    expect(screen.getByTestId('parent-draft')).toHaveTextContent('second')
    expect(input).toHaveValue('second')
  })

  test('retires synchronous publications superseded by an explicit draft replacement', () => {
    vi.useFakeTimers()
    function Harness() {
      const { inputs, setInput } = useScopedDraftInput(() => ({}))
      const [replaceDraftKey, setReplaceDraftKey] = useState(0)
      return (
        <>
          <button
            onClick={() => {
              setInput('scope', 'restored')
              setReplaceDraftKey(current => current + 1)
            }}
          >
            Replace draft
          </button>
          <button onClick={() => setInput('scope', 'first')}>Restore first draft</button>
          <BufferedChatInput
            variant="desktop"
            value={inputs.scope ?? ''}
            replaceDraftKey={replaceDraftKey}
            onChange={next => {
              setInput('scope', next)
              return { appliedSynchronously: true }
            }}
            onSubmit={vi.fn()}
            disabled={false}
          />
        </>
      )
    }
    render(<Harness />)
    const input = screen.getByTestId('chat-message-input') as HTMLElement & { value: string }
    act(() => {
      input.value = 'first'
      vi.advanceTimersByTime(300)
      fireEvent.click(screen.getByRole('button', { name: 'Replace draft' }))
    })
    expect(input).toHaveValue('restored')

    fireEvent.click(screen.getByRole('button', { name: 'Restore first draft' }))

    expect(input).toHaveValue('first')
  })

  test('keeps a deferred acknowledgement protected after newer synchronous publications batch', () => {
    vi.useFakeTimers()
    let acknowledgeFirst = () => {}
    function Harness() {
      const { inputs, setInput } = useScopedDraftInput(() => ({}))
      return (
        <>
          <button onClick={() => setInput('scope', 'first')}>Restore first draft</button>
          <span data-testid="parent-draft">{inputs.scope ?? ''}</span>
          <BufferedChatInput
            variant="desktop"
            value={inputs.scope ?? ''}
            onChange={next => {
              if (next === 'first') {
                acknowledgeFirst = () => setInput('scope', next)
                return
              }
              setInput('scope', next)
              return { appliedSynchronously: true }
            }}
            onSubmit={vi.fn()}
            disabled={false}
          />
        </>
      )
    }
    render(<Harness />)
    const input = screen.getByTestId('chat-message-input') as HTMLElement & { value: string }
    act(() => {
      input.value = 'first'
      vi.advanceTimersByTime(300)
    })
    act(() => {
      for (const value of ['second', 'third']) {
        input.value = value
        vi.advanceTimersByTime(300)
      }
    })
    expect(screen.getByTestId('parent-draft')).toHaveTextContent('third')
    act(acknowledgeFirst)
    expect(screen.getByTestId('parent-draft')).toHaveTextContent('first')
    expect(input).toHaveValue('third')
    act(() => {
      input.value = 'fourth'
      vi.advanceTimersByTime(300)
    })

    fireEvent.click(screen.getByRole('button', { name: 'Restore first draft' }))

    expect(screen.getByTestId('parent-draft')).toHaveTextContent('first')
    expect(input).toHaveValue('first')
  })

  test.each(['before', 'after'] as const)(
    'restores an earlier draft after duplicate blur publication %s acknowledgement',
    blurTiming => {
      vi.useFakeTimers()
      const acknowledgements: Array<() => void> = []
      function Harness() {
        const [value, setValue] = useState('')
        return (
          <>
            <button onClick={() => setValue('first')}>Restore first draft</button>
            <BufferedChatInput
              variant="desktop"
              value={value}
              onChange={next => acknowledgements.push(() => setValue(next))}
              onSubmit={vi.fn()}
              disabled={false}
            />
          </>
        )
      }
      render(<Harness />)
      const input = screen.getByTestId('chat-message-input') as HTMLElement & { value: string }
      act(() => {
        input.value = 'first'
        vi.advanceTimersByTime(300)
      })
      if (blurTiming === 'after') act(() => acknowledgements[0]!())
      fireEvent.blur(input)
      act(() => vi.advanceTimersToNextFrame())
      act(() => acknowledgements.forEach(acknowledge => acknowledge()))
      expect(input).toHaveValue('first')
      act(() => {
        input.value = 'second'
        vi.advanceTimersByTime(300)
      })
      act(() => acknowledgements.at(-1)!())
      expect(input).toHaveValue('second')

      fireEvent.click(screen.getByRole('button', { name: 'Restore first draft' }))
      expect(input).toHaveValue('first')
    }
  )

  test('restores a draft after a newer acknowledgement and a duplicate blur', () => {
    vi.useFakeTimers()
    const acknowledgements: Array<() => void> = []
    function Harness() {
      const [value, setValue] = useState('')
      return (
        <>
          <button onClick={() => setValue('second')}>Restore second draft</button>
          <BufferedChatInput
            variant="desktop"
            value={value}
            onChange={next => acknowledgements.push(() => setValue(next))}
            onSubmit={vi.fn()}
            disabled={false}
          />
        </>
      )
    }
    render(<Harness />)
    const input = screen.getByTestId('chat-message-input') as HTMLElement & { value: string }
    for (const value of ['first', 'second']) {
      act(() => {
        input.value = value
        vi.advanceTimersByTime(300)
      })
    }
    act(() => acknowledgements[1]!())
    fireEvent.blur(input)
    act(() => vi.advanceTimersToNextFrame())
    act(() => acknowledgements.slice(2).forEach(acknowledge => acknowledge()))
    act(() => acknowledgements[0]!())
    expect(input).toHaveValue('second')
    act(() => {
      input.value = 'third'
      vi.advanceTimersByTime(300)
    })
    act(() => acknowledgements.at(-1)!())
    expect(input).toHaveValue('third')

    fireEvent.click(screen.getByRole('button', { name: 'Restore second draft' }))
    expect(input).toHaveValue('second')
  })

  test('resynchronizes the parent on blur after a late acknowledgement changes its value', () => {
    vi.useFakeTimers()
    const acknowledgements: Array<() => void> = []
    let deferAcknowledgements = true
    function Harness() {
      const [value, setValue] = useState('')
      return (
        <>
          <span data-testid="parent-draft">{value}</span>
          <BufferedChatInput
            variant="desktop"
            value={value}
            onChange={next => {
              if (deferAcknowledgements) acknowledgements.push(() => setValue(next))
              else setValue(next)
            }}
            onSubmit={vi.fn()}
            disabled={false}
          />
        </>
      )
    }
    render(<Harness />)
    const input = screen.getByTestId('chat-message-input') as HTMLElement & { value: string }
    for (const value of ['first', 'second']) {
      act(() => {
        input.value = value
        vi.advanceTimersByTime(300)
      })
    }
    act(() => acknowledgements[1]!())
    act(() => acknowledgements[0]!())
    expect(input).toHaveValue('second')
    expect(screen.getByTestId('parent-draft')).toHaveTextContent('first')
    deferAcknowledgements = false

    fireEvent.blur(input)
    act(() => vi.advanceTimersToNextFrame())

    expect(screen.getByTestId('parent-draft')).toHaveTextContent('second')
    expect(input).toHaveValue('second')
  })

  test('publishes a return to the committed value while another draft is pending', () => {
    vi.useFakeTimers()
    const onChange = vi.fn()
    render(
      <BufferedChatInput
        variant="desktop"
        value="first"
        onChange={onChange}
        onSubmit={vi.fn()}
        disabled={false}
      />
    )
    const input = screen.getByTestId('chat-message-input') as HTMLElement & { value: string }
    for (const value of ['second', 'first']) {
      act(() => {
        input.value = value
        vi.advanceTimersByTime(300)
      })
    }
    expect(onChange.mock.calls.map(([value]) => value)).toEqual(['second', 'first'])
  })

  test.each(['**bold**', '# Heading', '> Quote'])(
    'keeps Shift+Enter through draft acknowledgement after Markdown: %s',
    markdown => {
      vi.useFakeTimers()
      function Harness() {
        const [value, setValue] = useState('')
        return (
          <BufferedChatInput
            variant="desktop"
            value={value}
            onChange={setValue}
            onSubmit={vi.fn()}
            disabled={false}
          />
        )
      }
      render(<Harness />)
      const input = screen.getByTestId('chat-message-input') as HTMLElement & { value: string }
      act(() => {
        input.value = markdown
        input.focus()
        vi.advanceTimersByTime(300)
      })
      fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
      const afterBreak = input.value
      expect(afterBreak).toMatch(/\n$/)
      const selectedParagraph = window.getSelection()?.anchorNode?.parentElement
      expect(selectedParagraph).toBeInstanceOf(HTMLElement)
      act(() => vi.advanceTimersByTime(300))
      expect(input.value).toBe(afterBreak)
      expect(window.getSelection()?.anchorNode?.parentElement).toBe(selectedParagraph)
    }
  )

  test.each(['in-order', 'reverse-order'])(
    'keeps a Markdown line break with %s draft acknowledgements',
    order => {
      vi.useFakeTimers()
      const acknowledgeDrafts: Array<() => void> = []
      function Harness() {
        const [value, setValue] = useState('')
        return (
          <BufferedChatInput
            variant="desktop"
            value={value}
            onChange={next => acknowledgeDrafts.push(() => setValue(next))}
            onSubmit={vi.fn()}
            disabled={false}
          />
        )
      }
      render(<Harness />)
      const input = screen.getByTestId('chat-message-input') as HTMLElement & { value: string }
      act(() => {
        input.value = '**bold**'
        input.focus()
        vi.advanceTimersByTime(300)
      })
      fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
      const afterBreak = input.value
      expect(afterBreak).toBe('**bold**\n\n')
      act(() => vi.advanceTimersByTime(300))
      expect(acknowledgeDrafts).toHaveLength(2)
      const caret = window.getSelection()?.anchorNode
      const caretOffset = window.getSelection()?.anchorOffset
      expect(caret).toBeInstanceOf(Node)
      act(() => acknowledgeDrafts[order === 'in-order' ? 0 : 1]?.())
      expect(input.value).toBe(afterBreak)
      expect(window.getSelection()?.anchorNode).toBe(caret)
      expect(window.getSelection()?.anchorOffset).toBe(caretOffset)
      act(() => acknowledgeDrafts[order === 'in-order' ? 1 : 0]?.())
      expect(input.value).toBe(afterBreak)
      expect(window.getSelection()?.anchorNode).toBe(caret)
      expect(window.getSelection()?.anchorOffset).toBe(caretOffset)
    }
  )

  test.each(['before', 'after', 'cell', 'tail'] as const)(
    'keeps a table Markdown line break at %s through acknowledgement without further typing',
    position => {
      vi.useFakeTimers()
      function Harness() {
        const [value, setValue] = useState('')
        return (
          <BufferedChatInput
            variant="desktop"
            value={value}
            onChange={setValue}
            onSubmit={vi.fn()}
            disabled={false}
          />
        )
      }
      render(<Harness />)
      const input = screen.getByTestId('chat-message-input') as HTMLElement & { value: string }
      const table = '| 项目 | 内容 |\n| --- | --- |\n| A | 甲 |'
      act(() => {
        input.value = position === 'tail' ? table : `表格前的说明\n\n${table}\n\n**表格后的说明**`
        input.focus()
        vi.advanceTimersByTime(300)
      })
      expect(input.querySelector('table')).not.toBeNull()
      const target =
        position === 'cell'
          ? input.querySelector('td p')!
          : position === 'before'
            ? input.querySelector(':scope > p')!
            : input.querySelector(':scope > p:last-child')!
      expect(target).toBeInstanceOf(HTMLElement)
      act(() => {
        const range = document.createRange()
        range.selectNodeContents(target)
        range.collapse(false)
        window.getSelection()!.removeAllRanges()
        window.getSelection()!.addRange(range)
        fireEvent(document, new Event('selectionchange'))
      })
      const paragraphsBefore = input.querySelectorAll(':scope > p').length
      fireEvent.keyDown(input, { key: 'Enter', code: 'Enter', shiftKey: true })
      if (position === 'cell') {
        expect(target.querySelector('br:not(.ProseMirror-trailingBreak)')).not.toBeNull()
        expect(input.value).toContain('A<br>')
      } else {
        expect(input.querySelectorAll(':scope > p')).toHaveLength(paragraphsBefore + 1)
      }
      const afterBreak = input.value
      const caret = window.getSelection()?.anchorNode
      const caretOffset = window.getSelection()?.anchorOffset
      expect(caret).toBeInstanceOf(Node)
      act(() => vi.advanceTimersByTime(300))
      expect(input.value).toBe(afterBreak)
      expect(window.getSelection()?.anchorNode).toBe(caret)
      expect(window.getSelection()?.anchorOffset).toBe(caretOffset)
    }
  )

  test('does not carry another scope draft into a pending acknowledgement on return', () => {
    vi.useFakeTimers()
    const { rerender } = render(
      <BufferedChatInput
        value=""
        projectChat={createProjectChat('scope-a')}
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
      />
    )
    const input = screen.getByTestId('chat-message-input') as HTMLElement & { value: string }
    act(() => {
      input.value = '**draft A**'
      vi.advanceTimersByTime(300)
    })
    rerender(
      <BufferedChatInput
        value="draft B"
        projectChat={createProjectChat('scope-b')}
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
      />
    )
    expect(input.value).toBe('draft B')
    rerender(
      <BufferedChatInput
        value="**draft A**"
        projectChat={createProjectChat('scope-a')}
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
      />
    )
    expect(input.value).toBe('**draft A**')
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

  test('restores a queued draft that was published before submission', async () => {
    function Harness() {
      const [value, setValue] = useState('')
      const [queued, setQueued] = useState('')
      const [replaceDraftKey, setReplaceDraftKey] = useState(0)
      return (
        <>
          <button
            type="button"
            onClick={() => {
              setValue(queued)
              setReplaceDraftKey(current => current + 1)
            }}
          >
            Edit queued message
          </button>
          <span data-testid="published-draft">{value}</span>
          <BufferedChatInput
            value={value}
            replaceDraftKey={replaceDraftKey}
            onChange={setValue}
            onSubmit={message => {
              setQueued(message)
              return true
            }}
            disabled={false}
          />
        </>
      )
    }

    render(<Harness />)
    await userEvent.type(screen.getByTestId('chat-message-input'), 'queued follow-up')
    await waitFor(() =>
      expect(screen.getByTestId('published-draft')).toHaveTextContent('queued follow-up')
    )
    await userEvent.click(screen.getByTestId('send-message-button'))
    await waitFor(() => expect(screen.getByTestId('published-draft')).toBeEmptyDOMElement())
    await userEvent.click(screen.getByRole('button', { name: 'Edit queued message' }))
    await waitFor(() =>
      expect(screen.getByTestId('chat-message-input')).toHaveValue('queued follow-up')
    )
  }, 30_000)

  test('ignores acknowledgements from before a queued draft is restored', async () => {
    const acknowledgements: Array<() => void> = []
    const publishedValues: string[] = []

    function Harness() {
      const [value, setValue] = useState('')
      const [queued, setQueued] = useState('')
      const [replaceDraftKey, setReplaceDraftKey] = useState(0)
      return (
        <>
          <button
            type="button"
            onClick={() => {
              setValue(queued)
              setReplaceDraftKey(current => current + 1)
            }}
          >
            Edit queued message
          </button>
          <BufferedChatInput
            value={value}
            replaceDraftKey={replaceDraftKey}
            onChange={nextValue => {
              publishedValues.push(nextValue)
              acknowledgements.push(() => setValue(nextValue))
            }}
            onSubmit={message => {
              setQueued(message)
              return true
            }}
            disabled={false}
          />
        </>
      )
    }

    render(<Harness />)
    const input = screen.getByTestId('chat-message-input')
    await userEvent.type(input, 'queued follow-up')
    await waitFor(() => expect(publishedValues).toContain('queued follow-up'))
    await userEvent.click(screen.getByTestId('send-message-button'))
    await waitFor(() => expect(publishedValues.at(-1)).toBe(''))
    // Blur can publish another draft before submit; replay every stale acknowledgement.
    const staleAcknowledgements = [...acknowledgements]
    await userEvent.click(screen.getByRole('button', { name: 'Edit queued message' }))
    expect(input).toHaveValue('queued follow-up')

    for (const acknowledge of staleAcknowledgements) {
      act(acknowledge)
      expect(input).toHaveValue('queued follow-up')
    }
  }, 30_000)

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
    expect(onDraftEdit).toHaveBeenLastCalledWith(' updatedretry this message')
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
        <BufferedChatInput
          value={value}
          onChange={setValue}
          onSubmit={onSubmit}
          disabled={false}
          variant="desktop"
        />
      )
    }

    render(<Harness />)
    const input = screen.getByTestId('chat-message-input')
    await userEvent.click(input)
    await userEvent.click(screen.getByTestId('send-message-button'))
    resolveSubmission(true)

    await waitFor(() => {
      expect(input).toHaveValue('')
      expect(input).toHaveFocus()
    })
  })

  test('clears the live composer when preserving a paused queue', async () => {
    const onResumeQueueWithInput = vi.fn()

    function Harness() {
      const [value, setValue] = useState('')
      return (
        <BufferedChatInput
          value={value}
          onChange={setValue}
          onSubmit={vi.fn()}
          disabled={false}
          queuedMessages={[
            {
              id: 'queued-paused-send',
              content: 'queued message',
              status: 'queued',
              createdAt: '2026-08-14T10:00:00.000Z',
            },
          ]}
          guidanceMessages={[]}
          queuePaused
          onResumeQueue={vi.fn()}
          onResumeQueueWithInput={onResumeQueueWithInput}
        />
      )
    }

    render(<Harness />)
    const input = screen.getByTestId('chat-message-input')
    await userEvent.type(input, 'manual message')
    await userEvent.keyboard('{Enter}')
    await userEvent.click(screen.getByTestId('paused-queue-send-cancel-button'))
    expect(input).toHaveValue('manual message')

    await userEvent.click(input)
    await userEvent.keyboard('{Enter}')
    await userEvent.click(screen.getByTestId('paused-queue-send-preserve-button'))

    expect(onResumeQueueWithInput).toHaveBeenCalledWith('manual message', undefined)
    expect(input).toHaveValue('')
  })

  test('syncs a programmatic clear into the composer immediately', async () => {
    const { rerender } = render(
      <BufferedChatInput
        value="queued message"
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
      />
    )

    rerender(<BufferedChatInput value="" onChange={vi.fn()} onSubmit={vi.fn()} disabled={false} />)

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
    vi.useFakeTimers()
    const onChange = vi.fn()
    render(<BufferedChatInput value="" onChange={onChange} onSubmit={vi.fn()} disabled={false} />)

    const input = screen.getByTestId('chat-message-input') as HTMLElement & { value: string }
    act(() => {
      input.value = 'draft'
    })
    // onChange must not fire synchronously with typing; it is deferred by the debounce.
    expect(onChange).not.toHaveBeenCalled()

    act(() => vi.advanceTimersByTime(299))
    expect(onChange).not.toHaveBeenCalled()

    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(onChange).toHaveBeenCalledWith('draft')
  })

  test('debounces the committed draft after composition ends', async () => {
    vi.useFakeTimers()
    const onChange = vi.fn()
    render(<BufferedChatInput value="" onChange={onChange} onSubmit={vi.fn()} disabled={false} />)

    const input = screen.getByTestId('chat-message-input') as HTMLElement & { value: string }
    fireEvent.compositionStart(input)
    act(() => {
      input.value = 'nihao'
    })
    fireEvent.compositionEnd(input)

    act(() => vi.advanceTimersByTime(299))
    expect(onChange).not.toHaveBeenCalled()

    act(() => vi.advanceTimersByTime(1))
    expect(onChange).toHaveBeenLastCalledWith('nihao')
  })

  test('does not flush transient composition text after the debounce window', async () => {
    const onChange = vi.fn()
    render(<BufferedChatInput value="" onChange={onChange} onSubmit={vi.fn()} disabled={false} />)

    const input = screen.getByTestId('chat-message-input')
    fireEvent.compositionStart(input)
    await userEvent.type(input, 'nihao')
    await new Promise(resolve => window.setTimeout(resolve, 350))

    expect(onChange).not.toHaveBeenCalled()

    fireEvent.compositionEnd(input)
    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith('nihao'))
  })

  test('cancels a queued frame flush when composition starts', async () => {
    vi.useFakeTimers()
    const onChange = vi.fn()
    render(<BufferedChatInput value="" onChange={onChange} onSubmit={vi.fn()} disabled={false} />)

    const input = screen.getByTestId('chat-message-input') as HTMLElement & { value: string }
    act(() => {
      input.value = 'draft'
    })
    fireEvent.blur(input)
    fireEvent.compositionStart(input)
    act(() => vi.advanceTimersByTime(20))

    expect(onChange).not.toHaveBeenCalled()

    fireEvent.compositionEnd(input)
    act(() => vi.advanceTimersByTime(299))

    expect(onChange).not.toHaveBeenCalled()
    act(() => vi.advanceTimersByTime(1))
    expect(onChange).toHaveBeenLastCalledWith('draft')
  })

  test('cancels a blur frame queued during composition before scheduling the debounce', () => {
    vi.useFakeTimers()
    const onChange = vi.fn()
    render(<BufferedChatInput value="" onChange={onChange} onSubmit={vi.fn()} disabled={false} />)

    const input = screen.getByTestId('chat-message-input') as HTMLElement & { value: string }
    fireEvent.compositionStart(input)
    act(() => {
      input.value = 'draft'
    })
    fireEvent.blur(input)
    fireEvent.compositionEnd(input)

    act(() => vi.advanceTimersByTime(299))
    expect(onChange).not.toHaveBeenCalled()

    act(() => vi.advanceTimersByTime(1))
    expect(onChange).toHaveBeenLastCalledWith('draft')
  })

  test('preserves caller composition callbacks', () => {
    const onCompositionStart = vi.fn()
    const onCompositionEnd = vi.fn()
    render(
      <BufferedChatInput
        value=""
        onChange={vi.fn()}
        onCompositionStart={onCompositionStart}
        onCompositionEnd={onCompositionEnd}
        onSubmit={vi.fn()}
        disabled={false}
      />
    )

    const input = screen.getByTestId('chat-message-input')
    fireEvent.compositionStart(input)
    fireEvent.compositionEnd(input)

    expect(onCompositionStart).toHaveBeenCalledOnce()
    expect(onCompositionEnd).toHaveBeenCalledOnce()
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

  test.each(['context', 'navigation', 'enabled'] as const)(
    'keeps rename focus when delayed composer %s completes',
    async reason => {
      const user = userEvent.setup()
      const onRename = vi.fn()
      const projectChat = createProjectChat('runtime:device-1:rename-focus')
      function Harness({ ready }: { ready: boolean }) {
        const [renaming, setRenaming] = useState(false)
        return (
          <>
            <button type="button" onDoubleClick={() => setRenaming(true)}>
              Rename task
            </button>
            <TextInputDialog
              open={renaming}
              title="Rename"
              label="Name"
              initialValue="Original"
              confirmLabel="Save"
              cancelLabel="Cancel"
              inputTestId="rename-focus-input"
              confirmTestId="rename-focus-save"
              onClose={() => setRenaming(false)}
              onSubmit={onRename}
            />
            <div data-active-workbench-pane="true">
              <BufferedChatInput
                autoFocus
                variant="desktop"
                value=""
                onChange={vi.fn()}
                onSubmit={vi.fn()}
                disabled={reason === 'enabled' && !ready}
                projectChat={projectChat}
                contextHeader={ready ? <span>Linked task</span> : null}
              />
            </div>
          </>
        )
      }
      const { rerender } = render(<Harness ready={false} />)
      for (let attempt = 0; attempt < 3; attempt += 1) {
        rerender(<Harness ready={false} />)
        await user.dblClick(screen.getByRole('button', { name: 'Rename task' }))
        const input = screen.getByTestId('rename-focus-input')
        expect(input).toHaveFocus()
        await user.type(input, `Draft ${attempt}`)
        if (reason === 'navigation') requestWorkbenchComposerFocus(projectChat.scopeKey)
        rerender(<Harness ready />)
        await act(() => new Promise(resolve => window.requestAnimationFrame(resolve)))
        expect(screen.getByTestId('composer-context-rail')).toHaveTextContent('Linked task')
        expect(input).toHaveFocus()
        await user.keyboard('{Escape}')
        expect(screen.queryByTestId('rename-focus-input')).not.toBeInTheDocument()
      }
      expect(onRename).not.toHaveBeenCalled()
      requestWorkbenchComposerFocus(projectChat.scopeKey)
      await waitFor(() => expect(screen.getByTestId('chat-message-input')).toHaveFocus())
    }
  )

  test('focuses the matching composer when a conversation is selected', async () => {
    render(
      <>
        <button type="button">Conversation</button>
        <div data-active-workbench-pane="true">
          <BufferedChatInput
            value=""
            onChange={vi.fn()}
            onSubmit={vi.fn()}
            disabled={false}
            projectChat={createProjectChat('runtime:device-1:task-1')}
          />
        </div>
      </>
    )
    const conversation = screen.getByRole('button', { name: 'Conversation' })
    conversation.focus()

    requestWorkbenchComposerFocus('runtime:device-1:task-1')

    await waitFor(() => expect(screen.getByTestId('chat-message-input')).toHaveFocus())
  })

  test('focuses a selected conversation after its composer mounts', async () => {
    requestWorkbenchComposerFocus('runtime:device-1:task-1')

    const composer = (
      <div data-active-workbench-pane="true">
        <BufferedChatInput
          value=""
          onChange={vi.fn()}
          onSubmit={vi.fn()}
          disabled={false}
          projectChat={createProjectChat('runtime:device-1:task-1')}
        />
      </div>
    )
    const { rerender } = render(composer)

    await waitFor(() => expect(screen.getByTestId('chat-message-input')).toHaveFocus())

    rerender(<div />)
    rerender(
      <div data-active-workbench-pane="true">
        <BufferedChatInput
          key="remounted"
          value=""
          onChange={vi.fn()}
          onSubmit={vi.fn()}
          disabled={false}
          projectChat={createProjectChat('runtime:device-1:task-1')}
        />
      </div>
    )
    dispatchPendingWorkbenchComposerFocusRequest()

    await waitFor(() => expect(screen.getByTestId('chat-message-input')).toHaveFocus())
  })

  test('does not let a cached hidden composer consume the focus request', async () => {
    const { rerender } = render(
      <>
        <button type="button">Conversation</button>
        <div data-active-workbench-pane="false">
          <BufferedChatInput
            value=""
            onChange={vi.fn()}
            onSubmit={vi.fn()}
            disabled={false}
            projectChat={createProjectChat('runtime:device-1:task-1')}
          />
        </div>
      </>
    )
    const conversation = screen.getByRole('button', { name: 'Conversation' })
    conversation.focus()

    requestWorkbenchComposerFocus('runtime:device-1:task-1')
    await new Promise(resolve => window.requestAnimationFrame(resolve))
    expect(conversation).toHaveFocus()

    rerender(
      <>
        <button type="button">Conversation</button>
        <div data-active-workbench-pane="true">
          <BufferedChatInput
            value=""
            onChange={vi.fn()}
            onSubmit={vi.fn()}
            disabled={false}
            projectChat={createProjectChat('runtime:device-1:task-1')}
          />
        </div>
      </>
    )
    await waitFor(() => expect(screen.getByTestId('chat-message-input')).toHaveFocus())
  })

  test('does not focus a disabled or non-matching composer', async () => {
    const projectChat = createProjectChat('runtime:device-1:task-1')
    const { rerender } = render(
      <>
        <button type="button">Conversation</button>
        <BufferedChatInput
          value=""
          onChange={vi.fn()}
          onSubmit={vi.fn()}
          disabled={false}
          projectChat={projectChat}
        />
      </>
    )
    const conversation = screen.getByRole('button', { name: 'Conversation' })
    conversation.focus()

    requestWorkbenchComposerFocus('runtime:device-1:task-2')
    await new Promise(resolve => window.requestAnimationFrame(resolve))
    expect(conversation).toHaveFocus()

    rerender(
      <>
        <button type="button">Conversation</button>
        <BufferedChatInput
          value=""
          onChange={vi.fn()}
          onSubmit={vi.fn()}
          disabled
          projectChat={projectChat}
        />
      </>
    )
    screen.getByRole('button', { name: 'Conversation' }).focus()
    requestWorkbenchComposerFocus('runtime:device-1:task-1')
    await new Promise(resolve => window.requestAnimationFrame(resolve))
    expect(screen.getByRole('button', { name: 'Conversation' })).toHaveFocus()
  })
})
