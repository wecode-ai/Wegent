import type { Attachment } from '@wegent/chat-core/runtime'
import i18n from '@/i18n'

function remoteRuntimeAttachment(attachment: Attachment): Attachment {
  const sanitized = { ...attachment }
  delete sanitized.local_path
  delete sanitized.local_preview_url
  return sanitized
}

export async function prepareCloudAttachments(
  attachments: Attachment[],
  uploadLocalAttachmentToCloud?: (attachment: Attachment) => Promise<Attachment>,
  attachmentIds: number[] = []
): Promise<{ attachmentIds: number[]; attachments: Attachment[] }> {
  const existingRemoteIds = attachments
    .filter(attachment => attachment.id > 0)
    .map(attachment => attachment.id)
  const localAttachments = attachments.filter(attachment => attachment.id <= 0)
  if (localAttachments.some(attachment => !attachment.local_path?.trim())) {
    throw new Error(i18n.t('workbench.cloud_attachment_local_file_unavailable'))
  }
  if (localAttachments.length > 0 && !uploadLocalAttachmentToCloud) {
    throw new Error(i18n.t('workbench.cloud_attachment_upload_unavailable'))
  }

  const uploadedAttachments = await Promise.all(
    localAttachments.map(attachment => uploadLocalAttachmentToCloud!(attachment))
  )
  if (uploadedAttachments.some(attachment => attachment.id <= 0)) {
    throw new Error(i18n.t('workbench.cloud_attachment_upload_failed'))
  }

  return {
    attachmentIds: Array.from(
      new Set([
        ...attachmentIds,
        ...existingRemoteIds,
        ...uploadedAttachments.map(attachment => attachment.id),
      ])
    ),
    attachments: [
      ...attachments.filter(attachment => attachment.id > 0),
      ...uploadedAttachments,
    ].map(remoteRuntimeAttachment),
  }
}
