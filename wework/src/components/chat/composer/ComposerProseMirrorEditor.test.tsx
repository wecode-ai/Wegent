import { act, fireEvent, render, screen } from '@testing-library/react'
import { Activity, createRef, useState } from 'react'
import { describe, expect, test, vi } from 'vitest'
import type { PluginReference } from '@/features/plugins/pluginNavigation'
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
  onBeforeInput: (event: InputEvent) => boolean = () => false,
  onOpenMentionPlugin: (reference: PluginReference) => void = vi.fn()
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
      onOpenMentionPlugin={onOpenMentionPlugin}
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
  test('restores the controlled value after an Activity tab is hidden and shown', () => {
    function ActivityEditorHarness() {
      const [visible, setVisible] = useState(true)
      const [value, setValue] = useState('')

      return (
        <>
          <button type="button" onClick={() => setVisible(current => !current)}>
            Toggle tab
          </button>
          <Activity mode={visible ? 'visible' : 'hidden'}>
            <ComposerProseMirrorEditor
              value={value}
              onChange={setValue}
              onSnapshotChange={vi.fn()}
              onKeyDown={() => false}
              onBeforeInput={() => false}
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
              textareaRef={createRef<HTMLElement>()}
              className="min-h-12"
            />
          </Activity>
        </>
      )
    }

    render(<ActivityEditorHarness />)

    const editor = screen.getByTestId('composer-editor') as HTMLElement & { value: string }
    expect(editor).toHaveClass('composer-prosemirror-editor')
    act(() => {
      editor.value = '每个标签自己的草稿'
    })
    fireEvent.click(screen.getByRole('button', { name: 'Toggle tab' }))
    fireEvent.click(screen.getByRole('button', { name: 'Toggle tab' }))

    expect((screen.getByTestId('composer-editor') as HTMLElement & { value: string }).value).toBe(
      '每个标签自己的草稿'
    )
  })

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

  test.each([
    ['mouse', () => fireEvent.click(screen.getByTestId('composer-plugin-chip-wegent-sites'))],
    [
      'keyboard',
      () =>
        fireEvent.keyDown(screen.getByTestId('composer-plugin-chip-wegent-sites'), {
          key: 'Enter',
        }),
    ],
  ])('opens plugin details with the %s interaction', (_interaction, openPlugin) => {
    const onOpenMentionPlugin = vi.fn()
    renderEditor('[$站点](plugin://wegent-sites@wegent-bundled) ', () => false, onOpenMentionPlugin)

    const chip = screen.getByTestId('composer-plugin-chip-wegent-sites')
    expect(chip).toHaveAttribute('role', 'link')
    expect(chip).toHaveAttribute('tabindex', '0')
    expect(chip).toHaveAttribute('data-composer-plugin-name', 'wegent-sites')
    expect(chip).toHaveAttribute('data-composer-plugin-marketplace', 'wegent-bundled')

    openPlugin()

    expect(onOpenMentionPlugin).toHaveBeenCalledOnce()
    expect(onOpenMentionPlugin).toHaveBeenCalledWith({
      pluginName: 'wegent-sites',
      marketplaceName: 'wegent-bundled',
    })
  })

  test('serializes copied skill selections back to their markdown references', () => {
    const value = `before ${GMAIL_REFERENCE} after`
    const doc = createComposerDocument(value)

    expect(serializeComposerSlice(doc.slice(0, doc.content.size))).toBe(value)
  })

  test.each([
    ['LF text/plain', 'first line\nsecond line\nthird line', 'text/plain'],
    ['LF text alias', 'first line\nsecond line\nthird line', 'text'],
    ['CRLF text/plain', 'first line\r\nsecond line\r\nthird line', 'text/plain'],
  ])('keeps every line when pasting %s', (_variant, pastedText, clipboardType) => {
    const { editorRef, onChange } = renderEditor('')
    const editor = screen.getByTestId('composer-editor')

    fireEvent.paste(editor, {
      clipboardData: {
        files: [],
        getData: (type: string) => (type === clipboardType ? pastedText : ''),
        types: ['text/plain', 'text/html'],
      },
    })

    expect(editorRef.current?.getSnapshot().value).toBe('first line\nsecond line\nthird line')
    expect(onChange).toHaveBeenLastCalledWith('first line\nsecond line\nthird line')
  })

  test('models each plain-text line as its own paragraph', () => {
    const doc = createComposerDocument('first line\n\nthird line')

    expect(doc.childCount).toBe(3)
    expect(doc.child(0).textContent).toBe('first line')
    expect(doc.child(1).content.size).toBe(0)
    expect(doc.child(2).textContent).toBe('third line')
    expect(serializeComposerDocument(doc)).toBe('first line\n\nthird line')
  })

  test('keeps offset zero before an empty leading paragraph separator', () => {
    const { editorRef } = renderEditor('')

    act(() => editorRef.current?.setValue('\ntext', 0))

    expect(editorRef.current?.getSnapshot()).toMatchObject({
      value: '\ntext',
      selectionOffset: 0,
      selectionStart: 0,
      selectionEnd: 0,
    })
  })

  test('inserts pasted text exactly once through the ProseMirror paste pipeline', () => {
    const { editorRef, onChange } = renderEditor('existing ')
    const editor = screen.getByTestId('composer-editor')

    act(() => editorRef.current?.setValue('existing ', 'existing '.length))

    fireEvent.paste(editor, {
      clipboardData: {
        files: [],
        getData: (type: string) => (type === 'text/plain' ? 'pasted text' : ''),
        types: ['text/plain'],
      },
    })

    expect(editorRef.current?.getSnapshot().value).toBe('existing pasted text')
    expect(onChange).toHaveBeenCalledOnce()
    expect(onChange).toHaveBeenLastCalledWith('existing pasted text')
  })

  test('moves the caret to the end after pasting text', () => {
    const { editorRef } = renderEditor('before after')
    const editor = screen.getByTestId('composer-editor')

    act(() => editorRef.current?.setValue('before after', 'before '.length))

    fireEvent.paste(editor, {
      clipboardData: {
        files: [],
        getData: (type: string) => (type === 'text/plain' ? 'pasted ' : ''),
        types: ['text/plain'],
      },
    })

    expect(editorRef.current?.getSnapshot()).toMatchObject({
      value: 'before pasted after',
      selectionOffset: 'before pasted after'.length,
      selectionStart: 'before pasted after'.length,
      selectionEnd: 'before pasted after'.length,
    })
  })

  test('keeps line breaks when pasting rich text', () => {
    const { editorRef, onChange } = renderEditor('')
    const editor = screen.getByTestId('composer-editor')

    fireEvent.paste(editor, {
      clipboardData: {
        files: [],
        getData: (type: string) => {
          if (type === 'text/plain') return 'first line\nsecond line\nthird line'
          if (type === 'text/html') return '<p>first line</p><p>second line</p><p>third line</p>'
          return ''
        },
        types: ['text/plain', 'text/html'],
      },
    })

    expect(editorRef.current?.getSnapshot().value).toBe('first line\nsecond line\nthird line')
    expect(onChange).toHaveBeenCalledOnce()
  })

  test('scrolls the caret into view after inserting a line break', () => {
    const { editorRef } = renderEditor('first line')
    const editor = screen.getByTestId('composer-editor')
    Object.defineProperties(editor, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 180 },
    })
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => {
      callback(0)
      return 1
    })

    act(() => editorRef.current?.setValue('first line', 'first line'.length))
    fireEvent.keyDown(editor, {
      key: 'Enter',
      code: 'Enter',
      shiftKey: true,
    })

    expect(editorRef.current?.getSnapshot().value).toBe('first line\n')
    expect(editor.scrollTop).toBe(80)
    expect(editor.querySelector('.composer-empty-caret')).toHaveAttribute('aria-hidden', 'true')
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

  test.each(['ArrowLeft', 'ArrowRight'])(
    'does not override modified %s visual line navigation',
    key => {
      const value = `first line\nsecond line with ${GMAIL_REFERENCE} content\nthird line`
      const mentionOffset = value.indexOf(GMAIL_REFERENCE)
      const { editorRef } = renderEditor(value)
      const editor = screen.getByTestId('composer-editor')

      act(() => {
        editorRef.current?.setValue(value, mentionOffset)
        editorRef.current?.focus()
      })

      expect(
        fireEvent.keyDown(editor, {
          key,
          code: key,
          keyCode: key === 'ArrowLeft' ? 37 : 39,
          metaKey: true,
        })
      ).toBe(true)
      expect(editorRef.current?.getSnapshot().selectionOffset).toBe(mentionOffset)
    }
  )

  test.each([
    ['a', 65],
    ['e', 69],
  ])('does not override macOS Control-%s visual line navigation', (key, keyCode) => {
    const value = `first line\nsecond line with ${GMAIL_REFERENCE} content\nthird line`
    const mentionOffset = value.indexOf(GMAIL_REFERENCE)
    const { editorRef } = renderEditor(value)
    const editor = screen.getByTestId('composer-editor')

    act(() => {
      editorRef.current?.setValue(value, mentionOffset)
      editorRef.current?.focus()
    })

    expect(
      fireEvent.keyDown(editor, { key, code: `Key${key.toUpperCase()}`, keyCode, ctrlKey: true })
    ).toBe(true)
    expect(editorRef.current?.getSnapshot().selectionOffset).toBe(mentionOffset)
  })

  test('keeps unmodified arrow navigation protected at a skill boundary', () => {
    const value = `DF${GMAIL_REFERENCE} `
    const { editorRef } = renderEditor(value)
    const editor = screen.getByTestId('composer-editor')

    act(() => {
      editorRef.current?.setValue(value, 2)
      editorRef.current?.focus()
    })

    expect(fireEvent.keyDown(editor, { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 })).toBe(
      false
    )
    expect(editorRef.current?.getSnapshot().selectionOffset).toBe(2 + GMAIL_REFERENCE.length)
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

test('renders GitHub URLs as recognized inline link chips', () => {
  renderEditor('Check https://github.com/wecode-ai/Wegent/pull/2350')

  const chip = screen.getByTestId('composer-link-chip')
  expect(chip).toHaveClass('composer-link-node', 'composer-mention-link')
  expect(chip).toHaveAttribute(
    'data-composer-link-url',
    'https://github.com/wecode-ai/Wegent/pull/2350'
  )
  expect(chip).toHaveTextContent('wecode-ai/Wegent#2350')
  expect(chip.querySelector('img')).toHaveAttribute(
    'src',
    'https://github.githubassets.com/favicons/favicon.svg'
  )
})

test('renders Wegent Sites project markdown links as inline link chips', () => {
  const value = '[产品发布页](wegent-sites-project://prj_product) 请说出你要做的改动'
  renderEditor(value)

  const chip = screen.getByTestId('composer-link-chip')
  expect(chip).toHaveAttribute('data-composer-link-url', 'wegent-sites-project://prj_product')
  expect(chip).toHaveAttribute('data-composer-link-provider', 'wegent-sites-project')
  expect(chip).toHaveTextContent('产品发布页')
  expect(chip.querySelector('img')).toHaveAttribute('src', '/plugin-icons/wework.svg')
  expect(serializeComposerDocument(createComposerDocument(value))).toBe(value)
})

test('keeps unrecognized URLs as plain text', () => {
  renderEditor('Visit https://example.com/page')

  expect(screen.queryByTestId('composer-link-chip')).not.toBeInTheDocument()
  expect(screen.getByTestId('composer-editor')).toHaveTextContent('https://example.com/page')
})
