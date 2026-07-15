import { useCallback, useMemo, useState } from 'react'
import type { Attachment, MultiAttachmentUploadState } from '@/types/api'
import {
  deleteAttachment as defaultDeleteAttachment,
  isValidFileSize,
  uploadAttachment as defaultUploadAttachment,
} from '@/api/attachments'
import { readTextAttachmentMetadata, releaseAttachmentPreview } from '@/lib/attachments'

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

export function useWorkbenchAttachments(options: UseWorkbenchAttachmentsOptions = {}) {
  const uploadAttachment = options.uploadAttachment ?? defaultUploadAttachment
  const deleteAttachment = options.deleteAttachment ?? defaultDeleteAttachment
  const scopeKey = options.scopeKey ?? DEFAULT_ATTACHMENT_SCOPE_KEY
  const [stateByScope, setStateByScope] = useState<Record<string, MultiAttachmentUploadState>>({})
  const state = stateByScope[scopeKey] ?? emptyAttachmentState()

  const updateScopeState = useCallback(
    (updater: (current: MultiAttachmentUploadState) => MultiAttachmentUploadState) => {
      setStateByScope(currentByScope => {
        const current = currentByScope[scopeKey] ?? emptyAttachmentState()
        const next = updater(current)
        if (next === current) return currentByScope
        return {
          ...currentByScope,
          [scopeKey]: next,
        }
      })
    },
    [scopeKey]
  )

  const isUploading = state.uploadingFiles.size > 0
  const isAttachmentReadyToSend = useMemo(
    () => !isUploading && state.attachments.every(attachment => attachment.status === 'ready'),
    [isUploading, state.attachments]
  )

  const addExistingAttachment = useCallback(
    (attachment: Attachment) => {
      updateScopeState(current => {
        if (current.attachments.some(item => item.id === attachment.id)) return current
        return {
          ...current,
          attachments: [...current.attachments, attachment],
        }
      })
    },
    [updateScopeState]
  )

  const handleFileSelect = useCallback(
    async (files: File | File[]) => {
      const fileList = Array.isArray(files) ? files : [files]

      for (const file of fileList) {
        const fileId = file.name

        if (!isValidFileSize(file.size)) {
          updateScopeState(current => {
            const errors = new Map(current.errors)
            errors.set(fileId, 'File is too large')
            return { ...current, errors }
          })
          continue
        }

        updateScopeState(current => {
          const uploadingFiles = new Map(current.uploadingFiles)
          uploadingFiles.set(fileId, { file, progress: 0 })
          return { ...current, uploadingFiles }
        })

        try {
          const textMetadataPromise = readTextAttachmentMetadata(file)
          const attachment = await uploadAttachment(file, progress => {
            updateScopeState(current => {
              const uploadingFiles = new Map(current.uploadingFiles)
              const existing = uploadingFiles.get(fileId)
              if (existing) {
                uploadingFiles.set(fileId, { ...existing, progress })
              }
              return { ...current, uploadingFiles }
            })
          })
          const textMetadata = await textMetadataPromise
          const enrichedAttachment = textMetadata
            ? {
                ...attachment,
                text_preview: attachment.text_preview ?? textMetadata.text_preview,
                text_content: attachment.text_content ?? textMetadata.text_content,
                text_length: attachment.text_length ?? textMetadata.text_length,
              }
            : attachment

          updateScopeState(current => {
            const uploadingFiles = new Map(current.uploadingFiles)
            uploadingFiles.delete(fileId)
            return {
              ...current,
              attachments: [...current.attachments, enrichedAttachment],
              uploadingFiles,
            }
          })
        } catch (error) {
          updateScopeState(current => {
            const uploadingFiles = new Map(current.uploadingFiles)
            const errors = new Map(current.errors)
            uploadingFiles.delete(fileId)
            errors.set(fileId, error instanceof Error ? error.message : 'Upload failed')
            return { ...current, uploadingFiles, errors }
          })
        }
      }
    },
    [updateScopeState, uploadAttachment]
  )

  const removeAttachment = useCallback(
    async (attachmentId: number) => {
      const attachment = state.attachments.find(item => item.id === attachmentId)
      const attachmentsToRemove = attachment?.ui_group_id
        ? state.attachments.filter(item => item.ui_group_id === attachment.ui_group_id)
        : attachment
          ? [attachment]
          : []
      attachmentsToRemove.forEach(releaseAttachmentPreview)
      const idsToRemove = new Set(attachmentsToRemove.map(item => item.id))
      updateScopeState(current => ({
        ...current,
        attachments: current.attachments.filter(attachment => !idsToRemove.has(attachment.id)),
      }))
      await Promise.all(
        attachmentsToRemove.filter(item => item.id > 0).map(item => deleteAttachment(item.id))
      )
    },
    [deleteAttachment, state.attachments, updateScopeState]
  )

  const resetAttachments = useCallback(() => {
    state.attachments.forEach(releaseAttachmentPreview)
    updateScopeState(current => ({
      ...current,
      attachments: [],
      uploadingFiles: new Map(),
      errors: new Map(),
    }))
  }, [state.attachments, updateScopeState])

  return {
    state,
    attachments: state.attachments,
    uploadingFiles: state.uploadingFiles,
    errors: state.errors,
    isUploading,
    isAttachmentReadyToSend,
    handleFileSelect,
    addExistingAttachment,
    removeAttachment,
    resetAttachments,
  }
}
