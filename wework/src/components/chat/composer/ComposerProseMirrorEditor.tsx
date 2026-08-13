import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import type { RefObject } from 'react'
import { splitBlock } from 'prosemirror-commands'
import { history, redo, undo } from 'prosemirror-history'
import { keymap } from 'prosemirror-keymap'
import { Slice, type Node as ProseMirrorNode } from 'prosemirror-model'
import { AllSelection, EditorState, Plugin, TextSelection } from 'prosemirror-state'
import { Decoration, DecorationSet, EditorView } from 'prosemirror-view'
import type { PluginReference } from '@/features/plugins/pluginNavigation'
import { ComposerMentionNodeView } from './ComposerMentionNodeView'
import { ComposerLinkNodeView } from './ComposerLinkNodeView'
import type { ComposerLinkPayload } from './composerLinks'
import {
  composerSchema,
  createComposerDocument,
  OBJECT_REPLACEMENT_CHARACTER,
  serializeComposerDocument,
  serializeComposerLinkNode,
  serializeComposerSlice,
} from './composerProseMirrorModel'

export interface ComposerEditorSnapshot {
  value: string
  selectionOffset: number
  selectionStart: number
  selectionEnd: number
}

export interface ComposerEditorHandle {
  element: HTMLElement | null
  focus: () => void
  getSnapshot: () => ComposerEditorSnapshot
  setValue: (value: string, selectionOffset?: number) => void
}

interface ComposerProseMirrorEditorProps {
  value: string
  onChange: (value: string) => void
  onSnapshotChange: (snapshot: ComposerEditorSnapshot) => void
  onKeyDown: (event: KeyboardEvent, snapshot: ComposerEditorSnapshot) => boolean
  onBeforeInput: (event: InputEvent, snapshot: ComposerEditorSnapshot) => boolean
  onKeyUp: (event: KeyboardEvent) => void
  onCompositionStart: () => void
  onCompositionEnd: () => void
  onBlur?: () => void
  onPaste: (event: ClipboardEvent) => boolean
  onDrop: (event: DragEvent) => boolean
  onOpenMentionFile?: (path: string) => void
  onOpenMentionPlugin?: (reference: PluginReference) => void
  onEditComposerLink?: (
    payload: ComposerLinkPayload,
    anchor?: HTMLElement,
    range?: { start: number; end: number }
  ) => void
  onClick: () => void
  onFocus: () => void
  disabled?: boolean
  placeholder: string
  testId: string
  rows: number
  textareaRef: RefObject<HTMLElement | null>
  className: string
}

const EXTERNAL_VALUE_META = 'composer-external-value'

export const ComposerProseMirrorEditor = forwardRef<
  ComposerEditorHandle,
  ComposerProseMirrorEditorProps
