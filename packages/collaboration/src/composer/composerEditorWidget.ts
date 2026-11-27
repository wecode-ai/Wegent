import {
  moveCaretAcrossComposerMention,
  moveComposerCaretToBoundary,
  selectAllComposerContent,
} from './composerEditorKeyboard'
import { browserComposerEditorServices } from './ComposerEditorServices'
import { isInTable, tableEditing } from 'prosemirror-tables'
import {
  insertComposerLineBreak,
  moveComposerTableCell,
  trailingComposerParagraph,
} from './composerMarkdownEditing'
import { chainCommands, deleteSelection, joinBackward, joinForward } from 'prosemirror-commands'
import { history, redo, undo } from 'prosemirror-history'
import { keymap } from 'prosemirror-keymap'
import { Fragment, Slice } from 'prosemirror-model'
import { AllSelection, EditorState, Plugin } from 'prosemirror-state'
import { Decoration, DecorationSet, EditorView, type NodeViewConstructor } from 'prosemirror-view'
import { ComposerMentionNodeView } from './ComposerMentionNodeView'
import { ComposerLinkNodeView } from './ComposerLinkNodeView'
import {
  allocateComposerDiagnosticId,
  classifyComposerInputData,
  diagnosticKeyboardKey,
  recordComposerDiagnostic,
  roundComposerDuration,
} from './composerDiagnostics'
import {
  createComposerDocument,
  OBJECT_REPLACEMENT_CHARACTER,
  serializeComposerDocument,
  serializeComposerSlice,
} from './composerProseMirrorModel'
import { composerTextLinks, openComposerTextLink } from './composerTextLinks'
import { parseComposerClipboardHtml, serializeComposerClipboardHtml } from './composerClipboard'
import {
  composerMarkdownInputRules,
  convertTypedComposerTable,
  indentComposerList,
} from './composerMarkdownInputRules'
import { observeComposerScrollFade } from './composerScrollFade'

import type {
  ComposerEditorHandle,
  ComposerProseMirrorEditorProps,
} from './ComposerProseMirrorEditor'
import {
  EXTERNAL_VALUE_META,
  editorAttributes,
  keepTrailingComposerCaretVisible,
  insertStructuredComposerText,
  defineComposerValueProperty,
  readComposerSnapshot,
  emptySnapshot,
  containsObjectReplacementCharacter,
  replaceComposerValue,
} from './composerEditorDocument'

const SLOW_INPUT_FRAME_MS = 32

interface EditorPresentation {
  value: string
  composing: boolean
}
interface RetainedEditorDocument {
  widgets: Map<HTMLElement, () => void>
  observer: MutationObserver
}
const retainedDocuments = new WeakMap<Document, RetainedEditorDocument>()
function watchDetachedWidget(mount: HTMLElement, dispose: () => void) {
  const document = mount.ownerDocument
  let retained = retainedDocuments.get(document)
  if (!retained) {
    const widgets = new Map<HTMLElement, () => void>()
    const observer = new MutationObserver(() => {
      for (const [element, destroy] of widgets)
        if (!element.isConnected) {
          widgets.delete(element)
          destroy()
        }
      if (!widgets.size) {
        observer.disconnect()
        retainedDocuments.delete(document)
      }
    })
    retained = { widgets, observer }
    retainedDocuments.set(document, retained)
    observer.observe(document, { childList: true, subtree: true })
  }
  retained.widgets.set(mount, dispose)
}
function stopWatchingDetachedWidget(mount: HTMLElement) {
  const document = mount.ownerDocument
  const retained = retainedDocuments.get(document)
  retained?.widgets.delete(mount)
  if (retained && !retained.widgets.size) {
    retained.observer.disconnect()
    retainedDocuments.delete(document)
  }
}

