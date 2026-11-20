import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { Attachment } from '@wegent/chat-core/runtime'
import { ComposerTextInput, type ComposerTextInputProps } from '../composer/ComposerTextInput'
import { useComposerAttachments } from '../composer/useComposerAttachments'
import type { MultiAttachmentUploadState } from '../composer/useComposerAttachments'
import { useConversationTranslation } from './ConversationTranslation'
import { Button as ControlButton } from '../markdown/Button'

export interface RequestUserInputComposerServices {
  editorServices?: ComposerTextInputProps['editorServices']
  transferServices?: ComposerTextInputProps['transferServices']
  uploadAttachment?: (file: File, onProgress?: (progress: number) => void) => Promise<Attachment>
  deleteAttachment?: (id: number) => Promise<void>
  renderAttachments?: (props: {
    state: MultiAttachmentUploadState
    remove(id: number): void
    dismissError(filename: string): void
  }) => ReactNode
}

export function RequestUserInputAnswerEditor({
  questionId,
  labelId,
  value,
  disabled,
  initialAttachments,
  services,
  onChange,
  onSubmit,
  onAttachmentsChange,
  onReadyChange,
}: {
  questionId: string
  labelId: string
  value: string
  disabled: boolean
  initialAttachments?: Attachment[]
  services?: RequestUserInputComposerServices
  onChange(value: string): void
  onSubmit(value: string): void
  onAttachmentsChange(attachments: Attachment[]): void
  onReadyChange(ready: boolean): void
}) {
  const { t, translate } = useConversationTranslation()
  const textareaRef = useRef<HTMLElement | null>(null)
  const mountedRef = useRef(false)
  const appliedAttachmentsRef = useRef(initialAttachments)
  const readyCallback = useRef(onReadyChange)
  useLayoutEffect(() => {
    readyCallback.current = onReadyChange
  }, [onReadyChange])
  const [transferReady, setTransferReady] = useState(true)
  const attachments = useComposerAttachments({
    initialAttachments,
    onAction: () => {
      queueMicrotask(() => {
        notifyAttachments()
        notifyReadiness()
      })
    },
    uploadAttachment:
      services?.uploadAttachment ??
      (async () => {
        throw new Error(t('request_user_input.files_unavailable'))
      }),
    deleteAttachment: services?.deleteAttachment ?? (async () => undefined),
  })
  const ready =
    transferReady && attachments.isAttachmentReadyToSend && attachments.errors.size === 0
  const bindEditor = useCallback(
    (node: HTMLDivElement | null) => {
      if (!node) {
        mountedRef.current = false
        queueMicrotask(() => {
          if (!mountedRef.current) readyCallback.current(true)
        })
        return
      }
      mountedRef.current = true
      textareaRef.current?.setAttribute('aria-labelledby', labelId)
    },
    [labelId]
  )
  const bindAndSync = useCallback(
    (node: HTMLDivElement | null) => {
      bindEditor(node)
      if (node && appliedAttachmentsRef.current !== initialAttachments) {
        appliedAttachmentsRef.current = initialAttachments
        attachments.source.adoptExternalAttachments(initialAttachments ?? [])
      }
    },
    [attachments.source, bindEditor, initialAttachments]
  )
  const notifyReadiness = (transferIsReady = transferReady) => {
    if (!mountedRef.current) return
    const state = attachments.source.getSnapshot()
    onReadyChange(
      transferIsReady &&
        state.uploadingFiles.size === 0 &&
        state.attachments.every(attachment => attachment.status === 'ready') &&
        state.errors.size === 0
    )
  }
  const notifyAttachments = () => {
    if (!mountedRef.current) return
    onAttachmentsChange(attachments.source.getSnapshot().attachments)
  }

  return (
    <div ref={bindAndSync} className="min-w-0 flex-1">
      {services?.renderAttachments?.({
        state: attachments.state,
        remove: id => {
          void attachments.removeAttachment(id)
          notifyAttachments()
          notifyReadiness()
        },
        dismissError: filename => {
          attachments.dismissAttachmentError(filename)
          notifyReadiness()
        },
      })}
      {!services?.renderAttachments &&
        [...attachments.errors].map(([filename, error]) => (
          <div key={filename} role="alert">
            {filename}: {error}
            <ControlButton
              variant="unstyled"
              type="button"
              data-testid={`request-user-input-dismiss-file-error-${questionId}-${filename}`}
              onClick={() => {
                attachments.dismissAttachmentError(filename)
                notifyReadiness()
              }}
              className="ml-2 rounded px-1 underline"
            >
              {translate('common.close')}
            </ControlButton>
          </div>
        ))}
      <ComposerTextInput
        value={value}
        onChange={onChange}
        onSubmit={onSubmit}
        canSend={!disabled && ready}
        disabled={disabled}
        placeholder={t('request_user_input.custom_placeholder')}
        testId={`request-user-input-custom-${questionId}`}
        rows={1}
        textareaRef={textareaRef}
        className="w-full bg-transparent text-sm leading-5 text-text-primary outline-none"
        scrollContainerClassName="max-h-48 overflow-y-auto"
        editorServices={services?.editorServices}
        transferServices={services?.transferServices}
        onPasteFiles={files => {
          onReadyChange(false)
          return attachments.handleFileSelect(files).finally(() => {
            notifyAttachments()
            notifyReadiness()
          })
        }}
        onTransferReadyChange={nextReady => {
          setTransferReady(nextReady)
          notifyReadiness(nextReady)
        }}
        dismissTransferErrorLabel={translate('common.close')}
      />
    </div>
  )
}
