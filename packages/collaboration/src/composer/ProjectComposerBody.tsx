import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type DragEvent,
  type ReactNode,
} from 'react'
import { Eye } from 'lucide-react'
import type { Attachment } from '@wegent/chat-core/runtime'
import { hasSelectedTextDragData } from '@wegent/chat-core/selected-text-drag'
import type { CollaborationTranslate } from '../i18n'
import type { ComposerTextInputProps } from './ComposerTextInput'
import type {
  ComposerInputHandle,
  ComposerSubmitOptions,
  ComposerFollowUpBehavior,
} from './composerInputTypes'
import { primaryComposerSubmitOptions } from './composerInputTypes'
import {
  browserComposerTransferServices,
  workspacePathReferenceText,
  type ComposerTransferServices,
} from './useComposerTransfers'
import {
  ProjectChatComposerSurface,
  PROJECT_CHAT_EDITOR_CLASS,
  PROJECT_CHAT_TOOLBAR_CLASS,
  DOCUMENT_EDITOR_CLASS,
} from './ProjectChatComposerSurface'
import { useAutoResizeTextarea } from './useAutoResizeTextarea'
import { ComposerErrorBanner } from './ComposerErrorBanner'

export interface ProjectComposerBodyProps {
  presentation?: 'chat' | 'document'
  value: string
  onChange(value: string): void
  onSubmit(value: string, options?: ComposerSubmitOptions): void
  onBlur?(): void
  onCompositionStart?(): void
  onCompositionEnd?(): void
  disabled: boolean
  submitDisabled?: boolean
  requireText?: boolean
  isModelSelectionReady: boolean
  placeholder: string
  inputTestId?: string
  nativeEmptyCaret?: boolean
  attachments: Attachment[]
  uploadingCount: number
  attachmentErrorCount: number
  codeCommentCount?: number
  disabledReason?: string
  supervisorPending?: boolean
  onConfigureSupervisor?(): void
  inputLeadingContext?: ReactNode
  onDismissInputLeadingContext?(): void
  hasToolbarLeadingContext?: boolean
  planModeActive?: boolean
  goalDraftActive?: boolean
  collapseWhenIdle?: boolean
  isStreaming?: boolean
  sendKey?: 'enter' | 'cmd_enter'
  followUpBehavior?: ComposerFollowUpBehavior
  onFileSelect(files: File | File[]): void | Promise<void>
  onRemoveAttachment(id: number): void
  transferServices?: ComposerTransferServices
  workBar?: ReactNode
  translate: CollaborationTranslate
  renderAttachments(onShowTextAttachment: (attachment: Attachment) => void): ReactNode
  renderEditor(props: ComposerTextInputProps): ReactNode
  renderToolbar(props: {
    canSend: boolean
    onSubmit(options?: ComposerSubmitOptions): void
    className: string
  }): ReactNode
}

