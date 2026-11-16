import { act, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, test, vi } from 'vitest'
import { BufferedChatInput } from './BufferedChatInput'

vi.mock('@/api/dsh/desktopHost', () => ({
  invokeDesktopHost: vi.fn(async () => ({})),
}))

afterEach(() => vi.useRealTimers())

test.each(['same-value acknowledgement', 'late acknowledgement'] as const)(
  'distinguishes an explicit restoration from a %s',
  async timing => {
    vi.useFakeTimers()
    const publications: Array<{ value: string; acknowledge(): void }> = []
    function Harness() {
      const [value, setValue] = useState('')
      const [replaceDraftKey, setReplaceDraftKey] = useState(0)
      return (
        <>
          <button
            data-testid="restore-first-draft"
            onClick={() => {
              setValue('first')
              setReplaceDraftKey(key => key + 1)
            }}
          >
            Restore first draft
          </button>
          <span data-testid="parent-draft">{value}</span>
          <BufferedChatInput
            variant="desktop"
            value={value}
            replaceDraftKey={replaceDraftKey}
            onChange={next => publications.push({ value: next, acknowledge: () => setValue(next) })}
            onSubmit={() => true}
            disabled={false}
          />
        </>
      )
    }
    render(<Harness />)
    const editor = screen.getByTestId('chat-message-input') as HTMLElement & { value: string }
    await act(async () => {
      editor.value = 'first'
      vi.advanceTimersByTime(300)
    })
    fireEvent.keyDown(editor, { key: 'Enter', code: 'Enter' })
    expect(editor).toHaveValue('')
    expect(publications.map(publication => publication.value)).toEqual(['first', ''])
    fireEvent.click(screen.getByRole('button', { name: 'Restore first draft' }))
    expect(editor).toHaveValue('first')
    if (timing === 'same-value acknowledgement') {
      await act(async () => publications[0]!.acknowledge())
    }
    await act(async () => publications[1]!.acknowledge())
    expect(editor).toHaveValue('first')
    await act(async () => {
      editor.value = 'second'
      vi.advanceTimersByTime(300)
    })
    expect(publications.map(publication => publication.value)).toEqual(['first', '', 'second'])
    await act(async () => publications[2]!.acknowledge())
    expect(editor).toHaveValue('second')

    if (timing === 'same-value acknowledgement') {
      fireEvent.click(screen.getByRole('button', { name: 'Restore first draft' }))
    } else {
      await act(async () => publications[0]!.acknowledge())
    }

    expect(screen.getByTestId('parent-draft')).toHaveTextContent('first')
    expect(editor).toHaveValue(timing === 'same-value acknowledgement' ? 'first' : 'second')
  }
)

test('discards an unpublished edit when an explicit restoration replaces it', async () => {
  vi.useFakeTimers()
  const publish = vi.fn()
  function Harness() {
    const [value, setValue] = useState('first')
    const [replaceDraftKey, setReplaceDraftKey] = useState(0)
    return (
      <>
        <button
          data-testid="restore-first-draft"
          onClick={() => {
            setValue('first')
            setReplaceDraftKey(key => key + 1)
          }}
        >
          Restore first draft
        </button>
        <span data-testid="parent-draft">{value}</span>
        <BufferedChatInput
          variant="desktop"
          value={value}
          replaceDraftKey={replaceDraftKey}
          onChange={next => {
            publish(next)
            setValue(next)
          }}
          onSubmit={vi.fn()}
          disabled={false}
        />
      </>
    )
  }
  render(<Harness />)
  const editor = screen.getByTestId('chat-message-input') as HTMLElement & { value: string }
  await act(async () => {
    editor.value = 'second'
  })
  fireEvent.click(screen.getByRole('button', { name: 'Restore first draft' }))
  expect(editor).toHaveValue('first')

  await act(async () => vi.advanceTimersByTime(300))

  expect(publish).not.toHaveBeenCalled()
  expect(screen.getByTestId('parent-draft')).toHaveTextContent('first')
  expect(editor).toHaveValue('first')
})

test('restores the caret to the end when a replacement keeps the same text', async () => {
  function Harness() {
    const [replaceDraftKey, setReplaceDraftKey] = useState(0)
    return (
      <>
        <button
          data-testid="restore-first-draft"
          onClick={() => setReplaceDraftKey(key => key + 1)}
        >
          Restore first draft
        </button>
        <BufferedChatInput
          variant="desktop"
          value="first"
          replaceDraftKey={replaceDraftKey}
          onChange={vi.fn()}
          onSubmit={vi.fn()}
          disabled={false}
        />
      </>
    )
  }
  render(<Harness />)
  const editor = screen.getByTestId('chat-message-input')
  const text = editor.querySelector('p')!.firstChild!
  await act(async () => {
    editor.focus()
    window.getSelection()!.collapse(text, 0)
    fireEvent(document, new Event('selectionchange'))
  })
  expect(window.getSelection()!.anchorOffset).toBe(0)

  fireEvent.click(screen.getByRole('button', { name: 'Restore first draft' }))

  expect(editor).toHaveValue('first')
  expect(window.getSelection()!.anchorNode?.textContent).toBe('first')
  expect(window.getSelection()!.anchorOffset).toBe('first'.length)

  fireEvent.keyDown(editor, { key: 'Enter', code: 'Enter', shiftKey: true })
  expect(editor).toHaveValue('first\n')
})
