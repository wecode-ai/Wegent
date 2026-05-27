import { useCallback, useMemo, useState } from 'react'
import type { Attachment, MultiAttachmentUploadState } from '@/types/api'
import {
  deleteAttachment as defaultDeleteAttachment,
  isSupportedExtension,
  isValidFileSize,
  uploadAttachment as defaultUploadAttachment,
} from '@/api/attachments'

interface UseWorkbenchAttachmentsOptions {
  uploadAttachment?: (file: File, onProgress?: (progress: number) => void) => Promise<Attachment>
  deleteAttachment?: (attachmentId: number) => Promise<void>
}

export function useWorkbenchAttachments(options: UseWorkbenchAttachmentsOptions = {}) {
  const uploadAttachment = options.uploadAttachment ?? defaultUploadAttachment
  const deleteAttachment = options.deleteAttachment ?? defaultDeleteAttachment
  const [state, setState] = useState<MultiAttachmentUploadState>({
    attachments: [],
    uploadingFiles: new Map(),
    errors: new Map(),
  })

  const isUploading = state.uploadingFiles.size > 0
  const isAttachmentReadyToSend = useMemo(
    () => !isUploading && state.attachments.every(attachment => attachment.status === 'ready'),
    [isUploading, state.attachments]
  )

  const addExistingAttachment = useCallback((attachment: Attachment) => {
    setState(current => {
      if (current.attachments.some(item => item.id === attachment.id)) return current
      return {
        ...current,
        attachments: [...current.attachments, attachment],
      }
    })
  }, [])

  const handleFileSelect = useCallback(
    async (files: File | File[]) => {
      const fileList = Array.isArray(files) ? files : [files]

      for (const file of fileList) {
        const fileId = file.name

        if (!isSupportedExtension(file.name)) {
          setState(current => {
            const errors = new Map(current.errors)
            errors.set(fileId, 'Unsupported file type')
            return { ...current, errors }
          })
          continue
        }

        if (!isValidFileSize(file.size)) {
          setState(current => {
            const errors = new Map(current.errors)
            errors.set(fileId, 'File is too large')
            return { ...current, errors }
          })
          continue
        }

        setState(current => {
          const uploadingFiles = new Map(current.uploadingFiles)
          uploadingFiles.set(fileId, { file, progress: 0 })
          return { ...current, uploadingFiles }
        })

        try {
          const attachment = await uploadAttachment(file, progress => {
            setState(current => {
              const uploadingFiles = new Map(current.uploadingFiles)
              const existing = uploadingFiles.get(fileId)
              if (existing) {
                uploadingFiles.set(fileId, { ...existing, progress })
              }
              return { ...current, uploadingFiles }
            })
          })

          setState(current => {
            const uploadingFiles = new Map(current.uploadingFiles)
            uploadingFiles.delete(fileId)
            return {
              ...current,
              attachments: [...current.attachments, attachment],
              uploadingFiles,
            }
          })
        } catch (error) {
          setState(current => {
            const uploadingFiles = new Map(current.uploadingFiles)
            const errors = new Map(current.errors)
            uploadingFiles.delete(fileId)
            errors.set(fileId, error instanceof Error ? error.message : 'Upload failed')
            return { ...current, uploadingFiles, errors }
          })
        }
      }
    },
    [uploadAttachment]
  )

  const removeAttachment = useCallback(
    async (attachmentId: number) => {
      setState(current => ({
        ...current,
        attachments: current.attachments.filter(attachment => attachment.id !== attachmentId),
      }))
      await deleteAttachment(attachmentId)
    },
    [deleteAttachment]
  )

  const resetAttachments = useCallback(() => {
    setState(current => ({
      ...current,
      attachments: [],
      uploadingFiles: new Map(),
      errors: new Map(),
    }))
  }, [])

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