>(function ComposerProseMirrorEditor(props, forwardedRef) {
  const mountRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const textareaRefRef = useRef(props.textareaRef)
  const callbacksRef = useRef(props)
  const internalValueRef = useRef(props.value)
  const [hasContent, setHasContent] = useState(props.value !== '')
  callbacksRef.current = props

  useLayoutEffect(() => {
    textareaRefRef.current = props.textareaRef
    ;(props.textareaRef as { current: HTMLElement | null }).current = viewRef.current?.dom ?? null
  }, [props.textareaRef])

  useImperativeHandle(
    forwardedRef,
    () => ({
      get element() {
        return viewRef.current?.dom ?? null
      },
      focus() {
        viewRef.current?.focus()
      },
      getSnapshot() {
        return viewRef.current ? readComposerSnapshot(viewRef.current.state) : emptySnapshot()
      },
      setValue(value, selectionOffset = value.length) {
        const view = viewRef.current
        if (!view) return
        replaceComposerValue(view, value, selectionOffset, false, true)
      },
    }),
    []
  )

  useEffect(() => {
    const mount = mountRef.current
    if (!mount) return
    const initialProps = callbacksRef.current
    internalValueRef.current = initialProps.value

    const view: EditorView = new EditorView(mount, {
      state: EditorState.create({
        doc: createComposerDocument(initialProps.value),
        plugins: [
          new Plugin({
            filterTransaction(transaction) {
              return !transaction.docChanged || !containsObjectReplacementCharacter(transaction.doc)
            },
          }),
          new Plugin({
            props: {
              decorations(state) {
                if (
                  !state.selection.empty ||
                  !state.selection.$head.parent.isTextblock ||
                  state.selection.$head.parent.content.size > 0
                ) {
                  return null
                }
                return DecorationSet.create(state.doc, [
                  Decoration.widget(
                    state.selection.head,
                    () => {
                      const caret = document.createElement('span')
                      caret.className = 'composer-empty-caret'
                      caret.setAttribute('aria-hidden', 'true')
                      return caret
                    },
                    { key: 'composer-empty-caret', side: -1 }
                  ),
                ])
              },
            },
          }),
          history(),
          keymap({
            'Mod-z': undo,
            'Mod-y': redo,
            'Shift-Mod-z': redo,
            'Shift-Enter': (state, dispatch, view) => {
              const handled = splitBlock(
                state,
                dispatch ? transaction => dispatch(transaction.scrollIntoView()) : undefined,
                view
              )
              if (handled && dispatch && view) keepTrailingComposerCaretVisible(view)
              return handled
            },
          }),
        ],
      }),
      attributes: editorAttributes(initialProps),
      clipboardTextSerializer(slice) {
        return serializeComposerSlice(slice)
      },
      editable: () => !callbacksRef.current.disabled,
      nodeViews: {
        composer_mention(node, view, getPos) {
          return new ComposerMentionNodeView(
            node,
            view,
            getPos,
            path => callbacksRef.current.onOpenMentionFile?.(path),
            reference => callbacksRef.current.onOpenMentionPlugin?.(reference)
          )
        },
        composer_link(node, view, getPos) {
          return new ComposerLinkNodeView(node, view, getPos, {
            onEditLink: (payload, anchor, range) =>
              callbacksRef.current.onEditComposerLink?.(payload, anchor, range),
          })
        },
      },
      dispatchTransaction(transaction) {
        const nextState = view.state.apply(transaction)
        view.updateState(nextState)
        const snapshot = readComposerSnapshot(nextState)
        internalValueRef.current = snapshot.value
        setHasContent(snapshot.value !== '')
        if (transaction.docChanged && !transaction.getMeta(EXTERNAL_VALUE_META)) {
          callbacksRef.current.onChange(snapshot.value)
        }
        callbacksRef.current.onSnapshotChange(snapshot)
      },
      handleTextInput(_view, from, to, text): boolean {
        if (!text.includes(OBJECT_REPLACEMENT_CHARACTER)) return false
        const sanitizedText = text.replaceAll(OBJECT_REPLACEMENT_CHARACTER, '')
        if (sanitizedText) view.dispatch(view.state.tr.insertText(sanitizedText, from, to))
        return true
      },
      handlePaste(view, event) {
        const text =
          event.clipboardData?.getData('text/plain') || event.clipboardData?.getData('text')
        if (!text) return false
        const pastedDocument = createComposerDocument(text)
        let transaction = view.state.tr.replaceSelection(new Slice(pastedDocument.content, 1, 1))
        transaction = transaction.setSelection(TextSelection.atEnd(transaction.doc))
        view.dispatch(
          transaction.setMeta('paste', true).setMeta('uiEvent', 'paste').scrollIntoView()
        )
        return true
      },
      handleDOMEvents: {
        paste(_view, event) {
          return callbacksRef.current.onPaste(event)
        },
        drop(_view, event) {
          return callbacksRef.current.onDrop(event)
        },
        keyup(_view, event) {
          callbacksRef.current.onKeyUp(event)
          return false
        },
        compositionstart() {
          callbacksRef.current.onCompositionStart()
          return false
        },
        compositionend() {
          callbacksRef.current.onCompositionEnd()
          return false
        },
        click() {
          callbacksRef.current.onClick()
          return false
        },
        focus() {
          callbacksRef.current.onFocus()
          return false
        },
        blur() {
          callbacksRef.current.onBlur?.()
          return false
        },
      },
    })

    const handleKeyDownCapture = (event: KeyboardEvent) => {
      if (selectAllComposerContent(view, event)) {
        event.preventDefault()
        event.stopImmediatePropagation()
        return
      }
      const handledByComposer = callbacksRef.current.onKeyDown(
        event,
        readComposerSnapshot(view.state)
      )
      if (!handledByComposer && !moveCaretAcrossComposerMention(view, event)) return
      event.preventDefault()
      event.stopImmediatePropagation()
    }
    const handleCopyCapture = (event: ClipboardEvent) => {
      if (!event.clipboardData || view.state.selection.empty) return
      const snapshot = readComposerSnapshot(view.state)
      event.clipboardData.setData(
        'text/plain',
        snapshot.value.slice(snapshot.selectionStart, snapshot.selectionEnd)
      )
      event.preventDefault()
      event.stopImmediatePropagation()
    }
    const handleBeforeInputCapture = (event: InputEvent) => {
      const handledByComposer = callbacksRef.current.onBeforeInput(
        event,
        readComposerSnapshot(view.state)
      )
      const containsReplacementCharacter = event.data?.includes(OBJECT_REPLACEMENT_CHARACTER)
      if (!handledByComposer && !containsReplacementCharacter) return
      event.preventDefault()
      event.stopImmediatePropagation()
    }
    view.dom.addEventListener('keydown', handleKeyDownCapture, true)
    view.dom.addEventListener('beforeinput', handleBeforeInputCapture, true)
    view.dom.addEventListener('copy', handleCopyCapture, true)

    viewRef.current = view
    ;(textareaRefRef.current as { current: HTMLElement | null }).current = view.dom
    defineComposerValueProperty(view)
    callbacksRef.current.onSnapshotChange(readComposerSnapshot(view.state))

    return () => {
      if (viewRef.current === view) viewRef.current = null
      if (textareaRefRef.current.current === view.dom) {
        ;(textareaRefRef.current as { current: HTMLElement | null }).current = null
      }
      view.dom.removeEventListener('keydown', handleKeyDownCapture, true)
      view.dom.removeEventListener('beforeinput', handleBeforeInputCapture, true)
      view.dom.removeEventListener('copy', handleCopyCapture, true)
      view.destroy()
    }
  }, [])

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const currentProps = callbacksRef.current
    view.setProps({
      attributes: editorAttributes(currentProps),
      editable: () => !callbacksRef.current.disabled,
    })
  }, [props.className, props.disabled, props.placeholder, props.rows, props.testId])

  useEffect(() => {
    const view = viewRef.current
    if (!view || props.value === internalValueRef.current) return
    const selectionOffset = view.hasFocus() ? props.value.length : undefined
    setHasContent(props.value !== '')
    replaceComposerValue(view, props.value, selectionOffset, true)
  }, [props.value])

  return (
    <div className="relative min-w-0 flex-1 w-full">
      <div ref={mountRef} />
      {!hasContent && (
        <div
          className={`${props.className} pointer-events-none absolute inset-0 !text-text-muted/55`}
        >
          {props.placeholder}
        </div>
      )}
    </div>
  )
})

