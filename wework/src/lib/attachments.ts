import { getRuntimeConfig } from '@/config/runtime'
import type { Attachment } from '@/types/api'

export function isImageAttachment(attachment: Attachment): boolean {
  return (
    attachment.mime_type.toLowerCase().startsWith('image/') ||
    ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp'].includes(
      attachment.file_extension.toLowerCase()
    )
  )
}

export function getAttachmentImageUrl(attachmentId: number): string {
  const { apiBaseUrl } = getRuntimeConfig()
  return `${apiBaseUrl}/attachments/${attachmentId}/download`
}

export function getAttachmentTypeLabel(attachment: Attachment): string {
  const extension = attachment.file_extension.replace('.', '').trim()
  if (extension) return extension.toUpperCase()

  const subtype = attachment.mime_type.split('/')[1]?.split(/[+;]/)[0]
  return subtype ? subtype.toUpperCase() : 'FILE'
}
