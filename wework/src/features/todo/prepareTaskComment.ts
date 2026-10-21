import { issueCommentBody } from '@wegent/collaboration'
import type { Attachment } from '@/types/api'
import type { CloudLoopItemAttachment } from '@/api/deliveries'
import { prepareCloudAttachments } from '@/lib/cloud-attachments'

interface TaskCommentPreparation {
  local: boolean
  importAttachments?: (attachments: Attachment[]) => Promise<CloudLoopItemAttachment[]>
  uploadLocalAttachmentToCloud?: (attachment: Attachment) => Promise<Attachment>
  persistFailedText: string
}

export function createTaskCommentPreparer({
  local,
  importAttachments,
  uploadLocalAttachmentToCloud,
  persistFailedText,
}: TaskCommentPreparation) {
  const uploads = new Map<number, Promise<Attachment>>()
  const upload = uploadLocalAttachmentToCloud
    ? (attachment: Attachment): Promise<Attachment> => {
        const cached = uploads.get(attachment.id)
        if (cached) return cached
        const pending = uploadLocalAttachmentToCloud(attachment).then(
          uploaded => {
            if (uploaded.id <= 0) uploads.delete(attachment.id)
            return uploaded
          },
          cause => {
            uploads.delete(attachment.id)
            throw cause
          }
        )
        uploads.set(attachment.id, pending)
        return pending
      }
    : undefined

  return async (
    text: string,
    attachments: Attachment[]
  ): Promise<{ text: string; attachments: Attachment[] }> => {
    if (local || !attachments.length) return { text, attachments }
    if (!importAttachments) throw new Error(persistFailedText)

    const cloud = await prepareCloudAttachments(attachments, upload)
    // Re-import on retry so deleted Issue attachments receive fresh references.
    const imported = await importAttachments(cloud.attachments)
    return {
      text: issueCommentBody(text, imported),
      attachments: cloud.attachments,
    }
  }
}
