import { getRuntimeConfig } from '@/config/runtime'
import type { Attachment } from '@/types/api'

const TEXT_ATTACHMENT_PREVIEW_BYTES = 4096
const TEXT_ATTACHMENT_INLINE_BYTES = 128 * 1024
const TEXT_ATTACHMENT_PREVIEW_CHARACTERS = 180
const TEXT_ATTACHMENT_EXTENSIONS = new Set([
  '.csv',
  '.json',
  '.jsonc',
  '.log',
  '.markdown',
  '.md',
  '.txt',
  '.tsv',
  '.xml',
  '.yaml',
  '.yml',
])

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

function normalizedFileExtension(fileName: string): string {
  const dotIndex = fileName.lastIndexOf('.')
  return dotIndex >= 0 ? fileName.substring(dotIndex).toLowerCase() : ''
}

function normalizeTextPreview(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, TEXT_ATTACHMENT_PREVIEW_CHARACTERS)
}

export function isTextAttachment(
  attachment: Pick<Attachment, 'mime_type' | 'file_extension'>
): boolean {
  const mimeType = attachment.mime_type.toLowerCase()
  return (
    mimeType.startsWith('text/') ||
    mimeType.includes('json') ||
    mimeType.includes('xml') ||
    mimeType.includes('yaml') ||
    TEXT_ATTACHMENT_EXTENSIONS.has(attachment.file_extension.toLowerCase())
  )
}

export function getAttachmentTextPreview(attachment: Attachment): string | null {
  if (!isTextAttachment(attachment)) return null
  const preview = normalizeTextPreview(attachment.text_preview ?? '')
  return preview || null
}

export async function readTextAttachmentMetadata(
  file: File
): Promise<Pick<Attachment, 'text_content' | 'text_length' | 'text_preview'> | null> {
  const fileExtension = normalizedFileExtension(file.name)
  const mimeType = file.type || 'application/octet-stream'
  if (
    !mimeType.toLowerCase().startsWith('text/') &&
    !TEXT_ATTACHMENT_EXTENSIONS.has(fileExtension)
  ) {
    return null
  }

  try {
    const readInline = file.size <= TEXT_ATTACHMENT_INLINE_BYTES
    const text = await (readInline
      ? file.text()
      : file.slice(0, TEXT_ATTACHMENT_PREVIEW_BYTES).text())
    const preview = normalizeTextPreview(text)
    if (!preview) return null

    return {
      text_preview: preview,
      text_length: readInline ? text.length : null,
      text_content: readInline ? text : null,
    }
  } catch {
    return null
  }
}