/** The PC composer body and interaction rules, with explicit host capability adapters. */
export const ProjectComposerBody = forwardRef<ComposerInputHandle, ProjectComposerBodyProps>(
  function ProjectComposerBody(
    {
      value,
      presentation = 'chat',
      onChange,
      onSubmit,
      onBlur,
      onCompositionStart,
      onCompositionEnd,
      disabled,
      submitDisabled,
      requireText = false,
      isModelSelectionReady,
      placeholder,
      inputTestId = 'chat-message-input',
      nativeEmptyCaret = false,
      attachments,
      uploadingCount,
      attachmentErrorCount,
      codeCommentCount = 0,
      disabledReason,
      supervisorPending,
      onConfigureSupervisor,
      inputLeadingContext,
      onDismissInputLeadingContext,
      hasToolbarLeadingContext,
      planModeActive,
      goalDraftActive,
      collapseWhenIdle,
      isStreaming = false,
      sendKey = 'enter',
      followUpBehavior = 'queue',
      onFileSelect,
      onRemoveAttachment,
      transferServices = browserComposerTransferServices,
      workBar,
      translate: t,
      renderAttachments,
      renderEditor,
      renderToolbar,
    },
    ref
  ) {
    const editorRef = useRef<ComposerInputHandle>(null)
    const textareaRef = useAutoResizeTextarea(value, presentation === 'document' ? null : 112)
    const [hasText, setHasText] = useState(Boolean(value.trim()))
    const [isDraggingFiles, setDraggingFiles] = useState(false)
    const [transferError, setTransferError] = useState<string | null>(null)
    const getLiveValue = () => editorRef.current?.getValue() ?? value
    useImperativeHandle(ref, () => ({
      get element() {
        return editorRef.current?.element ?? null
      },
      focus: () => editorRef.current?.focus(),
      getValue: getLiveValue,
      insertReference: reference => editorRef.current?.insertReference(reference),
      setValue: (nextValue, cursor) => editorRef.current?.setValue(nextValue, cursor),
    }))
    useEffect(() => {
      setHasText(Boolean(value.trim()))
    }, [value])
    const handleChange = useCallback(
      (nextValue: string) => {
        setHasText(Boolean(nextValue.trim()))
        onChange(nextValue)
      },
      [onChange]
    )
    const canSend =
      (hasText || (!requireText && (attachments.length > 0 || codeCommentCount > 0))) &&
      isModelSelectionReady &&
      !disabled &&
      !submitDisabled
    const canCollapse =
      !attachments.length &&
      !uploadingCount &&
      !attachmentErrorCount &&
      !codeCommentCount &&
      !disabledReason &&
      !supervisorPending &&
      !inputLeadingContext &&
      !hasToolbarLeadingContext &&
      !planModeActive &&
      !goalDraftActive
    const submitValue = (current: string, options?: ComposerSubmitOptions) => {
      const hasContent =
        current.trim() || (!requireText && (attachments.length || codeCommentCount))
      if (hasContent && isModelSelectionReady && !disabled && !submitDisabled)
        onSubmit(current, options)
    }
    const submit = (options?: ComposerSubmitOptions) => submitValue(getLiveValue(), options)
    const hasFiles = (data: DataTransfer) =>
      Array.from(data.types).includes('Files') || transferServices.hasPathTransfer(data)
    const acceptsDrop = (data: DataTransfer) => hasFiles(data) || hasSelectedTextDragData(data)
    const handleDragOver = (event: DragEvent<HTMLFormElement>) => {
      if (!acceptsDrop(event.dataTransfer)) return
      event.preventDefault()
      event.dataTransfer.dropEffect = disabled ? 'none' : 'copy'
      setDraggingFiles(!disabled && hasFiles(event.dataTransfer))
    }
    const appendText = (text: string) => {
      const current = getLiveValue()
      const next = current ? `${current}\n${text}` : text
      if (editorRef.current) editorRef.current.setValue(next, next.length)
      else handleChange(next)
    }
    const showTextAttachment = (attachment: Attachment) => {
      if (!attachment.text_content) return
      appendText(attachment.text_content)
      onRemoveAttachment(attachment.id)
      window.requestAnimationFrame(() => editorRef.current?.focus())
    }
    return (
      <>
        <ComposerErrorBanner error={transferError} />
        <ProjectChatComposerSurface
          presentation={presentation}
          workBar={workBar}
          canCollapseInShortPane={canCollapse}
          collapseWhenIdle={collapseWhenIdle}
          isDraggingFiles={isDraggingFiles}
          formProps={{
            onDragEnter: handleDragOver,
            onDragOver: handleDragOver,
            onDragLeave: event => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null))
                setDraggingFiles(false)
            },
            onDrop: event => {
              if (!acceptsDrop(event.dataTransfer)) return
              event.preventDefault()
              setDraggingFiles(false)
              if (disabled) return
              setTransferError(null)
              if (hasSelectedTextDragData(event.dataTransfer)) {
                const text = event.dataTransfer.getData('text/plain')
                if (text) appendText(text)
                return
              }
              void transferServices
                .resolveTransfer(event.dataTransfer, 'drop')
                .then(async ({ referenceEntries, attachmentFiles }) => {
                  const references = workspacePathReferenceText(referenceEntries)
                  if (references) appendText(references)
                  if (attachmentFiles.length) await onFileSelect(attachmentFiles)
                })
                .catch(cause =>
                  setTransferError(cause instanceof Error ? cause.message : String(cause))
                )
            },
            onSubmit: event => {
              event.preventDefault()
              submit(primaryComposerSubmitOptions(isStreaming, followUpBehavior))
            },
          }}
        >
          {renderAttachments(showTextAttachment)}
          {disabledReason && (
            <div
              data-testid="composer-disabled-reason"
              className="mb-2 rounded-xl bg-muted px-3 py-2 text-xs text-text-secondary"
            >
              {disabledReason}
            </div>
          )}
          {supervisorPending && onConfigureSupervisor && (
            <button
              type="button"
              data-testid="pending-supervisor-indicator"
              disabled={disabled}
              onClick={onConfigureSupervisor}
              className="mb-1 flex h-7 w-fit items-center gap-1.5 rounded-lg bg-muted/70 px-2 text-xs text-text-secondary transition-colors hover:bg-muted hover:text-text-primary disabled:opacity-50"
            >
              <Eye className="h-3.5 w-3.5 text-text-muted" />
              <span>{t('workbench.supervisor_pending')}</span>
              <span className="text-text-muted">· {t('workbench.supervisor_pending_edit')}</span>
            </button>
          )}
          {inputLeadingContext && (
            <div
              data-testid="composer-input-leading-context"
              className="mb-1 flex w-full items-center"
            >
              {inputLeadingContext}
            </div>
          )}
          {renderEditor({
            ref: editorRef,
            textareaRef,
            value,
            onChange: handleChange,
            onSubmit: submitValue,
            onBlur,
            onCompositionStart,
            onCompositionEnd,
            canSend,
            disabled,
            placeholder,
            testId: inputTestId,
            nativeEmptyCaret,
            rows: 2,
            onPasteFiles: onFileSelect,
            className:
              presentation === 'document' ? DOCUMENT_EDITOR_CLASS : PROJECT_CHAT_EDITOR_CLASS,
            sendKey,
            followUpBehavior,
            isStreaming,
            transferServices,
            onKeyDown: (event, snapshot) => {
              if (
                !onDismissInputLeadingContext ||
                !inputLeadingContext ||
                event.key !== 'Backspace' ||
                event.metaKey ||
                event.ctrlKey ||
                event.altKey ||
                snapshot.value.length ||
                snapshot.selectionStart !== 0
              )
                return false
              onDismissInputLeadingContext()
              return true
            },
          })}
          {renderToolbar({
            canSend,
            className: presentation === 'document' ? 'pt-3' : PROJECT_CHAT_TOOLBAR_CLASS,
            onSubmit: submit,
          })}
        </ProjectChatComposerSurface>
      </>
    )
  }
)
