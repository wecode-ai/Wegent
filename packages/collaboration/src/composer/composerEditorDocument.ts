import { Slice, type Node as ProseMirrorNode } from 'prosemirror-model'
import { EditorState, TextSelection } from 'prosemirror-state'
import type { EditorView } from 'prosemirror-view'
import type {
  ComposerProseMirrorEditorProps,
  ComposerEditorSnapshot,
} from './ComposerProseMirrorEditor'
import {
  createComposerDocument,
  serializeComposerDocument,
  OBJECT_REPLACEMENT_CHARACTER,
} from './composerProseMirrorModel'
import {
  positionFromSerializedOffset,
  serializedOffsetFromPosition,
} from './composerMarkdownSerializer'
import { parseComposerMentions } from './composerMentions'
export const EXTERNAL_VALUE_META = 'composer-external-value'
export function editorAttributes(props: ComposerProseMirrorEditorProps): Record<string, string> {
  return {
    'data-testid': props.testId,
    role: 'textbox',
    'aria-multiline': 'true',
    'aria-label': props.ariaLabel || props.placeholder,
    'aria-placeholder': props.placeholder,
    spellcheck: 'true',
    rows: String(props.rows),
    placeholder: props.placeholder,
    class: `${props.className} composer-prosemirror-editor relative z-30 whitespace-pre-wrap break-words`,
  }
}

export function keepTrailingComposerCaretVisible(view: EditorView): void {
  window.requestAnimationFrame(() => {
    if (view.isDestroyed || !view.dom.isConnected) return
    const selectionAtEnd = view.state.selection.head === view.state.doc.content.size - 1
    const scroller = view.dom.closest<HTMLElement>('[data-composer-scroll-container]') ?? view.dom
    if (!selectionAtEnd || scroller.scrollHeight <= scroller.clientHeight) return

    // WebKit reports the rectangle before consecutive trailing BR nodes, so
    // ProseMirror cannot scroll the actual caret into view on its own.
    scroller.scrollTop = scroller.scrollHeight - scroller.clientHeight
  })
}

export function insertStructuredComposerText(view: EditorView, text: string): boolean {
  if (parseComposerMentions(text).length === 0) return false
  const document = createComposerDocument(text)
  view.dispatch(
    view.state.tr
      .replaceSelection(new Slice(document.content, 1, 1))
      .setMeta('uiEvent', 'input')
      .scrollIntoView()
  )
  return true
}

export function defineComposerValueProperty(view: EditorView): () => void {
  const element = view.dom
  Object.defineProperty(element, 'value', {
    configurable: true,
    get: () => serializeComposerDocument(view.state.doc),
    set: nextValue => {
      const value = String(nextValue ?? '')
      replaceComposerValue(view, value, value.length)
    },
  })
  // DevTools can retain a detached node beyond the lifetime of the view.
  return () => {
    Reflect.deleteProperty(element, 'value')
  }
}

export function readComposerSnapshot(state: EditorState): ComposerEditorSnapshot {
  const value = serializeComposerDocument(state.doc)
  const anchor = serializedOffsetFromPosition(state.doc, state.selection.anchor)
  const head = serializedOffsetFromPosition(state.doc, state.selection.head)
  return {
    value,
    selectionOffset: head,
    selectionStart: Math.min(anchor, head),
    selectionEnd: Math.max(anchor, head),
  }
}

export function emptySnapshot(): ComposerEditorSnapshot {
  return { value: '', selectionOffset: 0, selectionStart: 0, selectionEnd: 0 }
}

export function containsObjectReplacementCharacter(doc: ProseMirrorNode): boolean {
  let containsCharacter = false
  doc.descendants(node => {
    if (node.isText && node.text?.includes(OBJECT_REPLACEMENT_CHARACTER)) {
      containsCharacter = true
      return false
    }
    return !containsCharacter
  })
  return containsCharacter
}

export function replaceComposerValue(
  view: EditorView,
  value: string,
  selectionOffset?: number,
  external = false,
  scrollSelectionIntoView = false
): void {
  if (view.isDestroyed) return
  if (serializeComposerDocument(view.state.doc) === value) {
    if (selectionOffset === undefined) return
    const selection = TextSelection.create(
      view.state.doc,
      positionFromSerializedOffset(view.state.doc, selectionOffset)
    )
    if (selection.eq(view.state.selection)) {
      if (scrollSelectionIntoView) view.dispatch(view.state.tr.scrollIntoView())
      return
    }
    let selectionTransaction = view.state.tr.setSelection(selection)
    if (external) selectionTransaction = selectionTransaction.setMeta(EXTERNAL_VALUE_META, true)
    if (scrollSelectionIntoView) selectionTransaction = selectionTransaction.scrollIntoView()
    view.dispatch(selectionTransaction)
    return
  }

  const nextDoc = createComposerDocument(value)
  let transaction = view.state.tr.replaceWith(0, view.state.doc.content.size, nextDoc.content)
  if (selectionOffset !== undefined) {
    transaction = transaction.setSelection(
      TextSelection.create(
        transaction.doc,
        positionFromSerializedOffset(transaction.doc, selectionOffset)
      )
    )
  }
  if (external) transaction = transaction.setMeta(EXTERNAL_VALUE_META, true)
  if (scrollSelectionIntoView) transaction = transaction.scrollIntoView()
  view.dispatch(transaction)
}
