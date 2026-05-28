import { FileText, Loader2, X } from 'lucide-react'
import type { Attachment } from '@/types/api'
import { getRuntimeConfig } from '@/config/runtime'

interface AttachmentBadgesProps {
  attachments: Attachment[]
  uploadingFiles: Map<string, { file: File; progress: number }>
  errors: Map<string, string>
  onRemoveAttachment: (attachmentId: number) => void
}

function formatFileSize(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`
  return `${Math.round(size / (1024 * 1024))} MB`
}

function isImageAttachment(attachment: Attachment): boolean {
  return (
    attachment.mime_type.toLowerCase().startsWith('image/') ||
    ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp'].includes(
      attachment.file_extension.toLowerCase()
    )
  )
}

function getAttachmentImageUrl(attachmentId: number): string {
  const { apiBaseUrl } = getRuntimeConfig()
  return `${apiBaseUrl}/attachments/${attachmentId}/download`
}

export function AttachmentBadges({
  attachments,
  uploadingFiles,
  errors,
  onRemoveAttachment,
}: AttachmentBadgesProps) {
  if (attachments.length === 0 && uploadingFiles.size === 0 && errors.size === 0) {
    return null
  }

  return (
    <div className="mb-3 flex flex-wrap gap-2" data-testid="attachment-badge-list">
      {attachments.map(attachment =>
        isImageAttachment(attachment) ? (
          <div
            key={attachment.id}
            data-testid="attachment-badge"
            className="relative"
          >
            <img
              data-testid="attachment-image-preview"
              src={getAttachmentImageUrl(attachment.id)}
              alt={attachment.filename}
              className="h-20 w-20 rounded-xl object-cover"
            />
            <button
              type="button"
              data-testid="remove-attachment-button"
              onClick={() => onRemoveAttachment(attachment.id)}
              className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-text-primary text-white hover:opacity-80"
              aria-label="Remove attachment"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        ) : (
          <span
            key={attachment.id}
            data-testid="attachment-badge"
            className="inline-flex max-w-[220px] items-center gap-2 rounded-full border border-border bg-surface px-3 py-1.5 text-xs text-text-secondary"
          >
            <FileText className="h-4 w-4 shrink-0" />
            <span className="min-w-0 truncate">{attachment.filename}</span>
            <span className="shrink-0 text-text-muted">{formatFileSize(attachment.file_size)}</span>
            <button
              type="button"
              data-testid="remove-attachment-button"
              onClick={() => onRemoveAttachment(attachment.id)}
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full hover:bg-muted"
              aria-label="Remove attachment"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </span>
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
