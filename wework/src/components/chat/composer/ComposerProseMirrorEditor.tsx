import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef } from 'react'
import type { RefObject } from 'react'
import { baseKeymap } from 'prosemirror-commands'
import { history, redo, undo } from 'prosemirror-history'
import { keymap } from 'prosemirror-keymap'
import type { Node as ProseMirrorNode } from 'prosemirror-model'
import { AllSelection, EditorState, Plugin, TextSelection } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import { ComposerMentionNodeView } from './ComposerMentionNodeView'
import {
  composerSchema,
  createComposerDocument,
  OBJECT_REPLACEMENT_CHARACTER,
  serializeComposerDocument,
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
  onPaste: (event: ClipboardEvent) => boolean
  onDrop: (event: DragEvent) => boolean
  onOpenMentionFile?: (path: string) => void
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
  const initialPropsRef = useRef(props)
  const callbacksRef = useRef(props)
  const internalValueRef = useRef(props.value)
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
        replaceComposerValue(view, value, selectionOffset)
      },
    }),
    []
  )

  useEffect(() => {
    const mount = mountRef.current
    if (!mount) return
    const initialProps = initialPropsRef.current

    const view: EditorView = new EditorView(mount, {
      state: EditorState.create({
        doc: createComposerDocument(initialProps.value),
        plugins: [
          new Plugin({
            filterTransaction(transaction) {
              return !transaction.docChanged || !containsObjectReplacementCharacter(transaction.doc)
            },
          }),
          history(),
          keymap({
            'Mod-z': undo,
            'Mod-y': redo,
            'Shift-Mod-z': redo,
            'Shift-Enter': (state, dispatch) => {
              dispatch?.(state.tr.replaceSelectionWith(composerSchema.nodes.hard_break.create()))
              return true
            },
          }),
          keymap(baseKeymap),
        ],
      }),
      attributes: editorAttributes(initialProps),
      clipboardTextSerializer(slice) {
        return serializeComposerSlice(slice)
      },
      editable: () => !callbacksRef.current.disabled,
      nodeViews: {
        composer_mention(node, view, getPos) {
          return new ComposerMentionNodeView(node, view, getPos, path =>
            callbacksRef.current.onOpenMentionFile?.(path)
          )
        },
      },
      dispatchTransaction(transaction) {
        const nextState = view.state.apply(transaction)
        view.updateState(nextState)
        const snapshot = readComposerSnapshot(nextState)
        internalValueRef.current = snapshot.value
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
    replaceComposerValue(view, props.value, selectionOffset, true)
  }, [props.value])

  return (
    <div className="relative min-w-0 flex-1 w-full">
      <div ref={mountRef} />
      {!props.value && (
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
    class: `${props.className} relative z-30 whitespace-pre-wrap break-words`,
  }
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
    !view.state.selection.empty
  ) {
    return false
  }

  const { $head } = view.state.selection
  if (event.metaKey) {
    return setComposerSelection(
      view,
      event,
      event.key === 'ArrowLeft' ? $head.start() : $head.end()
    )
  }
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
  if (adjacentNode?.type === composerSchema.nodes.composer_mention) {
    const nextPosition =
      event.key === 'ArrowLeft'
        ? $head.pos - adjacentNode.nodeSize
        : $head.pos + adjacentNode.nodeSize
    return setComposerSelection(view, event, nextPosition)
  }

  const domMention = findComposerMentionFromDOMSelection(view)
  if (!domMention) return false
  const position = view.posAtDOM(domMention, 0)
  return setComposerSelection(view, event, event.key === 'ArrowLeft' ? position : position + 1)
}

function findComposerMentionFromDOMSelection(view: EditorView): HTMLElement | null {
  const anchorNode = view.dom.ownerDocument.getSelection()?.anchorNode
  const anchorElement =
    anchorNode instanceof HTMLElement ? anchorNode : (anchorNode?.parentElement ?? null)
  const mention = anchorElement?.closest<HTMLElement>('[data-composer-skill-reference]') ?? null
  return mention && view.dom.contains(mention) ? mention : null
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
  external = false
): void {
  if (serializeComposerDocument(view.state.doc) === value) {
    if (selectionOffset === undefined) return
    const selection = TextSelection.create(
      view.state.doc,
      positionFromSerializedOffset(view.state.doc, selectionOffset)
    )
    if (selection.eq(view.state.selection)) return
    let selectionTransaction = view.state.tr.setSelection(selection)
    if (external) selectionTransaction = selectionTransaction.setMeta(EXTERNAL_VALUE_META, true)
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
  view.dispatch(transaction)
}

function serializedOffsetFromPosition(doc: ProseMirrorNode, position: number): number {
  let serializedOffset = 0
  const paragraph = doc.firstChild
  if (!paragraph) return 0

  paragraph.forEach((node, nodeOffset) => {
    const nodeStart = nodeOffset + 1
    if (nodeStart >= position) return
    if (node.isText) {
      serializedOffset += Math.min(node.text?.length ?? 0, position - nodeStart)
      return
    }
    if (node.type === composerSchema.nodes.composer_mention) {
      if (position >= nodeStart + node.nodeSize) {
        serializedOffset += String(node.attrs.reference ?? '').length
      }
      return
    }
    if (node.type === composerSchema.nodes.hard_break && position >= nodeStart + node.nodeSize) {
      serializedOffset += 1
    }
  })
  return serializedOffset
}

function positionFromSerializedOffset(doc: ProseMirrorNode, targetOffset: number): number {
  const paragraph = doc.firstChild
  if (!paragraph) return 1
  const normalizedTarget = Math.max(0, targetOffset)
  let serializedOffset = 0
  let position = doc.content.size - 1
  let resolved = false

  paragraph.forEach((node, nodeOffset) => {
    if (resolved) return
    const nodeStart = nodeOffset + 1
    if (node.isText) {
      const length = node.text?.length ?? 0
      if (normalizedTarget <= serializedOffset + length) {
        position = nodeStart + normalizedTarget - serializedOffset
        resolved = true
      } else {
        serializedOffset += length
      }
      return
    }

    const serializedLength =
      node.type === composerSchema.nodes.composer_mention
        ? String(node.attrs.reference ?? '').length
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
  })
  return position
}
