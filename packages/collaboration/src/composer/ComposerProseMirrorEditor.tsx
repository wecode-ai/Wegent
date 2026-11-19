import {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useState,
  useSyncExternalStore,
  type RefObject,
} from 'react'
import type { PluginReference } from '@wegent/chat-core/plugin-reference'
import type { ComposerEditorServices } from './ComposerEditorServices'
import type { ComposerPrediction } from './ComposerPredictionContext'
import type { ComposerLinkPayload } from './composerLinks'
import { createComposerEditorWidget } from './composerEditorWidget'
export interface ComposerEditorSnapshot {
  value: string
  selectionOffset: number
  selectionStart: number
  selectionEnd: number
}

export interface ComposerEditorHandle {
  captureInsertion: () => { insertText(text: string): boolean }
  element: HTMLElement | null
  focus: () => void
  getSnapshot: () => ComposerEditorSnapshot
  insertLineBreak: () => boolean
  setValue: (value: string, selectionOffset?: number) => void
}

export interface ComposerProseMirrorEditorProps {
  services?: ComposerEditorServices
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
  onActivateMention?: (reference: string) => boolean
  onOpenMentionReference?: (href: string, label: string) => void
  onEditComposerLink?: (
    payload: ComposerLinkPayload,
    anchor?: HTMLElement,
    range?: { start: number; end: number }
  ) => void
  onClick: () => void
  onFocus: () => void
  onReady?: () => void
  disabled?: boolean
  placeholder: string
  ariaLabel?: string
  prediction?: ComposerPrediction | null
  testId: string
  rows: number
  textareaRef: RefObject<HTMLElement | null>
  className: string
  scrollContainerClassName?: string
  nativeEmptyCaret?: boolean
}

export const ComposerProseMirrorEditor = forwardRef<
  ComposerEditorHandle,
  ComposerProseMirrorEditorProps
>(function ComposerProseMirrorEditor(props, forwardedRef) {
  const [widget] = useState(() => createComposerEditorWidget(props))
  const presentation = useSyncExternalStore(
    widget.subscribe,
    widget.getSnapshot,
    widget.getSnapshot
  )
  const attach = useCallback(
    (element: HTMLDivElement | null) => (element ? widget.attach(element, props) : undefined),
    [widget, props]
  )
  useImperativeHandle(forwardedRef, () => widget.handle, [widget])
  return (
    <div
      className={`grid w-full min-w-0 flex-1 grid-cols-1 ${props.scrollContainerClassName ?? ''}`}
      data-composer-scroll-container={props.scrollContainerClassName ? '' : undefined}
    >
      <div ref={attach} className="col-start-1 row-start-1 grid min-w-0 grid-cols-1" />
      {presentation.value === '' && !presentation.composing && (
        <div
          className={`${props.className} composer-prosemirror-placeholder pointer-events-none col-start-1 row-start-1 whitespace-pre-wrap break-words !text-text-muted/55`}
          data-testid={
            props.prediction && !props.disabled ? `${props.testId}-prediction` : undefined
          }
          aria-hidden={props.prediction ? true : undefined}
        >
          {!props.disabled && props.prediction ? props.prediction.text : props.placeholder}
        </div>
      )}
    </div>
  )
})
