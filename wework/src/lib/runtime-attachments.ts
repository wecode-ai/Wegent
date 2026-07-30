import type { Attachment } from '@/types/api'

function hasLocalPath(attachment: Attachment): boolean {
  return Boolean(attachment.local_path?.trim())
}

export function localRuntimeAttachments(attachments: Attachment[]): Attachment[] {
  return attachments.filter(hasLocalPath).map(attachment => {
    const runtimeAttachment = { ...attachment }
    delete runtimeAttachment.text_content
    delete runtimeAttachment.ui_group_id
    delete runtimeAttachment.ui_group_role
    delete runtimeAttachment.ui_kind
    return runtimeAttachment
  })
}

export function remoteAttachmentIds(attachments: Attachment[]): number[] {
  return attachments
    .filter(attachment => !hasLocalPath(attachment) && attachment.id > 0)
    .map(attachment => attachment.id)
}
