import enCommon from '@/i18n/locales/en/common.json'
import { createInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { TextSelection } from 'prosemirror-state'
import { BlockNoteEditor } from '@blocknote/core'
import { FilePanelExtension, SuggestionMenu } from '@blocknote/core/extensions'
import { BlockNoteViewRaw } from '@blocknote/react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { blockNoteSdkEditorOptions } from './blockNoteSdkEditorOptions'
import { BlockNoteSdkFormattingToolbar } from './BlockNoteSdkFormattingToolbar'
import { BlockNoteSdkEscapeShortcut } from './BlockNoteSdkEscapeShortcut'
import { BlockNoteSdkProvider } from './BlockNoteSdkComponents'
import { BlockNoteSdkSuggestions } from './BlockNoteSdkSuggestions'
import { BlockNoteSdkFilePanel, BlockNoteSdkSideMenu } from './BlockNoteSdkBlockMenus'
import { BlockNoteSdkLinkToolbar } from './BlockNoteSdkLinkToolbar'
import { BlockNoteSdkTableHandles } from './BlockNoteSdkTableHandles'

const testI18n = createInstance()
void testI18n.use(initReactI18next).init({
  lng: 'en',
  resources: { en: { common: enCommon } },
  interpolation: { escapeValue: false },
})

function mount(editor: BlockNoteEditor) {
  render(
    <I18nextProvider i18n={testI18n}>
      <BlockNoteSdkProvider>
        <BlockNoteViewRaw
          editor={editor}
          formattingToolbar={false}
          linkToolbar={false}
          slashMenu={false}
          sideMenu={false}
          filePanel={false}
          tableHandles={false}
          emojiPicker={false}
          comments={false}
        >
          <BlockNoteSdkEscapeShortcut />
          <BlockNoteSdkFormattingToolbar ariaLabel="Formatting" />
          <BlockNoteSdkSuggestions />
          <BlockNoteSdkFilePanel />
          <BlockNoteSdkSideMenu />
          <BlockNoteSdkLinkToolbar />
          <BlockNoteSdkTableHandles />
        </BlockNoteViewRaw>
      </BlockNoteSdkProvider>
    </I18nextProvider>
  )
}

beforeEach(() => {
  vi.spyOn(window, 'scrollBy').mockImplementation(() => {})
  if (typeof PointerEvent === 'undefined')
    vi.stubGlobal(
      'PointerEvent',
      class PointerEvent extends MouseEvent {
        pointerType = 'mouse'
        isPrimary = true
      }
    )
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
    new DOMRect(30, 30, 400, 40)
  )
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue(
    Object.assign([new DOMRect(30, 30, 400, 40)], {
      item: (index: number) => (index === 0 ? new DOMRect(30, 30, 400, 40) : null),
    })
  )
  if (!HTMLElement.prototype.scrollIntoView) HTMLElement.prototype.scrollIntoView = () => {}
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  Reflect.deleteProperty(document, 'elementsFromPoint')
})

test('SDK slash navigation runs the selected editor command without moving DOM focus', async () => {
  const editor = BlockNoteEditor.create({
    ...blockNoteSdkEditorOptions,
    initialContent: [{ type: 'paragraph', content: '' }],
  })
  mount(editor)
  act(() => {
    editor.focus()
    editor.getExtension(SuggestionMenu)?.openSuggestionMenu('/')
  })
  await screen.findByTestId('task-description-slash-item-0')
  await waitFor(() => expect(editor.domElement?.getAttribute('aria-expanded')).toBe('true'))
  const editable = editor.domElement
  if (!editable) throw new Error('Missing editor')
  fireEvent.keyDown(editable, { key: 'ArrowDown' })
  expect(document.activeElement).toBe(editable)
  fireEvent.keyDown(editable, { key: 'Enter' })
  await waitFor(() => expect(editor.document[0].type).toBe('heading'))
  expect(editor.document[0].props).toMatchObject({ level: 2 })
  await waitFor(() =>
    expect(screen.queryByTestId('task-description-slash-menu')).not.toBeInTheDocument()
  )
})

