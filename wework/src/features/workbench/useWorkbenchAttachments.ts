import { useCallback, useMemo, useState } from 'react'
import type { Attachment, MultiAttachmentUploadState } from '@/types/api'
import {
  deleteAttachment as defaultDeleteAttachment,
  isValidFileSize,
  uploadAttachment as defaultUploadAttachment,
} from '@/api/attachments'
import { readTextAttachmentMetadata, releaseAttachmentPreview } from '@/lib/attachments'
import { isWorkspaceImageFile } from '@/lib/workspace-path-transfer'
import { track } from '@/telemetry/client'

interface UseWorkbenchAttachmentsOptions {
  uploadAttachment?: (file: File, onProgress?: (progress: number) => void) => Promise<Attachment>
  deleteAttachment?: (attachmentId: number) => Promise<void>
  scopeKey?: string
}

const DEFAULT_ATTACHMENT_SCOPE_KEY = 'default'

function emptyAttachmentState(): MultiAttachmentUploadState {
  return {
    attachments: [],
    uploadingFiles: new Map(),
    errors: new Map(),
  }
}

function createImagePreview(file: File): string | undefined {
  if (
    !isWorkspaceImageFile(file) ||
    typeof URL === 'undefined' ||
    typeof URL.createObjectURL !== 'function'
  ) {
    return undefined
  }
  return URL.createObjectURL(file)
}

function releaseImagePreview(previewUrl: string | undefined): void {
  if (!previewUrl || typeof URL === 'undefined' || typeof URL.revokeObjectURL !== 'function') {
    return
  }
  URL.revokeObjectURL(previewUrl)
}