function editorAttributes(props: ComposerProseMirrorEditorProps): Record<string, string> {
  return {
    'data-testid': props.testId,
    role: 'textbox',
    'aria-multiline': 'true',
    spellcheck: 'true',
    rows: String(props.rows),
    placeholder: props.placeholder,
    class: `${props.className} composer-prosemirror-editor relative z-30 whitespace-pre-wrap break-words`,
  }
}

function keepTrailingComposerCaretVisible(view: EditorView): void {
  window.requestAnimationFrame(() => {
    const selectionAtEnd = view.state.selection.head === view.state.doc.content.size - 1
    if (!selectionAtEnd || view.dom.scrollHeight <= view.dom.clientHeight) return

    // WebKit reports the rectangle before consecutive trailing BR nodes, so
    // ProseMirror cannot scroll the actual caret into view on its own.
    view.dom.scrollTop = view.dom.scrollHeight - view.dom.clientHeight
  })
}

function defineComposerValueProperty(view: EditorView): void {
  Object.defineProperty(view.dom, 'value', {
    configurable: true,
    get: () => serializeComposerDocument(view.state.doc),
    set: nextValue => {
      const value = String(nextValue ?? '')
      replaceComposerValue(view, value, value.length)
    },
  })
}

function readComposerSnapshot(state: EditorState): ComposerEditorSnapshot {
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

function emptySnapshot(): ComposerEditorSnapshot {
  return { value: '', selectionOffset: 0, selectionStart: 0, selectionEnd: 0 }
}

function moveCaretAcrossComposerMention(view: EditorView, event: KeyboardEvent): boolean {
  if (
    (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') ||
    event.shiftKey ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    !view.state.selection.empty
  ) {
    return false
  }

  const { $head } = view.state.selection
  if (event.key === 'ArrowLeft' && $head.pos === $head.start()) {
    return setComposerSelection(view, event, $head.pos)
  }
  if (event.key === 'ArrowRight' && $head.pos === $head.end()) {
    return setComposerSelection(view, event, $head.pos)
  }
  if (
    event.key === 'ArrowLeft' &&
    $head.nodeBefore?.isText &&
    $head.nodeBefore.text?.endsWith(' ') &&
    view.state.doc.resolve($head.pos - 1).nodeBefore?.type === composerSchema.nodes.composer_mention
  ) {
    return setComposerSelection(view, event, $head.pos - 1)
  }

  const mentionBefore = $head.nodeBefore?.type === composerSchema.nodes.composer_mention
  const mentionAfter = $head.nodeAfter?.type === composerSchema.nodes.composer_mention

  if (event.key === 'ArrowLeft' && mentionAfter) {
    return setComposerSelection(view, event, Math.max($head.start(), $head.pos - 1))
  }
  if (event.key === 'ArrowRight' && mentionBefore) {
    return setComposerSelection(view, event, Math.min($head.end(), $head.pos + 1))
  }

  const adjacentNode = event.key === 'ArrowLeft' ? $head.nodeBefore : $head.nodeAfter
  if (
    adjacentNode?.type === composerSchema.nodes.composer_mention ||
    adjacentNode?.type === composerSchema.nodes.composer_link
  ) {
    const nextPosition =
      event.key === 'ArrowLeft'
        ? $head.pos - adjacentNode.nodeSize
        : $head.pos + adjacentNode.nodeSize
    return setComposerSelection(view, event, nextPosition)
  }

  const domAtom = findComposerAtomFromDOMSelection(view)
  if (!domAtom) return false
  const position = view.posAtDOM(domAtom, 0)
  return setComposerSelection(view, event, event.key === 'ArrowLeft' ? position : position + 1)
}

function findComposerAtomFromDOMSelection(view: EditorView): HTMLElement | null {
  const anchorNode = view.dom.ownerDocument.getSelection()?.anchorNode
  const anchorElement =
    anchorNode instanceof HTMLElement ? anchorNode : (anchorNode?.parentElement ?? null)
  const atom =
    anchorElement?.closest<HTMLElement>(
      '[data-composer-skill-reference], [data-composer-link-url]'
    ) ?? null
  return atom && view.dom.contains(atom) ? atom : null
}

function setComposerSelection(view: EditorView, event: KeyboardEvent, position: number): boolean {
  event.preventDefault()
  event.stopPropagation()
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, position)))
  view.focus()
  return true
}