test('IME Enter does not activate a suggestion and Escape dismisses without editing', async () => {
  const editor = BlockNoteEditor.create({
    ...blockNoteSdkEditorOptions,
    initialContent: [{ type: 'paragraph', content: '' }],
  })
  mount(editor)
  act(() => {
    editor.focus()
    editor.getExtension(SuggestionMenu)?.openSuggestionMenu('/')
  })
  await screen.findByTestId('task-description-slash-item-0')
  const editable = editor.domElement
  if (!editable) throw new Error('Missing editor')
  fireEvent.compositionStart(editable)
  fireEvent.keyDown(editable, { key: 'Enter', isComposing: true, keyCode: 229 })
  expect(editor.document[0].type).toBe('paragraph')
  expect(screen.getByTestId('task-description-slash-menu')).toBeInTheDocument()
  fireEvent.compositionEnd(editable)
  fireEvent.keyDown(editable, { key: 'Escape' })
  await waitFor(() =>
    expect(screen.queryByTestId('task-description-slash-menu')).not.toBeInTheDocument()
  )
  expect(editor.document[0].type).toBe('paragraph')
})

test('dismissing a file URL draft leaves the attachment block unchanged and restores focus', async () => {
  const editor = BlockNoteEditor.create({
    ...blockNoteSdkEditorOptions,
    initialContent: [{ type: 'image', props: { url: '' } }],
  })
  mount(editor)
  act(() => {
    editor.focus()
    editor.getExtension(FilePanelExtension)?.showMenu(editor.document[0].id)
  })
  const panel = await screen.findByTestId('task-description-file-panel')
  const field = panel.querySelector('input')
  if (!field) throw new Error('Missing file URL field')
  fireEvent.change(field, { target: { value: 'https://example.com/draft.png' } })
  fireEvent.keyDown(field, { key: 'Escape' })
  await waitFor(() =>
    expect(screen.queryByTestId('task-description-file-panel')).not.toBeInTheDocument()
  )
  expect(editor.document[0].props).toMatchObject({ url: '' })
  await waitFor(() => expect(document.activeElement).toBe(editor.domElement))
})

test('editing a selected link uses the SDK form and preserves the surrounding editor content', async () => {
  const editor = BlockNoteEditor.create({
    ...blockNoteSdkEditorOptions,
    initialContent: [
      {
        type: 'paragraph',
        content: [{ type: 'link', href: 'https://example.com/original', content: 'Example' }],
      },
    ],
  })
  mount(editor)
  act(() => {
    editor.focus()
    editor.prosemirrorView.dispatch(
      editor.prosemirrorState.tr.setSelection(TextSelection.create(editor.prosemirrorState.doc, 4))
    )
  })
  const toolbar = await screen.findByTestId('task-description-link-toolbar')
  fireEvent.click(screen.getByRole('button', { name: editor.dictionary.link_toolbar.edit.tooltip }))
  const url = await screen.findByPlaceholderText(
    editor.dictionary.link_toolbar.form.url_placeholder
  )
  fireEvent.change(url, { target: { value: 'https://example.com/updated' } })
  fireEvent.keyDown(url, { key: 'Enter' })
  await waitFor(() =>
    expect(editor.document[0].content).toMatchObject([
      { type: 'link', href: 'https://example.com/updated' },
    ])
  )
  expect(editor.document).toHaveLength(1)
  await waitFor(() => expect(toolbar).not.toBeInTheDocument())
})