export function useWorkbenchAttachments(options: UseWorkbenchAttachmentsOptions = {}) {
  const uploadAttachment = options.uploadAttachment ?? defaultUploadAttachment
  const deleteAttachment = options.deleteAttachment ?? defaultDeleteAttachment
  const scopeKey = options.scopeKey ?? DEFAULT_ATTACHMENT_SCOPE_KEY
  const [stateByScope, setStateByScope] = useState<Record<string, MultiAttachmentUploadState>>({})
  const state = stateByScope[scopeKey] ?? emptyAttachmentState()

  const updateScopeState = useCallback(
    (
      targetScopeKey: string,
      updater: (current: MultiAttachmentUploadState) => MultiAttachmentUploadState
    ) => {
      setStateByScope(currentByScope => {
        const current = currentByScope[targetScopeKey] ?? emptyAttachmentState()
        const next = updater(current)
        if (next === current) return currentByScope
        return {
          ...currentByScope,
          [targetScopeKey]: next,
        }
      })
    },
    []
  )

  const isUploading = state.uploadingFiles.size > 0
  const isAttachmentReadyToSend = useMemo(
    () => !isUploading && state.attachments.every(attachment => attachment.status === 'ready'),
    [isUploading, state.attachments]
  )

  const addExistingAttachmentForScope = useCallback(
    (targetScopeKey: string, attachment: Attachment) => {
      updateScopeState(targetScopeKey, current => {
        if (current.attachments.some(item => item.id === attachment.id)) return current
        return {
          ...current,
          attachments: [...current.attachments, attachment],
        }
      })
    },
    [updateScopeState]
  )

  const handleFileSelectForScope = useCallback(
    async (targetScopeKey: string, files: File | File[]) => {
      const fileList = Array.isArray(files) ? files : [files]

      for (const [index, file] of fileList.entries()) {
        // file.name alone collides when the same file name is selected twice;
        // include size/lastModified and the in-batch index for a stable key.
        const fileId = `${file.name}:${file.size}:${file.lastModified}:${index}`

        if (!isValidFileSize(file.size)) {
          updateScopeState(targetScopeKey, current => {
            const errors = new Map(current.errors)
            errors.set(fileId, 'File is too large')
            return { ...current, errors }
          })
          continue
        }

        const previewUrl = createImagePreview(file)
        updateScopeState(targetScopeKey, current => {
          const uploadingFiles = new Map(current.uploadingFiles)
          uploadingFiles.set(fileId, { file, progress: 0, previewUrl })
          return { ...current, uploadingFiles }
        })

        let previewTransferred = false
        try {
          const textMetadataPromise = readTextAttachmentMetadata(file)
          const attachment = await uploadAttachment(file, progress => {
            updateScopeState(targetScopeKey, current => {
              const uploadingFiles = new Map(current.uploadingFiles)
              const existing = uploadingFiles.get(fileId)
              if (existing) {
                uploadingFiles.set(fileId, { ...existing, progress })
              }
              return { ...current, uploadingFiles }
            })
          })
          const textMetadata = await textMetadataPromise
          let enrichedAttachment = textMetadata
            ? {
                ...attachment,
                text_preview: attachment.text_preview ?? textMetadata.text_preview,
                text_content: attachment.text_content ?? textMetadata.text_content,
                text_length: attachment.text_length ?? textMetadata.text_length,
              }
            : attachment
          if (previewUrl) {
            if (enrichedAttachment.local_preview_url !== previewUrl) {
              releaseAttachmentPreview(enrichedAttachment)
            }
            enrichedAttachment = {
              ...enrichedAttachment,
              local_preview_url: previewUrl,
            }
            previewTransferred = true
          }

          updateScopeState(targetScopeKey, current => {
            const uploadingFiles = new Map(current.uploadingFiles)
            uploadingFiles.delete(fileId)
            return {
              ...current,
              attachments: [...current.attachments, enrichedAttachment],
              uploadingFiles,
            }
          })
          track('feature_action_completed', { domain: 'attachment', action: 'upload' })
        } catch (error) {
          track('operation_failed', { operation: 'attachment_action' })
          updateScopeState(targetScopeKey, current => {
            const uploadingFiles = new Map(current.uploadingFiles)
            const errors = new Map(current.errors)
            uploadingFiles.delete(fileId)
            errors.set(fileId, error instanceof Error ? error.message : 'Upload failed')
            return { ...current, uploadingFiles, errors }
          })
        } finally {
          if (!previewTransferred) {
            releaseImagePreview(previewUrl)
          }
        }
      }
    },
    [updateScopeState, uploadAttachment]
  )

  const removeAttachmentForScope = useCallback(
    async (targetScopeKey: string, attachmentId: number) => {
      const scopedState = stateByScope[targetScopeKey] ?? emptyAttachmentState()
      const attachment = scopedState.attachments.find(item => item.id === attachmentId)
      const attachmentsToRemove = attachment?.ui_group_id
        ? scopedState.attachments.filter(item => item.ui_group_id === attachment.ui_group_id)
        : attachment
          ? [attachment]
          : []
      attachmentsToRemove.forEach(releaseAttachmentPreview)
      const idsToRemove = new Set(attachmentsToRemove.map(item => item.id))
      updateScopeState(targetScopeKey, current => ({
        ...current,
        attachments: current.attachments.filter(attachment => !idsToRemove.has(attachment.id)),
      }))
      try {
        await Promise.all(
          attachmentsToRemove.filter(item => item.id > 0).map(item => deleteAttachment(item.id))
        )
        track('feature_action_completed', { domain: 'attachment', action: 'delete' })
      } catch (error) {
        track('operation_failed', { operation: 'attachment_action' })
        throw error
      }
    },
    [deleteAttachment, stateByScope, updateScopeState]
  )

  const resetAttachmentsForScope = useCallback(
    (targetScopeKey: string) => {
      const scopedState = stateByScope[targetScopeKey] ?? emptyAttachmentState()
      scopedState.attachments.forEach(releaseAttachmentPreview)
      updateScopeState(targetScopeKey, current => ({
        ...current,
        attachments: [],
        uploadingFiles: new Map(),
        errors: new Map(),
      }))
    },
    [stateByScope, updateScopeState]
  )

  const addExistingAttachment = useCallback(
    (attachment: Attachment) => addExistingAttachmentForScope(scopeKey, attachment),
    [addExistingAttachmentForScope, scopeKey]
  )
  const handleFileSelect = useCallback(
    (files: File | File[]) => handleFileSelectForScope(scopeKey, files),
    [handleFileSelectForScope, scopeKey]
  )
  const removeAttachment = useCallback(
    (attachmentId: number) => removeAttachmentForScope(scopeKey, attachmentId),
    [removeAttachmentForScope, scopeKey]
  )
  const resetAttachments = useCallback(
    () => resetAttachmentsForScope(scopeKey),
    [resetAttachmentsForScope, scopeKey]
  )

  return {
    state,
    stateByScope,
    attachments: state.attachments,
    uploadingFiles: state.uploadingFiles,
    errors: state.errors,
    isUploading,
    isAttachmentReadyToSend,
    handleFileSelect,
    handleFileSelectForScope,
    addExistingAttachment,
    addExistingAttachmentForScope,
    removeAttachment,
    removeAttachmentForScope,
    resetAttachments,
    resetAttachmentsForScope,
  }
}