/** Owns the actual ProseMirror view, committed native properties and widget lifetime. */
export function createComposerEditorWidget(initial: ComposerProseMirrorEditorProps) {
  let currentProps = { ...initial, services: initial.services ?? browserComposerEditorServices }
  let currentView: EditorView | null = null
  let mount: HTMLElement | null = null
  let attached = false
  let live = false
  let suspended = false
  let lease = 0
  let ownershipRevision = 0
  let documentRevision = 0
  let transactionRevision = 0
  let pendingFocus = false
  let composerDiagnosticId: number | null = null
  let destroyView: (() => void) | undefined
  let releaseWindowFocus: (() => void) | undefined
  let releaseFade: (() => void) | undefined
  let snapshot: EditorPresentation = { value: initial.value, composing: false }
  const listeners = new Set<() => void>()
  const publish = (patch: Partial<EditorPresentation>) => {
    const next = { ...snapshot, ...patch }
    if (next.value === snapshot.value && next.composing === snapshot.composing) return
    snapshot = next
    for (const listener of listeners) listener()
  }
  const isCurrent = (view: EditorView) =>
    live && currentView === view && !!mount?.isConnected && !view.isDestroyed
  const isActive = (view: EditorView) => attached && isCurrent(view)
  const makeMentionView = (): NodeViewConstructor => (node, view, getPos) =>
    new ComposerMentionNodeView(
      node,
      view,
      getPos,
      path => {
        if (isActive(view)) currentProps.onOpenMentionFile?.(path)
      },
      reference => {
        if (isActive(view)) currentProps.onOpenMentionPlugin?.(reference)
      },
      href =>
        live && !view.isDestroyed
          ? (currentProps.services.resolveMentionIcon?.(href) ?? null)
          : null,
      currentProps.onActivateMention
        ? reference => isActive(view) && (currentProps.onActivateMention?.(reference) ?? false)
        : undefined,
      currentProps.onOpenMentionReference
        ? (href, label) => {
            if (isActive(view)) currentProps.onOpenMentionReference?.(href, label)
          }
        : undefined
    )
  let createMentionView = makeMentionView()
  const scheduleReady = (view: EditorView) =>
    queueMicrotask(() => {
      if (!isActive(view)) return
      currentProps.onSnapshotChange(readComposerSnapshot(view.state))
      if (!isActive(view)) return
      currentProps.onReady?.()
      if (pendingFocus && isActive(view)) {
        pendingFocus = false
        view.focus()
      }
    })
  const create = (mount: HTMLElement) => {
    live = true

    const initialProps = currentProps
    const composerId = allocateComposerDiagnosticId()
    composerDiagnosticId = composerId
    recordComposerDiagnostic('editor-mounted', {
      composerId,
      valueLength: initialProps.value.length,
    })
    publish({ value: initialProps.value, composing: false })
    let lastBeforeInputAt: number | null = null
    let inputFrameStartedAt: number | null = null
    let inputFrameRequest: number | null = null
    let inputFrameEventCount = 0

    const tablePlugin = tableEditing()
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
                  state.selection.$head.parent.content.size > 0 ||
                  // WKWebView and explicitly native composers need the only
                  // empty text position to remain native so programmatic focus
                  // can start a platform text input session.
                  ((currentProps.services.preserveNativeEmptyCaret ||
                    currentProps.nativeEmptyCaret) &&
                    state.doc.childCount === 1 &&
                    state.doc.firstChild?.content.size === 0)
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
          composerMarkdownInputRules(),
          composerTextLinks((...args) => {
            if (isActive(view)) currentProps.onEditComposerLink?.(...args)
          }),
          trailingComposerParagraph,
          keymap({
            Tab: chainCommands(moveComposerTableCell(1), indentComposerList(1)),
            'Shift-Tab': chainCommands(moveComposerTableCell(-1), indentComposerList(-1)),
            'Mod-z': undo,
            'Mod-y': redo,
            'Shift-Mod-z': redo,
            Backspace: chainCommands(deleteSelection, joinBackward),
            Delete: chainCommands(deleteSelection, joinForward),
            'Shift-Enter': (state, dispatch, view) => {
              const handled = insertComposerLineBreak(
                state,
                dispatch ? transaction => dispatch(transaction.scrollIntoView()) : undefined,
                view
              )
              if (handled && dispatch && view) keepTrailingComposerCaretVisible(view)
              return handled
            },
          }),
          tablePlugin,
        ],
      }),
      attributes: editorAttributes(initialProps),
      clipboardTextSerializer(slice) {
        return serializeComposerSlice(slice)
      },
      editable: () => !currentProps.disabled,
      nodeViews: {
        composer_mention: createMentionView,
        composer_link(node, view, getPos) {
          return new ComposerLinkNodeView(node, view, getPos, {
            onEditLink: (payload, anchor, range) => {
              if (isActive(view)) currentProps.onEditComposerLink?.(payload, anchor, range)
            },
          })
        },
      },
      dispatchTransaction(transaction) {
        if (!isCurrent(view) || !transaction.before.eq(view.state.doc)) return
        const transactionVersion = ++transactionRevision
        const transactionStartedAt = performance.now()
        const nextState = view.state.apply(transaction)
        if (nextState.doc !== view.state.doc) documentRevision++
        view.updateState(nextState)
        const snapshot = readComposerSnapshot(nextState)
        publish({ value: snapshot.value })
        if (transaction.docChanged && !transaction.getMeta(EXTERNAL_VALUE_META)) {
          currentProps.onChange(snapshot.value)
        }
        if (isActive(view) && transactionVersion === transactionRevision)
          currentProps.onSnapshotChange(snapshot)
        if (transaction.docChanged) {
          recordComposerDiagnostic('transaction', {
            composerId,
            docChanged: true,
            external: Boolean(transaction.getMeta(EXTERNAL_VALUE_META)),
            viewIsComposing: view.composing,
            valueLength: snapshot.value.length,
            selectionStart: snapshot.selectionStart,
            selectionEnd: snapshot.selectionEnd,
            transactionMs: performance.now() - transactionStartedAt,
            elapsedMs: lastBeforeInputAt === null ? null : performance.now() - lastBeforeInputAt,
          })
          lastBeforeInputAt = null
        }
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
        if (view.state.selection.$from.parent.type.spec.code) {
          if (!text) return false
          view.dispatch(view.state.tr.insertText(text).scrollIntoView())
          return true
        }
        const htmlDocument = parseComposerClipboardHtml(
          event.clipboardData?.getData('text/html') ?? ''
        )
        if (!text && !htmlDocument) return false
        const pastedDocument = htmlDocument ?? createComposerDocument(text || '')
        const { $from, empty } = view.state.selection
        if (
          isInTable(view.state) &&
          pastedDocument.firstChild?.type.name === 'table' &&
          (pastedDocument.childCount === 1 ||
            (pastedDocument.childCount === 2 && pastedDocument.lastChild?.attrs.trailing))
        ) {
          return (
            tablePlugin.props.handlePaste?.call(
              tablePlugin,
              view,
              event,
              new Slice(Fragment.from(pastedDocument.firstChild), 0, 0)
            ) ?? false
          )
        }
        const replaceEmptyParagraph =
          empty &&
          $from.parent.type.name === 'paragraph' &&
          $from.parent.content.size === 0 &&
          !isInTable(view.state) &&
          pastedDocument.firstChild?.type.name !== 'paragraph'
        const transaction = replaceEmptyParagraph
          ? view.state.tr.replaceWith($from.before(), $from.after(), pastedDocument.content)
          : view.state.tr.replaceSelection(Slice.maxOpen(pastedDocument.content))
        view.dispatch(
          transaction.setMeta('paste', true).setMeta('uiEvent', 'paste').scrollIntoView()
        )
        return true
      },
      handleDOMEvents: {
        keydown(_view, event) {
          // Composer capture already handles its own menus. Let unhandled Escape
          // reach the host before ProseMirror suppresses its native default.
          return (
            event.key === 'Escape' &&
            !event.defaultPrevented &&
            !event.isComposing &&
            event.keyCode !== 229
          )
        },
        paste(_view, event) {
          if (!isActive(view)) return false
          return currentProps.onPaste(event)
        },
        drop(_view, event) {
          if (!isActive(view)) return false
          return currentProps.onDrop(event)
        },
        keyup(_view, event) {
          if (!isActive(view)) return false
          currentProps.onKeyUp(event)
          return false
        },
        compositionstart() {
          if (!isCurrent(view)) return false
          publish({ composing: true })
          recordComposerDiagnostic('composition-start', {
            composerId,
            viewIsComposing: view.composing,
            valueLength: snapshot.value.length,
          })
          currentProps.onCompositionStart()
          return false
        },
        compositionend() {
          if (!isCurrent(view)) return false
          publish({ composing: false })
          recordComposerDiagnostic('composition-end', {
            composerId,
            viewIsComposing: view.composing,
            valueLength: snapshot.value.length,
          })
          currentProps.onCompositionEnd()
          return false
        },
        click() {
          if (!isActive(view)) return false
          currentProps.onClick()
          return false
        },
        focus() {
          if (!isActive(view)) return false
          view.dom.toggleAttribute(
            'data-composer-focus-visible',
            currentProps.services.isWindowFocused()
          )
          currentProps.onFocus()
          return false
        },
        blur() {
          if (!isCurrent(view)) return false
          view.dom.removeAttribute('data-composer-focus-visible')
          currentProps.onBlur?.()
          return false
        },
      },
    })
    releaseWindowFocus = initialProps.services.subscribeWindowFocus(focused => {
      if (!isActive(view)) return
      view.dom.toggleAttribute('data-composer-focus-visible', focused && view.hasFocus())
    })
    view.dom.toggleAttribute(
      'data-composer-focus-visible',
      currentProps.services.isWindowFocused() && view.hasFocus()
    )

    /** Lets focused mention nodes handle Enter and Space before composer submit. */
    const handleKeyDownCapture = (event: KeyboardEvent) => {
      if (!isActive(view)) return
      if (
        event.target instanceof Element &&
        event.target.closest(
          '.composer-mention-node[role="button"], .composer-mention-node[data-composer-reference-navigation]'
        )
      )
        return
      if (event.key.length === 1) {
        recordComposerDiagnostic('keyboard-text', {
          composerId,
          trusted: event.isTrusted,
          valueLength: snapshot.value.length,
          ...classifyComposerInputData(event.key),
        })
      }
      const prediction = currentProps.prediction
      if (
        prediction &&
        !currentProps.disabled &&
        !view.composing &&
        !event.isComposing &&
        event.keyCode !== 229 &&
        !event.shiftKey &&
        !event.altKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        ['Tab', 'ArrowRight', 'Enter'].includes(event.key) &&
        view.state.doc.childCount === 1 &&
        view.state.doc.firstChild?.content.size === 0
      ) {
        recordComposerDiagnostic('prediction-accepted', {
          composerId,
          key: event.key,
          trusted: event.isTrusted,
          valueLength: prediction.text.length,
        })
        replaceComposerValue(view, prediction.text, prediction.text.length, false)
        if (isActive(view)) prediction.onAccept()
        event.preventDefault()
        event.stopImmediatePropagation()
        return
      }
      if (
        openComposerTextLink(view, event, (...args) => currentProps.onEditComposerLink?.(...args))
      ) {
        event.stopImmediatePropagation()
        return
      }
      const diagnosticKey = diagnosticKeyboardKey(event.key)
      if (diagnosticKey) {
        recordComposerDiagnostic('keyboard', {
          composerId,
          key: diagnosticKey,
          code: event.code,
          keyCode: event.keyCode,
          eventIsComposing: event.isComposing,
          viewIsComposing: view.composing,
          shiftKey: event.shiftKey,
          altKey: event.altKey,
          ctrlKey: event.ctrlKey,
          metaKey: event.metaKey,
          valueLength: snapshot.value.length,
        })
      }
      if (selectAllComposerContent(view, event)) {
        event.preventDefault()
        event.stopImmediatePropagation()
        return
      }
      if (moveComposerCaretToBoundary(view, event)) {
        event.preventDefault()
        event.stopImmediatePropagation()
        return
      }
      if (
        event.key === 'Enter' &&
        !event.shiftKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        convertTypedComposerTable(view)
      ) {
        event.preventDefault()
        event.stopImmediatePropagation()
        return
      }
      const handledByComposer = currentProps.onKeyDown(event, readComposerSnapshot(view.state))
      if (!handledByComposer && !moveCaretAcrossComposerMention(view, event)) return
      event.preventDefault()
      event.stopImmediatePropagation()
    }
    const handleCopyCapture = (event: ClipboardEvent) => {
      if (!isActive(view)) return
      if (!event.clipboardData || view.state.selection.empty) return
      event.clipboardData.setData(
        'text/html',
        serializeComposerClipboardHtml(view.state.selection.content())
      )
      event.clipboardData.setData(
        'text/plain',
        view.state.selection instanceof AllSelection
          ? serializeComposerDocument(view.state.doc)
          : serializeComposerSlice(view.state.selection.content())
      )
      event.preventDefault()
      event.stopImmediatePropagation()
    }
    const handleBeforeInputCapture = (event: InputEvent) => {
      if (!isActive(view)) return
      const now = performance.now()
      lastBeforeInputAt = now
      inputFrameStartedAt ??= now
      inputFrameEventCount += 1
      recordComposerDiagnostic('before-input', {
        composerId,
        inputType: event.inputType,
        eventIsComposing: event.isComposing,
        viewIsComposing: view.composing,
        valueLength: snapshot.value.length,
        ...classifyComposerInputData(event.data),
      })
      if (inputFrameRequest === null) {
        inputFrameRequest = window.requestAnimationFrame(() => {
          if (!isActive(view)) {
            inputFrameRequest = null
            return
          }
          const frameDelayMs =
            inputFrameStartedAt === null ? 0 : performance.now() - inputFrameStartedAt
          if (frameDelayMs >= SLOW_INPUT_FRAME_MS) {
            recordComposerDiagnostic('input-frame', {
              composerId,
              frameDelayMs: roundComposerDuration(frameDelayMs),
              eventCount: inputFrameEventCount,
              viewIsComposing: view.composing,
              valueLength: snapshot.value.length,
            })
          }
          inputFrameRequest = null
          inputFrameStartedAt = null
          inputFrameEventCount = 0
        })
      }
      const handledByComposer = currentProps.onBeforeInput(event, readComposerSnapshot(view.state))
      const handledStructuredText =
        !handledByComposer &&
        event.inputType === 'insertText' &&
        !event.isComposing &&
        !view.composing &&
        Boolean(event.data) &&
        insertStructuredComposerText(view, event.data ?? '')
      const containsReplacementCharacter = event.data?.includes(OBJECT_REPLACEMENT_CHARACTER)
      if (!handledByComposer && !handledStructuredText && !containsReplacementCharacter) return
      event.preventDefault()
      event.stopImmediatePropagation()
    }
    view.dom.addEventListener('keydown', handleKeyDownCapture, true)
    view.dom.addEventListener('beforeinput', handleBeforeInputCapture, true)
    view.dom.addEventListener('copy', handleCopyCapture, true)

    currentView = view
    ;(currentProps.textareaRef as { current: HTMLElement | null }).current = view.dom
    const releaseValueProperty = defineComposerValueProperty(view)
    publish({ value: readComposerSnapshot(view.state).value, composing: view.composing })
    scheduleReady(view)

    return () => {
      live = false
      if (inputFrameRequest !== null) window.cancelAnimationFrame(inputFrameRequest)
      recordComposerDiagnostic('editor-unmounted', {
        composerId,
        valueLength: snapshot.value.length,
      })
      composerDiagnosticId = null
      if (currentView === view) currentView = null
      if (currentProps.textareaRef.current === view.dom) {
        ;(currentProps.textareaRef as { current: HTMLElement | null }).current = null
      }
      view.dom.removeEventListener('keydown', handleKeyDownCapture, true)
      view.dom.removeEventListener('beforeinput', handleBeforeInputCapture, true)
      view.dom.removeEventListener('copy', handleCopyCapture, true)
      releaseWindowFocus?.()
      releaseWindowFocus = undefined
      releaseValueProperty()
      view.destroy()
    }
  }
  const dispose = () => {
    if (mount) stopWatchingDetachedWidget(mount)
    releaseFade?.()
    releaseFade = undefined
    destroyView?.()
    destroyView = undefined
    currentView = null
    mount = null
    live = false
    ownershipRevision++
  }
  const bindWindowFocus = () => {
    releaseWindowFocus?.()
    const view = currentView
    if (!view) return
    releaseWindowFocus = currentProps.services.subscribeWindowFocus(focused => {
      if (isActive(view))
        view.dom.toggleAttribute('data-composer-focus-visible', focused && view.hasFocus())
    })
    view.dom.toggleAttribute(
      'data-composer-focus-visible',
      currentProps.services.isWindowFocused() && view.hasFocus()
    )
  }
  const bindFade = () => {
    releaseFade?.()
    releaseFade = undefined
    const view = currentView
    const viewport = mount?.parentElement
    if (viewport && view && currentProps.scrollContainerClassName)
      releaseFade = observeComposerScrollFade(viewport, view.dom, () => {
        if (isActive(view) && view.hasFocus()) view.dispatch(view.state.tr.scrollIntoView())
      })
  }
  const handle: ComposerEditorHandle = {
    get element() {
      return attached ? (currentView?.dom ?? null) : null
    },
    focus() {
      const view = currentView
      if (!view) {
        pendingFocus = true
        return
      }
      if (!isActive(view)) return
      pendingFocus = false
      view.focus()
      view.dispatch(view.state.tr.scrollIntoView())
    },
    getSnapshot() {
      return currentView ? readComposerSnapshot(currentView.state) : emptySnapshot()
    },
    captureInsertion() {
      const view = currentView,
        revision = documentRevision,
        owner = ownershipRevision,
        selection = view?.state.selection
      let inserted = false
      return {
        insertText(text) {
          if (
            !view ||
            !selection ||
            inserted ||
            !isActive(view) ||
            owner !== ownershipRevision ||
            documentRevision !== revision ||
            currentProps.disabled
          )
            return false
          inserted = true
          view.dispatch(
            view.state.tr.insertText(text, selection.from, selection.to).scrollIntoView()
          )
          view.focus()
          return true
        },
      }
    },
    insertLineBreak() {
      const view = currentView
      if (!view || !isActive(view)) return false
      const handled = insertComposerLineBreak(
        view.state,
        transaction => view.dispatch(transaction.scrollIntoView()),
        view
      )
      if (handled) keepTrailingComposerCaretVisible(view)
      return handled
    },
    setValue(value, selectionOffset = value.length) {
      const view = currentView
      if (!view || !isActive(view)) return
      recordComposerDiagnostic('value-set', {
        composerId: composerDiagnosticId,
        valueLength: value.length,
        selectionEnd: selectionOffset,
      })
      replaceComposerValue(view, value, selectionOffset, false, view.hasFocus())
    },
  }
  return {
    handle,
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    update(props: ComposerProseMirrorEditorProps) {
      const previous = currentProps
      currentProps = { ...props, services: props.services ?? browserComposerEditorServices }
      const view = currentView
      if (!view || !attached) return
      if (
        previous.textareaRef !== currentProps.textareaRef &&
        previous.textareaRef.current === view.dom
      )
        (previous.textareaRef as { current: HTMLElement | null }).current = null
      if (
        Boolean(previous.onActivateMention) !== Boolean(currentProps.onActivateMention) ||
        Boolean(previous.onOpenMentionReference) !== Boolean(currentProps.onOpenMentionReference)
      ) {
        createMentionView = makeMentionView()
        view.setProps({
          nodeViews: { ...view.props.nodeViews, composer_mention: createMentionView },
        })
      }
      if (
        ['className', 'disabled', 'placeholder', 'ariaLabel', 'rows', 'testId'].some(
          key =>
            previous[key as keyof typeof previous] !==
            currentProps[key as keyof typeof currentProps]
        )
      )
        view.setProps({
          attributes: editorAttributes(currentProps),
          editable: () => !currentProps.disabled,
        })
      if (previous.services !== currentProps.services) bindWindowFocus()
      if (previous.scrollContainerClassName !== currentProps.scrollContainerClassName) bindFade()
      if (previous.value !== props.value && props.value !== snapshot.value) {
        const selectionOffset = view.hasFocus() ? props.value.length : undefined
        recordComposerDiagnostic('external-value-apply', {
          composerId: composerDiagnosticId,
          valueLength: props.value.length,
          selectionEnd: selectionOffset ?? null,
          viewIsComposing: view.composing,
        })
        replaceComposerValue(view, props.value, selectionOffset, true)
      }
      ;(currentProps.textareaRef as { current: HTMLElement | null }).current = view.dom
    },
    attach(element: HTMLElement) {
      const resumed = suspended
      if (mount && mount !== element) dispose()
      mount = element
      stopWatchingDetachedWidget(element)
      attached = true
      suspended = false
      const ticket = ++lease
      if (!currentView) {
        destroyView = create(element)
        bindFade()
      } else {
        const view = currentView
        if (!releaseWindowFocus) bindWindowFocus()
        if (resumed) {
          bindFade()
          publish({ value: readComposerSnapshot(view.state).value, composing: view.composing })
          scheduleReady(view)
        }
      }
      ;(currentProps.textareaRef as { current: HTMLElement | null }).current =
        currentView?.dom ?? null
      return () => {
        if (lease !== ticket) return
        attached = false
        releaseWindowFocus?.()
        releaseWindowFocus = undefined
        if (currentProps.textareaRef.current === currentView?.dom)
          (currentProps.textareaRef as { current: HTMLElement | null }).current = null
        queueMicrotask(() => {
          if (attached || lease !== ticket) return
          suspended = true
          ownershipRevision++
          releaseWindowFocus?.()
          releaseWindowFocus = undefined
          releaseFade?.()
          releaseFade = undefined
          if (!element.isConnected) dispose()
          else watchDetachedWidget(element, dispose)
        })
      }
    },
  }
}
