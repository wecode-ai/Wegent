import { useCallback, useMemo, useRef, useState } from 'react'
import type { Attachment } from '@wegent/chat-core/runtime'
export interface MultiAttachmentUploadState {
  attachments: Attachment[]
  uploadingFiles: Map<string, { file: File; progress: number; previewUrl?: string }>
  errors: Map<string, string>
}
import { releaseAttachmentPreview, isWorkspaceImageFile } from './attachmentFiles'
import { readTextAttachmentMetadata } from '../issue-detail/attachmentPresentation'
import { isPastedTextFile } from './pastedTextAttachment'

export interface ComposerAttachmentsOptions {
  onAction?: (action: 'upload' | 'delete' | 'failed') => void
  uploadAttachment: (file: File, onProgress?: (progress: number) => void) => Promise<Attachment>
  deleteAttachment: (attachmentId: number) => Promise<void>
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

export function useComposerAttachments(options: ComposerAttachmentsOptions) {
  const uploadAttachment = options.uploadAttachment
  const deleteAttachment = options.deleteAttachment
  const scopeKey = options.scopeKey ?? DEFAULT_ATTACHMENT_SCOPE_KEY
  const [stateByScope, setStateByScope] = useState<Record<string, MultiAttachmentUploadState>>({})
  const uploadSequence = useRef(0)
  const latestAttemptsByScope = useRef(new Map<string, Map<string, string>>())
  const storedState = stateByScope[scopeKey]
  const state = useMemo(() => storedState ?? emptyAttachmentState(), [scopeKey, storedState])

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

      for (const file of fileList) {
        const fileId = `${file.name}:${++uploadSequence.current}`
        const latestAttempts =
          latestAttemptsByScope.current.get(targetScopeKey) ?? new Map<string, string>()
        latestAttempts.set(file.name, fileId)
        latestAttemptsByScope.current.set(targetScopeKey, latestAttempts)

        const previewUrl = createImagePreview(file)
        updateScopeState(targetScopeKey, current => {
          const uploadingFiles = new Map(current.uploadingFiles)
          const errors = new Map(current.errors)
          errors.delete(file.name)
          uploadingFiles.set(fileId, { file, progress: 0, previewUrl })
          return { ...current, uploadingFiles, errors }
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
          if (isPastedTextFile(file))
            enrichedAttachment = {
              ...enrichedAttachment,
              ui_kind: 'pasted-text',
            }
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
          options.onAction?.('upload')
        } catch (error) {
          options.onAction?.('failed')
          const isLatestAttempt =
            latestAttemptsByScope.current.get(targetScopeKey)?.get(file.name) === fileId
          updateScopeState(targetScopeKey, current => {
            const uploadingFiles = new Map(current.uploadingFiles)
            const errors = new Map(current.errors)
            uploadingFiles.delete(fileId)
            if (isLatestAttempt) {
              errors.set(file.name, error instanceof Error ? error.message : 'Upload failed')
            }
            return { ...current, uploadingFiles, errors }
          })
        } finally {
          const latestAttempts = latestAttemptsByScope.current.get(targetScopeKey)
          if (latestAttempts?.get(file.name) === fileId) {
            latestAttempts.delete(file.name)
            if (latestAttempts.size === 0) latestAttemptsByScope.current.delete(targetScopeKey)
          }
          if (!previewTransferred) {
            releaseImagePreview(previewUrl)
          }
        }
      }
    },
    [updateScopeState, uploadAttachment, options.onAction]
  )

  const dismissAttachmentErrorForScope = useCallback(
    (targetScopeKey: string, filename: string) => {
      updateScopeState(targetScopeKey, current => {
        if (!current.errors.has(filename)) return current
        const errors = new Map(current.errors)
        errors.delete(filename)
        return { ...current, errors }
      })
    },
    [updateScopeState]
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
        options.onAction?.('delete')
      } catch (error) {
        options.onAction?.('failed')
        throw error
      }
    },
    [deleteAttachment, stateByScope, updateScopeState, options.onAction]
  )

  const resetAttachmentsForScope = useCallback(
    (targetScopeKey: string) => {
      latestAttemptsByScope.current.delete(targetScopeKey)
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
  const dismissAttachmentError = useCallback(
    (filename: string) => dismissAttachmentErrorForScope(scopeKey, filename),
    [dismissAttachmentErrorForScope, scopeKey]
  )

  return {
    state,
    stateByScope,
    attachments: state.attachments,
    uploadingFiles: state.uploadingFiles,
    errors: state.errors,
    dismissAttachmentError,
    dismissAttachmentErrorForScope,
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
