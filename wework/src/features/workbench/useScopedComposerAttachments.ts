import { useMemo } from 'react'
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
  const commands = useMemo(
    () => ({
      captureAttachments: () => captureAttachmentsForScope(scope),
      handleFileSelect: (files: File | File[]) => handleFileSelectForScope(scope, files),
      addExistingAttachment: (attachment: Attachment) =>
        addExistingAttachmentForScope(scope, attachment),
      removeAttachment: (id: number) => removeAttachmentForScope(scope, id),
      releaseAttachment: (id: number) => releaseAttachmentForScope(scope, id),
      dismissAttachmentError: (filename: string) => dismissAttachmentErrorForScope(scope, filename),
      resetAttachments: () => resetAttachmentsForScope(scope),
    }),
    [
      scope,
      captureAttachmentsForScope,
      handleFileSelectForScope,
      addExistingAttachmentForScope,
      removeAttachmentForScope,
      releaseAttachmentForScope,
      dismissAttachmentErrorForScope,
      resetAttachmentsForScope,
    ]
  )
  return useMemo(
    () => ({
      ...state,
      ...commands,
      getAttachment: (id: number) => state.attachments.find(attachment => attachment.id === id),
      isAttachmentReadyToSend:
        state.uploadingFiles.size === 0 &&
        state.attachments.every(attachment => attachment.status === 'ready'),
    }),
    [state, commands]
  )
}