test('SDK link hover opens the same editor toolbar without changing selection', async () => {
  const editor = BlockNoteEditor.create({
    ...blockNoteSdkEditorOptions,
    initialContent: [
      {
        type: 'paragraph',
        content: [{ type: 'link', href: 'https://example.com/original', content: 'Example' }],
      },
    ],
  })
  mount(editor)
  const anchor = screen.getByRole('link', { name: 'Example' })
  await waitFor(() => expect(anchor).toHaveAttribute('data-closed'))
  const before = editor.prosemirrorState.selection.from
  fireEvent.pointerEnter(anchor, { pointerType: 'mouse', clientX: 40, clientY: 40 })
  await screen.findByTestId('task-description-link-toolbar')
  expect(editor.prosemirrorState.selection.from).toBe(before)
  fireEvent.keyDown(anchor, { key: 'Escape' })
  await waitFor(() =>
    expect(screen.queryByTestId('task-description-link-toolbar')).not.toBeInTheDocument()
  )
})

test('SDK nested block color menu applies the existing editor command', async () => {
  const editor = BlockNoteEditor.create({
    ...blockNoteSdkEditorOptions,
    initialContent: [{ type: 'paragraph', content: 'Keep this content' }],
  })
  mount(editor)
  const block = editor.domElement?.querySelector('[data-node-type="blockContainer"]')
  if (!block) throw new Error('Missing block')
  Object.defineProperty(document, 'elementsFromPoint', { configurable: true, value: () => [block] })
  fireEvent.mouseMove(block, { clientX: 50, clientY: 50 })
  fireEvent.click(
    await screen.findByRole('button', { name: editor.dictionary.side_menu.drag_handle_label })
  )
  const colors = await screen.findByRole('menuitem', {
    name: editor.dictionary.drag_handle.colors_menuitem,
  })
  fireEvent.click(colors)
  const green = await screen.findAllByRole('menuitemcheckbox', {
    name: editor.dictionary.color_picker.colors.green,
  })
  fireEvent.click(green[0])
  await waitFor(() => expect(editor.document[0].props).toMatchObject({ textColor: 'green' }))
  expect(editor.document[0].content).toMatchObject([{ type: 'text', text: 'Keep this content' }])
})

test('Escape without an editor popup preserves the existing exit-focus shortcut', async () => {
  const editor = BlockNoteEditor.create({
    ...blockNoteSdkEditorOptions,
    initialContent: [{ type: 'paragraph', content: 'Plain content' }],
  })
  mount(editor)
  act(() => editor.focus())
  expect(document.activeElement).toBe(editor.domElement)
  if (!editor.domElement) throw new Error('Missing editor')
  fireEvent.keyDown(editor.domElement, { key: 'Escape' })
  await waitFor(() => expect(document.activeElement).not.toBe(editor.domElement))
  expect(editor.document[0].content).toMatchObject([{ type: 'text', text: 'Plain content' }])
})

test('formatting selection retains the editor shortcut and Escape only dismisses the toolbar', async () => {
  const editor = BlockNoteEditor.create({
    ...blockNoteSdkEditorOptions,
    initialContent: [{ type: 'paragraph', content: 'Selected content' }],
  })
  mount(editor)
  act(() => {
    editor.focus()
    editor.prosemirrorView.dispatch(
      editor.prosemirrorState.tr.setSelection(
        TextSelection.create(editor.prosemirrorState.doc, 3, 3 + 'Selected content'.length)
      )
    )
  })
  await screen.findByTestId('task-description-formatting-toolbar')
  const editable = editor.domElement
  if (!editable) throw new Error('Missing editor')
  fireEvent.keyDown(editable, { key: 'b', code: 'KeyB', ctrlKey: true })
  await waitFor(() =>
    expect(editor.document[0].content).toMatchObject([
      { type: 'text', text: 'Selected content', styles: { bold: true } },
    ])
  )
  fireEvent.keyDown(editable, { key: 'Escape' })
  await waitFor(() =>
    expect(screen.queryByTestId('task-description-formatting-toolbar')).not.toBeInTheDocument()
  )
  expect(document.activeElement).toBe(editable)
})
