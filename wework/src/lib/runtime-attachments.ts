import type { Attachment } from '@/types/api'

function hasLocalPath(attachment: Attachment): boolean {
  return Boolean(attachment.local_path?.trim())
}

export function localRuntimeAttachments(attachments: Attachment[]): Attachment[] {
  return attachments.filter(hasLocalPath)
}

export function remoteAttachmentIds(attachments: Attachment[]): number[] {
  return attachments
    .filter(attachment => !hasLocalPath(attachment) && attachment.id > 0)
    .map(attachment => attachment.id)
}
