import { useCallback } from 'react'
import type { Attachment, MultiAttachmentUploadState } from '@/types/api'
import type { WorkbenchContextValue } from './workbenchContextTypes'

const empty: MultiAttachmentUploadState = {
  attachments: [],
  uploadingFiles: new Map(),
  errors: new Map(),
}

/** Bind a composer to the workbench-owned upload lifecycle. */
export function useScopedComposerAttachments(
  owner: WorkbenchContextValue['projectChat'],
  scope: string
) {
  const state = owner.attachmentStateByScope[scope] ?? empty
  const {
    captureAttachmentsForScope,
    handleFileSelectForScope,
    addExistingAttachmentForScope,
    removeAttachmentForScope,
    releaseAttachmentForScope,
    dismissAttachmentErrorForScope,
    resetAttachmentsForScope,
  } = owner
  const captureAttachments = useCallback(
    () => captureAttachmentsForScope(scope),
    [captureAttachmentsForScope, scope]
  )
  const handleFileSelect = useCallback(
    (files: File | File[]) => handleFileSelectForScope(scope, files),
    [handleFileSelectForScope, scope]
  )
  const addExistingAttachment = useCallback(
    (attachment: Attachment) => addExistingAttachmentForScope(scope, attachment),
    [addExistingAttachmentForScope, scope]
  )
  const removeAttachment = useCallback(
    (id: number) => removeAttachmentForScope(scope, id),
    [removeAttachmentForScope, scope]
  )
  const releaseAttachment = useCallback(
    (id: number) => releaseAttachmentForScope(scope, id),
    [releaseAttachmentForScope, scope]
  )
  const dismissAttachmentError = useCallback(
    (filename: string) => dismissAttachmentErrorForScope(scope, filename),
    [dismissAttachmentErrorForScope, scope]
  )
  const resetAttachments = useCallback(
    () => resetAttachmentsForScope(scope),
    [resetAttachmentsForScope, scope]
  )
  return {
    ...state,
    isAttachmentReadyToSend:
      state.uploadingFiles.size === 0 &&
      state.attachments.every(attachment => attachment.status === 'ready'),
    captureAttachments,
    handleFileSelect,
    addExistingAttachment,
    removeAttachment,
    releaseAttachment,
    dismissAttachmentError,
    resetAttachments,
  }
}