function selectAllComposerContent(view: EditorView, event: KeyboardEvent): boolean {
  if (
    event.key.toLowerCase() !== 'a' ||
    !event.metaKey ||
    event.shiftKey ||
    event.altKey ||
    event.ctrlKey
  ) {
    return false
  }
  view.dispatch(view.state.tr.setSelection(new AllSelection(view.state.doc)))
  view.focus()
  return true
}

function containsObjectReplacementCharacter(doc: ProseMirrorNode): boolean {
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

function replaceComposerValue(
  view: EditorView,
  value: string,
  selectionOffset?: number,
  external = false,
  scrollSelectionIntoView = false
): void {
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

function serializedOffsetFromPosition(doc: ProseMirrorNode, position: number): number {
  let serializedOffset = 0
  doc.descendants((node, nodeStart) => {
    if (nodeStart >= position) return false
    if (node.type === composerSchema.nodes.paragraph) {
      if (nodeStart > 0 && position > nodeStart) serializedOffset += 1
      return true
    }
    if (node.isText) {
      serializedOffset += Math.min(node.text?.length ?? 0, position - nodeStart)
      return false
    }
    if (node.type === composerSchema.nodes.composer_mention) {
      if (position >= nodeStart + node.nodeSize) {
        serializedOffset += String(node.attrs.reference ?? '').length
      }
      return false
    }
    if (node.type === composerSchema.nodes.composer_link) {
      if (position >= nodeStart + node.nodeSize) {
        serializedOffset += serializeComposerLinkNode(node).length
      }
      return false
    }
    if (node.type === composerSchema.nodes.hard_break && position >= nodeStart + node.nodeSize) {
      serializedOffset += 1
    }
    return false
  })
  return serializedOffset
}

function positionFromSerializedOffset(doc: ProseMirrorNode, targetOffset: number): number {
  const normalizedTarget = Math.max(0, targetOffset)
  let serializedOffset = 0
  let position = doc.content.size - 1
  let resolved = false

  doc.descendants((node, nodeStart) => {
    if (resolved) return false
    if (node.type === composerSchema.nodes.paragraph) {
      if (normalizedTarget === serializedOffset) {
        position = nodeStart + 1
        resolved = true
        return false
      }
      if (nodeStart > 0) {
        serializedOffset += 1
        if (normalizedTarget <= serializedOffset) {
          position = nodeStart + 1
          resolved = true
          return false
        }
      }
      return true
    }
    if (node.isText) {
      const length = node.text?.length ?? 0
      if (normalizedTarget <= serializedOffset + length) {
        position = nodeStart + normalizedTarget - serializedOffset
        resolved = true
      } else {
        serializedOffset += length
      }
      return false
    }

    const serializedLength =
      node.type === composerSchema.nodes.composer_mention
        ? String(node.attrs.reference ?? '').length
        : node.type === composerSchema.nodes.composer_link
          ? serializeComposerLinkNode(node).length
          : node.type === composerSchema.nodes.hard_break
            ? 1
            : 0
    if (normalizedTarget <= serializedOffset) {
      position = nodeStart
      resolved = true
    } else if (normalizedTarget <= serializedOffset + serializedLength) {
      position = nodeStart + node.nodeSize
      resolved = true
    } else {
      serializedOffset += serializedLength
    }
    return false
  })
  return position
}
