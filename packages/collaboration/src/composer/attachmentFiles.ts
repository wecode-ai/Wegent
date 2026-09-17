import type { Attachment } from '@wegent/chat-core/runtime'
export {
  MAX_FILE_SIZE,
  isValidFileSize,
  isWorkspaceImageFile,
} from '@wegent/chat-core/attachment-response'
function isObjectUrl(value: string | undefined): value is string {
  return value?.startsWith('blob:') ?? false
}

export function releaseAttachmentPreview(attachment: Attachment): void {
  if (
    !isObjectUrl(attachment.local_preview_url) ||
    typeof URL === 'undefined' ||
    typeof URL.revokeObjectURL !== 'function'
  ) {
    return
  }
  URL.revokeObjectURL(attachment.local_preview_url)
}

export function persistAttachmentReferences(attachments: Attachment[]): Attachment[] {
  return attachments.map(attachment => {
    if (!isObjectUrl(attachment.local_preview_url)) return attachment

    return {
      ...attachment,
      local_preview_url: attachment.local_path,
    }
  })
}
