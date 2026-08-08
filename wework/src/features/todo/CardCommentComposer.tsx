import { useRef, useState } from 'react'
import { ArrowUp, FileText, Loader2, Paperclip, X } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { useWorkbenchPaneContext } from '@/features/workbench/useWorkbench'
import { useWorkbenchAttachments } from '@/features/workbench/useWorkbenchAttachments'
import type { Attachment } from '@/types/api'

export interface CardCommentSendResult {
  ok: boolean
  error?: string
}

interface CardCommentComposerProps {
  rootId: string
  projectId: string
  disabled: boolean
  placeholder: string
  aiError?: string | null
  onSend: (text: string, attachments: Attachment[]) => Promise<CardCommentSendResult>
}

export function CardCommentComposer({
  rootId,
  projectId,
  disabled,
  placeholder,
  aiError,
  onSend,
}: CardCommentComposerProps) {
  const { t } = useTranslation('common')
  const { services } = useWorkbenchPaneContext()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const attachmentSelection = useWorkbenchAttachments({
    uploadAttachment: services.attachmentApi?.uploadAttachment,
    deleteAttachment: services.attachmentApi?.deleteAttachment,
    scopeKey: `task-activity-${projectId}:card-${rootId}`,
  })
  const hasDraft = draft.trim().length > 0
  const hasAttachments = attachmentSelection.attachments.length > 0

  const handleSubmit = async () => {
    const text = draft.trim()
    if (!text || submitting || disabled) return
    if (!attachmentSelection.isAttachmentReadyToSend) {
      setError(t('workbench.task_activity_attachment_uploading'))
      return
    }
    setSubmitting(true)
    setError(null)
    const result = await onSend(text, attachmentSelection.attachments)
    setSubmitting(false)
    if (result.ok) {
      setDraft('')
      attachmentSelection.resetAttachments()
    } else {
      setError(result.error ?? t('workbench.project_chat_send_failed'))
    }
  }

  return (
    <div className="task-detail-comment-card-composer">
      {hasAttachments || attachmentSelection.uploadingFiles.size > 0 ? (
        <div
          className="mb-1.5 flex flex-wrap gap-1.5"
          data-testid={`cloud-task-activity-card-attachments-${rootId}`}
        >
          {attachmentSelection.attachments.map(attachment => (
            <span
              key={attachment.id}
              data-testid={`cloud-task-activity-card-attachment-${rootId}-${attachment.id}`}
              className="inline-flex h-6 max-w-[220px] items-center gap-1.5 rounded-md border border-border bg-background px-2 text-xs text-text-secondary"
            >
              <FileText className="h-3 w-3 flex-none text-text-muted" />
              <span className="truncate">{attachment.filename}</span>
              <button
                type="button"
                aria-label={t('workbench.task_activity_attachment_remove')}
                onClick={() => attachmentSelection.removeAttachment(attachment.id)}
                className="flex h-4 w-4 flex-none items-center justify-center rounded text-text-muted hover:bg-muted hover:text-text-primary"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
          {[...attachmentSelection.uploadingFiles.entries()].map(([name, { file, progress }]) => (
            <span
              key={name}
              data-testid={`cloud-task-activity-card-uploading-${rootId}-${name}`}
              className="inline-flex h-6 max-w-[220px] items-center gap-1.5 rounded-md border border-border bg-muted px-2 text-xs text-text-muted"
            >
              <Loader2 className="h-3 w-3 flex-none animate-spin" />
              <span className="truncate">{file.name}</span>
              <span className="flex-none">{Math.round(progress)}%</span>
            </span>
          ))}
        </div>
      ) : null}
      <div
        className="task-detail-comment-inline-composer"
        data-testid={`cloud-task-activity-inline-composer-${rootId}`}
      >
        <button
          type="button"
          data-testid={`cloud-task-activity-card-attach-${rootId}`}
          disabled={disabled || submitting}
          onClick={() => fileInputRef.current?.click()}
          aria-label={t('workbench.task_activity_attachment_attach')}
          className="flex h-6 w-6 flex-none items-center justify-center rounded-md text-text-muted transition hover:bg-muted hover:text-text-primary disabled:opacity-50"
        >
          <Paperclip className="h-3.5 w-3.5" />
        </button>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          data-testid={`cloud-task-activity-card-file-${rootId}`}
          disabled={disabled}
          onChange={event => {
            const files = event.target.files
            if (files && files.length > 0) {
              void attachmentSelection.handleFileSelect(Array.from(files))
            }
            event.target.value = ''
          }}
        />
        <input
          type="text"
          data-testid={`cloud-task-activity-card-composer-${rootId}`}
          value={draft}
          disabled={disabled}
          onChange={event => setDraft(event.target.value)}
          onPaste={event => {
            const files = event.clipboardData?.files
            if (files && files.length > 0) {
              event.preventDefault()
              void attachmentSelection.handleFileSelect(Array.from(files))
            }
          }}
          onKeyDown={event => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
              event.preventDefault()
              void handleSubmit()
            }
          }}
          placeholder={placeholder}
          aria-label={placeholder}
        />
        {hasDraft ? (
          <button
            type="button"
            data-testid={`cloud-task-activity-card-send-${rootId}`}
            disabled={disabled || submitting}
            onClick={() => void handleSubmit()}
            aria-label={t('workbench.send_message', '发送消息')}
            className="flex h-6 w-6 flex-none items-center justify-center rounded-full bg-muted text-text-secondary transition hover:bg-hover hover:text-text-primary disabled:opacity-50"
          >
            <ArrowUp className="h-3.5 w-3.5" />
          </button>
        ) : null}
      </div>
      {(error ?? aiError) ? (
        <p
          className="task-detail-comment-inline-error"
          data-testid={`cloud-task-activity-card-error-${rootId}`}
          role="alert"
        >
          {error ?? aiError}
        </p>
      ) : null}
    </div>
  )
}
