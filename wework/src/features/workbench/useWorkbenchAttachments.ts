import {
  useComposerAttachments,
  type ComposerAttachmentsOptions,
} from '@wegent/collaboration/composer'
import { uploadAttachment, deleteAttachment } from '@/api/attachments'
import { track } from '@/telemetry/client'
const onAction = (action: 'upload' | 'delete' | 'failed') => {
  if (action === 'failed') track('operation_failed', { operation: 'attachment_action' })
  else track('feature_action_completed', { domain: 'attachment', action })
}
export function useWorkbenchAttachments(
  options: Partial<Omit<ComposerAttachmentsOptions, 'onAction'>> = {}
) {
  return useComposerAttachments({
    ...options,
    uploadAttachment: options.uploadAttachment ?? uploadAttachment,
    deleteAttachment: options.deleteAttachment ?? deleteAttachment,
    onAction,
  })
}
