import { insertComposerReference } from './insertComposerReference'
import {
  useCallback,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  type Ref,
  type RefObject,
} from 'react'
import type { PluginReference } from '@wegent/chat-core/plugin-reference'
import {
  ComposerProseMirrorEditor,
  type ComposerEditorHandle,
  type ComposerEditorSnapshot,
} from './ComposerProseMirrorEditor'
import type { ComposerEditorServices } from './ComposerEditorServices'
import { useComposerInputEvents } from './useComposerInputEvents'
import { useComposerTransfers, type ComposerTransferServices } from './useComposerTransfers'
import { useComposerLinkEditing } from './useComposerLinkEditing'
import { LinkEditPopover } from './LinkEditPopover'
import { ComposerErrorBanner } from './ComposerErrorBanner'
import type {
  ComposerSubmitOptions,
  ComposerFollowUpBehavior,
  ComposerInputHandle,
} from './composerInputTypes'

export interface ComposerTextInputProps {
  ref?: Ref<ComposerInputHandle>
  value: string
  onChange: (value: string) => void
  onSubmit: (value: string, options?: ComposerSubmitOptions) => void
  onBlur?: () => void
  onCompositionStart?: () => void
  onCompositionEnd?: () => void
  nativeEmptyCaret?: boolean
  onPasteFiles?: (files: File[]) => void | Promise<void>
  sendKey?: 'enter' | 'cmd_enter'
  isStreaming?: boolean
  followUpBehavior?: ComposerFollowUpBehavior
  canSend: boolean
  disabled?: boolean
  placeholder: string
  testId: string
  rows: number
  textareaRef: RefObject<HTMLElement | null>
  className: string
  scrollContainerClassName?: string
  onKeyDown?: (event: KeyboardEvent, snapshot: ComposerEditorSnapshot) => boolean | void
  onOpenMentionPlugin?: (reference: PluginReference) => void
  editorServices?: ComposerEditorServices
  transferServices?: ComposerTransferServices
}

/** The native rich input without catalog/autocomplete menus, used for editing messages. */
export function ComposerTextInput({
  ref,
  value,
  onChange,
  onSubmit,
  onBlur,
  onCompositionStart,
  onCompositionEnd,
  nativeEmptyCaret,
  onPasteFiles,
  sendKey,
  isStreaming,
  followUpBehavior,
  canSend,
  disabled,
  placeholder,
  testId,
  rows,
  textareaRef,
  className,
  scrollContainerClassName,
  onKeyDown,
  onOpenMentionPlugin,
  editorServices,
  transferServices,
}: ComposerTextInputProps) {
  const editorRef = useRef<ComposerEditorHandle | null>(null)
  const valueRef = useRef(value)
  useLayoutEffect(() => {
    valueRef.current = value
  }, [value])
  useImperativeHandle(
    ref,
    () => ({
      get element() {
        return editorRef.current?.element ?? null
      },
      focus: () => editorRef.current?.focus(),
      getValue: () => editorRef.current?.getSnapshot().value ?? valueRef.current,
      insertReference: reference => {
        const editor = editorRef.current
        if (!editor) return
        const next = insertComposerReference(editor.getSnapshot(), reference)
        valueRef.current = next.value
        editor.setValue(next.value, next.cursor)
      },
      setValue: (nextValue, cursor = nextValue.length) =>
        editorRef.current?.setValue(nextValue, cursor),
    }),
    []
  )
  const commitEditorValue = useCallback(
    (nextValue: string, nextCursor: number) => {
      valueRef.current = nextValue
      if (editorRef.current) editorRef.current.setValue(nextValue, nextCursor)
      else onChange(nextValue)
    },
    [onChange]
  )
  const events = useComposerInputEvents({
    editorRef,
    valueRef,
    onSubmit,
    onBlur,
    onCompositionStart,
    onCompositionEnd,
    sendKey,
    isStreaming,
    followUpBehavior,
    canSend,
    onKeyDown,
  })
  const transfers = useComposerTransfers({
    editorRef,
    commitEditorValue,
    disabled,
    onPasteFiles,
    services: transferServices,
  })
  const links = useComposerLinkEditing(editorRef, commitEditorValue)

  return (
    <div className="relative min-w-0 flex-1 w-full">
      <ComposerErrorBanner error={transfers.transferError} />
      <ComposerProseMirrorEditor
        ref={editorRef}
        value={value}
        onChange={nextValue => {
          valueRef.current = nextValue
          onChange(nextValue)
        }}
        onSnapshotChange={events.handleEditorSnapshot}
        onKeyDown={events.handleEditorKeyDown}
        onBeforeInput={events.handleEditorBeforeInput}
        onKeyUp={events.handleKeyUp}
        onCompositionStart={events.handleCompositionStart}
        onCompositionEnd={events.handleCompositionEnd}
        onBlur={events.handleBlur}
        onPaste={transfers.handlePaste}
        onDrop={transfers.handleDrop}
        onEditComposerLink={links.editComposerLink}
        onOpenMentionPlugin={onOpenMentionPlugin}
        onClick={() => undefined}
        onFocus={() => undefined}
        disabled={disabled}
        nativeEmptyCaret={nativeEmptyCaret}
        placeholder={placeholder}
        testId={testId}
        rows={rows}
        textareaRef={textareaRef}
        className={className}
        scrollContainerClassName={scrollContainerClassName}
        services={editorServices}
      />
      {links.editingLink && (
        <LinkEditPopover
          key={`${links.editingLink.url}-${links.editingLink.label}`}
          payload={links.editingLink}
          anchor={links.editingLinkAnchor}
          onClose={links.closeComposerLink}
          onChange={links.changeComposerLink}
          onRemove={links.removeComposerLink}
        />
      )}
    </div>
  )
}
