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

interface AttachmentSource {
  file?: File
  filename: string
  cancelled: boolean
  attachment?: Attachment
  cleanup?: Promise<void>
}

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
  const scopeEpochs = useRef(new Map<string, number>())
  const latestAttemptsByScope = useRef(new Map<string, Map<string, string>>())
  const sourcesByScope = useRef(new Map<string, Map<string, AttachmentSource>>())
  const attachmentSourcesByScope = useRef(new Map<string, Map<number, AttachmentSource>>())
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
    (targetScopeKey: string, attachment: Attachment, file?: File) => {
      if (file) {
        const id = `${file.name}:${++uploadSequence.current}`
        const source: AttachmentSource = { file, filename: file.name, cancelled: false, attachment }
        const sources = sourcesByScope.current.get(targetScopeKey) ?? new Map()
        sources.set(id, source)
        sourcesByScope.current.set(targetScopeKey, sources)
        const attachments = attachmentSourcesByScope.current.get(targetScopeKey) ?? new Map()
        attachments.set(attachment.id, source)
        attachmentSourcesByScope.current.set(targetScopeKey, attachments)
      }
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

  const discardSourceAttachment = useCallback(
    (source: AttachmentSource) => {
      const attachment = source.attachment
      if (!attachment) return Promise.resolve()
      if (!source.cleanup) {
        releaseAttachmentPreview(attachment)
        source.cleanup = (
          attachment.id > 0 ? deleteAttachment(attachment.id) : Promise.resolve()
        ).finally(() => {
          source.attachment = undefined
        })
      }
      return source.cleanup
    },
    [deleteAttachment]
  )

  const handleFileSelectForScope = useCallback(
    async (targetScopeKey: string, files: File | File[], trackSource = false) => {
      const epoch = scopeEpochs.current.get(targetScopeKey) ?? 0
      const fileList = Array.isArray(files) ? files : [files]
      const selections = fileList.map(file => {
        if (!trackSource) return { file, fileId: undefined, source: undefined }
        const fileId = `${file.name}:${++uploadSequence.current}`
        const source: AttachmentSource = { file, filename: file.name, cancelled: false }
        const sources = sourcesByScope.current.get(targetScopeKey) ?? new Map()
        sources.set(fileId, source)
        sourcesByScope.current.set(targetScopeKey, sources)
        return { file, fileId, source }
      })
      if (trackSource) {
        updateScopeState(targetScopeKey, current => {
          const uploadingFiles = new Map(current.uploadingFiles)
          for (const { file, fileId } of selections) {
            if (fileId) uploadingFiles.set(fileId, { file, progress: 0 })
          }
          return { ...current, uploadingFiles }
        })
      }
      for (const { file, fileId: queuedFileId, source } of selections) {
        if (source?.cancelled || (scopeEpochs.current.get(targetScopeKey) ?? 0) !== epoch) continue
        const fileId = queuedFileId ?? `${file.name}:${++uploadSequence.current}`
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
        let retainFailedAttempt = false
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
          if (source) {
            source.attachment = attachment
            const sources = attachmentSourcesByScope.current.get(targetScopeKey) ?? new Map()
            sources.set(attachment.id, source)
            attachmentSourcesByScope.current.set(targetScopeKey, sources)
          }
          const textMetadata = await textMetadataPromise
          if (!source && (scopeEpochs.current.get(targetScopeKey) ?? 0) !== epoch) {
            releaseAttachmentPreview(attachment)
            if (attachment.id > 0) await deleteAttachment(attachment.id)
            continue
          }
          if (source?.cancelled) {
            await discardSourceAttachment(source)
            continue
          }
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
          if (source) source.attachment = enrichedAttachment

          updateScopeState(targetScopeKey, current => {
            const uploadingFiles = new Map(current.uploadingFiles)
            uploadingFiles.delete(fileId)
            return {
              ...current,
              attachments: source?.cancelled
                ? current.attachments
                : [...current.attachments, enrichedAttachment],
              uploadingFiles,
            }
          })
          options.onAction?.('upload')
        } catch (error) {
          options.onAction?.('failed')
          const isLatestAttempt =
            latestAttemptsByScope.current.get(targetScopeKey)?.get(file.name) === fileId
          retainFailedAttempt = Boolean(source && !source.cancelled && isLatestAttempt)
          updateScopeState(targetScopeKey, current => {
            const uploadingFiles = new Map(current.uploadingFiles)
            const errors = new Map(current.errors)
            uploadingFiles.delete(fileId)
            if (isLatestAttempt && !source?.cancelled) {
              errors.set(file.name, error instanceof Error ? error.message : 'Upload failed')
            }
            return { ...current, uploadingFiles, errors }
          })
        } finally {
          const latestAttempts = latestAttemptsByScope.current.get(targetScopeKey)
          if (!retainFailedAttempt && latestAttempts?.get(file.name) === fileId) {
            latestAttempts.delete(file.name)
            if (latestAttempts.size === 0) latestAttemptsByScope.current.delete(targetScopeKey)
          }
          if (!previewTransferred) {
            releaseImagePreview(previewUrl)
          }
        }
      }
    },
    [
      updateScopeState,
      uploadAttachment,
      deleteAttachment,
      options.onAction,
      discardSourceAttachment,
    ]
  )

  const removeSourceFileForScope = useCallback(
    async (targetScopeKey: string, file: File) => {
      const sources = sourcesByScope.current.get(targetScopeKey)
      const removed = [...(sources?.entries() ?? [])].filter(([, source]) => source.file === file)
      if (!removed.length) return
      const uploads = new Set(removed.map(([id]) => id))
      const attachments = new Set<number>()
      const errorNames = new Set<string>()
      const attempts = latestAttemptsByScope.current.get(targetScopeKey)
      for (const [id, source] of removed) {
        source.cancelled = true
        source.file = undefined
        if (source.attachment) attachments.add(source.attachment.id)
        if (attempts?.get(source.filename) === id) {
          errorNames.add(source.filename)
          attempts.delete(source.filename)
        }
      }
      updateScopeState(targetScopeKey, current => ({
        ...current,
        attachments: current.attachments.filter(item => !attachments.has(item.id)),
        uploadingFiles: new Map([...current.uploadingFiles].filter(([id]) => !uploads.has(id))),
        errors: new Map([...current.errors].filter(([filename]) => !errorNames.has(filename))),
      }))
      try {
        await Promise.all(removed.map(([, source]) => discardSourceAttachment(source)))
        options.onAction?.('delete')
      } catch (cause) {
        options.onAction?.('failed')
        throw cause
      }
    },
    [discardSourceAttachment, updateScopeState, options.onAction]
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
      scopeEpochs.current.set(targetScopeKey, (scopeEpochs.current.get(targetScopeKey) ?? 0) + 1)
      latestAttemptsByScope.current.delete(targetScopeKey)
      for (const source of sourcesByScope.current.get(targetScopeKey)?.values() ?? []) {
        source.cancelled = true
        source.file = undefined
      }
      sourcesByScope.current.delete(targetScopeKey)
      attachmentSourcesByScope.current.delete(targetScopeKey)
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
  const addExistingSourceAttachment = useCallback(
    (attachment: Attachment, file: File) =>
      addExistingAttachmentForScope(scopeKey, attachment, file),
    [addExistingAttachmentForScope, scopeKey]
  )
  const handleFileSelect = useCallback(
    (files: File | File[]) => handleFileSelectForScope(scopeKey, files),
    [handleFileSelectForScope, scopeKey]
  )
  const handleTrackedFileSelect = useCallback(
    (files: File | File[]) => handleFileSelectForScope(scopeKey, files, true),
    [handleFileSelectForScope, scopeKey]
  )
  const removeSourceFile = useCallback(
    (file: File) => removeSourceFileForScope(scopeKey, file),
    [removeSourceFileForScope, scopeKey]
  )
  const getSelectedAttachments = useCallback(
    (files: readonly File[]) => {
      const selected = new Set(files)
      const sources = attachmentSourcesByScope.current.get(scopeKey)
      return state.attachments.filter(attachment => {
        const source = sources?.get(attachment.id)
        return (
          !source || (!source.cancelled && source.file !== undefined && selected.has(source.file))
        )
      })
    },
    [scopeKey, state.attachments]
  )
  const getSourceFile = useCallback(
    (attachmentId: number) =>
      attachmentSourcesByScope.current.get(scopeKey)?.get(attachmentId)?.file,
    [scopeKey]
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
    handleTrackedFileSelect,
    removeSourceFile,
    getSelectedAttachments,
    getSourceFile,
    handleFileSelectForScope,
    addExistingAttachment,
    addExistingSourceAttachment,
    addExistingAttachmentForScope,
    removeAttachment,
    removeAttachmentForScope,
    resetAttachments,
    resetAttachmentsForScope,
  }
}
