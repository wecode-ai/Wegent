import { act, fireEvent, render, screen } from '@testing-library/react'
import { createRef } from 'react'
import { describe, expect, test, vi } from 'vitest'
import { ComposerProseMirrorEditor, type ComposerEditorHandle } from './ComposerProseMirrorEditor'
import {
  composerSchema,
  createComposerDocument,
  serializeComposerDocument,
  serializeComposerSlice,
} from './composerProseMirrorModel'

const GMAIL_REFERENCE = '[$gmail](/tmp/gmail/SKILL.md)'

function renderEditor(
  value = GMAIL_REFERENCE,
  onBeforeInput: (event: InputEvent) => boolean = () => false
) {
  const editorRef = createRef<ComposerEditorHandle>()
  const textareaRef = createRef<HTMLElement>()
  const onChange = vi.fn()

  render(
    <ComposerProseMirrorEditor
      ref={editorRef}
      value={value}
      onChange={onChange}
      onSnapshotChange={vi.fn()}
      onKeyDown={() => false}
      onBeforeInput={onBeforeInput}
      onKeyUp={vi.fn()}
      onCompositionStart={vi.fn()}
      onCompositionEnd={vi.fn()}
      onPaste={() => false}
      onDrop={() => false}
      onClick={vi.fn()}
      onFocus={vi.fn()}
      placeholder="Message"
      testId="composer-editor"
      rows={2}
      textareaRef={textareaRef}
      className="min-h-12"
    />
  )

  return { editorRef, onChange }
}

