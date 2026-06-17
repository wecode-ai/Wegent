import { FileText, Loader2, MessageSquare, X } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import type { Attachment } from '@/types/api'
import type { CodeCommentContext } from '@/types/workspace-files'
import { getAttachmentTypeLabel, isImageAttachment } from '@/lib/attachments'
import { AttachmentImagePreview } from '../AttachmentImagePreview'

interface AttachmentBadgesProps {
  attachments: Attachment[]
  uploadingFiles: Map<string, { file: File; progress: number }>
  errors: Map<string, string>
  codeComments?: CodeCommentContext[]
  onRemoveAttachment: (attachmentId: number) => void
  onClearCodeComments?: () => void
}

function RemoveAttachmentButton({
  attachmentId,
  onRemoveAttachment,
}: {
  attachmentId: number
  onRemoveAttachment: (attachmentId: number) => void
}) {
  return (
    <button
      type="button"
      data-testid="remove-attachment-button"
      onClick={() => onRemoveAttachment(attachmentId)}
      className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-text-primary text-white shadow-sm transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
      aria-label="Remove attachment"
    >
      <X className="h-3 w-3" />
    </button>
  )
}

function DocumentAttachmentCard({
  attachment,
  onRemoveAttachment,
}: {
  attachment: Attachment
  onRemoveAttachment: (attachmentId: number) => void
}) {
  const typeLabel = getAttachmentTypeLabel(attachment)

  return (
    <div
      data-testid="attachment-badge"
      className="relative inline-flex h-14 w-[220px] items-center gap-3 rounded-xl border border-border bg-background px-3 pr-8 text-xs text-text-secondary shadow-sm"
    >
      <span
        data-testid="attachment-document-icon"
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-red-50 text-[9px] font-semibold leading-none text-red-600"
      >
        {typeLabel}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-medium text-text-primary">{attachment.filename}</span>
        <span className="truncate text-text-secondary">{typeLabel}</span>
      </span>
      <RemoveAttachmentButton
        attachmentId={attachment.id}
        onRemoveAttachment={onRemoveAttachment}
      />
    </div>
  )
}

function CodeCommentBadge({ count, onRemove }: { count: number; onRemove?: () => void }) {
  const { t } = useTranslation('common')

  return (
    <div
      data-testid="code-comment-context-badge"
      className="relative inline-flex h-14 items-center gap-2 rounded-xl border border-border bg-background px-3 pr-8 text-sm font-medium text-text-primary shadow-sm"
    >
      <MessageSquare className="h-4 w-4 text-text-secondary" />
      <span>{t('workbench.code_comment_count', { count })}</span>
      {onRemove && (
        <button
          type="button"
          data-testid="remove-code-comment-context-button"
          onClick={onRemove}
          className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-text-primary text-white shadow-sm transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
          aria-label={t('workbench.remove_code_comments')}
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </div>
  )
}

export function AttachmentBadges({
  attachments,
  uploadingFiles,
  errors,
  codeComments = [],
  onRemoveAttachment,
  onClearCodeComments,
}: AttachmentBadgesProps) {
  const codeCommentCount = codeComments?.length ?? 0
  if (
    attachments.length === 0 &&
    uploadingFiles.size === 0 &&
    errors.size === 0 &&
    codeCommentCount === 0
  ) {
    return null
  }

  return (
    <div className="mb-3 flex flex-wrap gap-2" data-testid="attachment-badge-list">
      {codeCommentCount > 0 && (
        <CodeCommentBadge count={codeCommentCount} onRemove={onClearCodeComments} />
      )}
      {attachments.map(attachment =>
        isImageAttachment(attachment) ? (
          <div
            key={attachment.id}
            data-testid="attachment-badge"
            className="relative h-20 w-20 shrink-0"
          >
            <AttachmentImagePreview
              attachment={attachment}
              buttonTestId="attachment-image-preview-button"
              imageTestId="attachment-image-preview"
              loadingTestId="attachment-image-preview-loading"
              errorTestId="attachment-image-preview-error"
              imageClassName="h-full w-full rounded-xl object-cover"
              placeholderClassName="flex h-full w-full items-center justify-center rounded-xl border border-border bg-surface text-text-muted"
              buttonClassName="block h-full w-full cursor-zoom-in p-0 text-left"
            />
            <RemoveAttachmentButton
              attachmentId={attachment.id}
              onRemoveAttachment={onRemoveAttachment}
            />
          </div>
        ) : (
          <DocumentAttachmentCard
            key={attachment.id}
            attachment={attachment}
            onRemoveAttachment={onRemoveAttachment}
          />
        )
      )}
      {Array.from(uploadingFiles.entries()).map(([fileId, upload]) => (
        <span
          key={fileId}
          data-testid="uploading-attachment-badge"
          className="inline-flex max-w-[220px] items-center gap-2 rounded-full border border-border bg-surface px-3 py-1.5 text-xs text-text-secondary"
        >
          <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
          <span className="min-w-0 truncate">{upload.file.name}</span>
          <span className="shrink-0 text-text-muted">{upload.progress}%</span>
        </span>
      ))}
      {Array.from(errors.entries()).map(([fileId, error]) => (
        <span
          key={fileId}
          data-testid="attachment-error-badge"
          className="inline-flex max-w-[260px] items-center gap-2 rounded-full border border-red-200 bg-red-50 px-3 py-1.5 text-xs text-red-700"
        >
          <FileText className="h-4 w-4 shrink-0" />
          <span className="min-w-0 truncate">{fileId}</span>
          <span className="min-w-0 truncate">{error}</span>
        </span>
      ))}
    </div>
  )
}