describe('ComposerProseMirrorEditor', () => {
  test('models skill references as non-selectable atomic inline nodes', () => {
    const doc = createComposerDocument(GMAIL_REFERENCE)
    const mention = doc.firstChild?.firstChild

    expect(mention?.type).toBe(composerSchema.nodes.composer_mention)
    expect(mention?.isAtom).toBe(true)
    expect(mention?.isLeaf).toBe(true)
    expect(mention?.type.spec.selectable).toBe(false)
  })

  test('renders path labels with the original filesystem casing', () => {
    renderEditor('[$backend](folder://%2Fworkspace%2Fbackend) ')

    const chip = screen.getByTestId('composer-path-chip-backend')
    expect(chip).toHaveTextContent('backend')
    expect(chip).toHaveAttribute('data-composer-skill-label', 'backend')
  })

  test('serializes copied skill selections back to their markdown references', () => {
    const value = `before ${GMAIL_REFERENCE} after`
    const doc = createComposerDocument(value)

    expect(serializeComposerSlice(doc.slice(0, doc.content.size))).toBe(value)
  })

  test('keeps the caret outside the skill while repeatedly moving left', () => {
    const { editorRef, onChange } = renderEditor()
    const editor = screen.getByTestId('composer-editor')
    const chip = screen.getByTestId('local-skill-chip-gmail')

    expect(editor).toHaveAttribute('contenteditable', 'true')
    expect(chip).toHaveAttribute('contenteditable', 'false')
    expect(chip).toHaveAttribute('tabindex', '-1')
    expect(chip).toHaveAttribute('aria-label', 'Gmail')
    expect(chip).toHaveAttribute('data-composer-skill-label', 'Gmail')
    expect(chip).toHaveClass('composer-mention-node', 'composer-mention-link')
    expect(editor.querySelectorAll('.composer-mention-icon')).toHaveLength(1)
    expect(chip.firstElementChild).toHaveClass('composer-mention-icon-slot')
    expect(chip.querySelector('.composer-mention-icon-slot')).toHaveAttribute('aria-hidden', 'true')
    expect(chip.querySelector('.composer-mention-icon')).toBeInTheDocument()
    expect(chip.querySelector('.composer-mention-label')).toHaveTextContent('Gmail')

    act(() => {
      editorRef.current?.setValue(GMAIL_REFERENCE, GMAIL_REFERENCE.length)
      editorRef.current?.focus()
    })

    expect(editorRef.current?.getSnapshot().selectionOffset).toBe(GMAIL_REFERENCE.length)

    expect(fireEvent.keyDown(editor, { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 })).toBe(
      false
    )
    expect(editorRef.current?.getSnapshot().selectionOffset).toBe(0)

    const paragraph = editor.querySelector('p')
    expect(window.getSelection()?.anchorNode).toBe(paragraph)
    expect(window.getSelection()?.anchorOffset).toBe(0)

    for (let index = 0; index < 11; index += 1) {
      expect(fireEvent.keyDown(editor, { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 })).toBe(
        false
      )
      const snapshot = editorRef.current?.getSnapshot()
      expect(snapshot?.selectionOffset).toBe(0)
      expect(snapshot?.value).toBe(GMAIL_REFERENCE)
      expect(snapshot?.value).not.toContain('\uFFFC')
    }

    expect(onChange).not.toHaveBeenCalled()
    expect(screen.getByTestId('local-skill-chip-gmail')).toBe(chip)
  })

  test('repairs a WebKit DOM selection that drifted inside the skill', () => {
    const { editorRef } = renderEditor()
    const editor = screen.getByTestId('composer-editor')
    const chip = screen.getByTestId('local-skill-chip-gmail')

    act(() => {
      editorRef.current?.setValue(GMAIL_REFERENCE, GMAIL_REFERENCE.length)
      const range = document.createRange()
      range.setStart(chip, 0)
      range.collapse(true)
      window.getSelection()?.removeAllRanges()
      window.getSelection()?.addRange(range)
    })

    fireEvent.keyDown(editor, { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 })
    expect(editorRef.current?.getSnapshot().selectionOffset).toBe(0)
    expect(editorRef.current?.getSnapshot().value).toBe(GMAIL_REFERENCE)
  })

  test('moves left from the skill boundary into text typed before it', () => {
    const value = `DF${GMAIL_REFERENCE} `
    const { editorRef } = renderEditor(value)
    const editor = screen.getByTestId('composer-editor')

    act(() => {
      editorRef.current?.setValue(value, 2)
      editorRef.current?.focus()
    })

    expect(fireEvent.keyDown(editor, { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 })).toBe(
      false
    )
    expect(editorRef.current?.getSnapshot().selectionOffset).toBe(1)
    expect(editorRef.current?.getSnapshot().value).toBe(value)
  })

  test('keeps Command-Left at the real start of text before a skill', () => {
    const value = `DF${GMAIL_REFERENCE} `
    const { editorRef } = renderEditor(value)
    const editor = screen.getByTestId('composer-editor')

    act(() => {
      editorRef.current?.setValue(value, 2)
      editorRef.current?.focus()
    })

    expect(
      fireEvent.keyDown(editor, {
        key: 'ArrowLeft',
        code: 'ArrowLeft',
        keyCode: 37,
        metaKey: true,
      })
    ).toBe(false)
    fireEvent.keyUp(editor, { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37, metaKey: true })
    expect(editorRef.current?.getSnapshot().selectionOffset).toBe(0)
  })

  test('copies the complete markdown value after Command-A', () => {
    const value = `before ${GMAIL_REFERENCE} after`
    renderEditor(value)
    const editor = screen.getByTestId('composer-editor')
    const setData = vi.fn()
    const copyEvent = new Event('copy', { bubbles: true, cancelable: true }) as ClipboardEvent
    Object.defineProperty(copyEvent, 'clipboardData', { value: { setData } })

    editor.focus()
    expect(fireEvent.keyDown(editor, { key: 'a', code: 'KeyA', metaKey: true })).toBe(false)
    expect(editor.dispatchEvent(copyEvent)).toBe(false)
    expect(setData).toHaveBeenCalledWith('text/plain', value)
  })

  test('moves right across the whole skill in one step', () => {
    const { editorRef } = renderEditor()
    const editor = screen.getByTestId('composer-editor')

    act(() => {
      editorRef.current?.setValue(GMAIL_REFERENCE, 0)
      editorRef.current?.focus()
    })

    expect(fireEvent.keyDown(editor, { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 })).toBe(
      false
    )
    expect(editorRef.current?.getSnapshot().selectionOffset).toBe(GMAIL_REFERENCE.length)

    expect(fireEvent.keyDown(editor, { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 })).toBe(
      false
    )
    expect(editorRef.current?.getSnapshot().selectionOffset).toBe(GMAIL_REFERENCE.length)
  })

  test('moves left across a skill after traversing its separator space', () => {
    const value = `${GMAIL_REFERENCE} `
    const { editorRef } = renderEditor(value)
    const editor = screen.getByTestId('composer-editor')

    act(() => {
      editorRef.current?.setValue(value, value.length)
      editorRef.current?.focus()
    })

    expect(editor.querySelector('.composer-mention-separator')?.textContent).toBe(' ')

    expect(fireEvent.keyDown(editor, { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 })).toBe(
      false
    )
    expect(editorRef.current?.getSnapshot().selectionOffset).toBe(GMAIL_REFERENCE.length)

    expect(fireEvent.keyDown(editor, { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 })).toBe(
      false
    )
    expect(editorRef.current?.getSnapshot().selectionOffset).toBe(0)
    expect(editorRef.current?.getSnapshot().value).toBe(value)
  })

  test('keeps the caret stable after repeatedly moving right at the separator boundary', () => {
    const value = `${GMAIL_REFERENCE} `
    const { editorRef, onChange } = renderEditor(value)
    const editor = screen.getByTestId('composer-editor')

    act(() => {
      editorRef.current?.setValue(value, value.length)
      editorRef.current?.focus()
    })

    for (let index = 0; index < 11; index += 1) {
      expect(
        fireEvent.keyDown(editor, { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 })
      ).toBe(false)
      const snapshot = editorRef.current?.getSnapshot()
      expect(snapshot?.selectionOffset).toBe(value.length)
      expect(snapshot?.value).toBe(value)
      expect(snapshot?.value).not.toContain('\uFFFC')
    }

    expect(onChange).not.toHaveBeenCalled()
  })

  test('removes object replacement characters before creating editor state', () => {
    const doc = createComposerDocument(`\uFFFC${GMAIL_REFERENCE}\uFFFCtext\uFFFC`)

    expect(serializeComposerDocument(doc)).toBe(`${GMAIL_REFERENCE}text`)
  })

  test('prevents WebKit object replacement text before it mutates the document', () => {
    const { editorRef } = renderEditor()
    const editor = screen.getByTestId('composer-editor')
    const event = new InputEvent('beforeinput', {
      bubbles: true,
      cancelable: true,
      data: '\uFFFC',
      inputType: 'insertText',
    })

    expect(editor.dispatchEvent(event)).toBe(false)
    expect(event.defaultPrevented).toBe(true)
    expect(editorRef.current?.getSnapshot().value).toBe(GMAIL_REFERENCE)
  })

  test('prevents the paragraph event emitted after a consumed autocomplete Enter', () => {
    const onBeforeInput = vi.fn((event: InputEvent) => event.inputType === 'insertParagraph')
    renderEditor(GMAIL_REFERENCE, onBeforeInput)
    const editor = screen.getByTestId('composer-editor')
    const event = new InputEvent('beforeinput', {
      bubbles: true,
      cancelable: true,
      inputType: 'insertParagraph',
    })

    expect(editor.dispatchEvent(event)).toBe(false)
    expect(event.defaultPrevented).toBe(true)
    expect(onBeforeInput).toHaveBeenCalledOnce()
  })

  test('snaps serialized offsets inside a skill reference to the atom boundary', () => {
    const { editorRef, onChange } = renderEditor()

    for (let offset = 1; offset < GMAIL_REFERENCE.length; offset += 1) {
      act(() => editorRef.current?.setValue(GMAIL_REFERENCE, offset))
      expect(editorRef.current?.getSnapshot().selectionOffset).toBe(GMAIL_REFERENCE.length)
    }

    expect(onChange).not.toHaveBeenCalled()
  })
})
