// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Hook for managing batch file attachment state and upload.
 */

import { useState, useCallback } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import {
  uploadAttachment,
  deleteAttachment,
  isSupportedExtension,
  isValidFileSize,
  getErrorMessageFromCode,
} from '@/apis/attachments'
import type { Attachment } from '@/types/api'

/** Maximum number of files allowed in a single batch upload */
export const MAX_BATCH_FILES = 20

/** Status of a single file in the upload queue */
export type FileUploadStatus = 'pending' | 'uploading' | 'success' | 'error'

/** Single file upload state */
export interface FileUploadItem {
  /** Unique ID for tracking */
  id: string
  /** Original file object */
  file: File
  /** Upload status */
  status: FileUploadStatus
  /** Upload progress (0-100) */
  progress: number
  /** Error message if failed */
  error: string | null
  /** Attachment data if uploaded successfully */
  attachment: Attachment | null
}

/** Batch upload state */
export interface BatchUploadState {
  /** Files in the upload queue */
  files: FileUploadItem[]
  /** Whether any upload is in progress */
  isUploading: boolean
  /** Summary after all uploads complete */
  summary: {
    total: number
    success: number
    failed: number
  } | null
}

interface UseBatchAttachmentReturn {
  /** Current batch upload state */
  state: BatchUploadState
  /** Add files to the upload queue */
  addFiles: (files: File[]) => { added: number; rejected: number; reason?: string }
  /** Remove a file from the queue by ID */
  removeFile: (id: string) => void
  /** Clear all files from the queue */
  clearFiles: () => void
  /** Start uploading all pending files */
  startUpload: () => Promise<void>
  /** Retry uploading a failed file */
  retryFile: (id: string) => Promise<void>
  /** Rename a file by ID (only for successfully uploaded files) */
  renameFile: (id: string, newName: string) => void
  /** Reset the entire state */
  reset: () => void
  /** Get successfully uploaded attachments */
  getSuccessfulAttachments: () => { attachment: Attachment; file: File }[]
}

/** Generate unique ID for file tracking */
function generateFileId(): string {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`
}

export function useBatchAttachment(): UseBatchAttachmentReturn {
  const { t } = useTranslation()
  const [state, setState] = useState<BatchUploadState>({
    files: [],
    isUploading: false,
    summary: null,
  })

  const addFiles = useCallback(
    (files: File[]): { added: number; rejected: number; reason?: string } => {
      const currentCount = state.files.length
      const availableSlots = MAX_BATCH_FILES - currentCount

      if (availableSlots <= 0) {
        return {
          added: 0,
          rejected: files.length,
          reason: t('common:attachment.errors.batch_limit_exceeded', { max: MAX_BATCH_FILES }),
        }
      }

      const filesToAdd = files.slice(0, availableSlots)
      const rejectedCount = files.length - filesToAdd.length

      const newItems: FileUploadItem[] = []
      const validationErrors: string[] = []

      for (const file of filesToAdd) {
        // Validate file type
        if (!isSupportedExtension(file.name)) {
          validationErrors.push(`${file.name}: ${t('common:attachment.errors.unsupported_type')}`)
          continue
        }

        // Validate file size
        if (!isValidFileSize(file.size)) {
          validationErrors.push(`${file.name}: ${t('common:attachment.errors.file_too_large')}`)
          continue
        }

        newItems.push({
          id: generateFileId(),
          file,
          status: 'pending',
          progress: 0,
          error: null,
          attachment: null,
        })
      }

      setState(prev => ({
        ...prev,
        files: [...prev.files, ...newItems],
        summary: null,
      }))

      const totalRejected = rejectedCount + (filesToAdd.length - newItems.length)
      return {
        added: newItems.length,
        rejected: totalRejected,
        reason:
          totalRejected > 0
            ? rejectedCount > 0
              ? t('common:attachment.errors.batch_limit_exceeded', { max: MAX_BATCH_FILES })
              : validationErrors[0]
            : undefined,
      }
    },
    [state.files.length, t]
  )

  const removeFile = useCallback((id: string) => {
    setState(prev => ({
      ...prev,
      files: prev.files.filter(f => f.id !== id),
      summary: null,
    }))
  }, [])

  const clearFiles = useCallback(() => {
    setState({
      files: [],
      isUploading: false,
      summary: null,
    })
  }, [])

  const uploadSingleFile = useCallback(
    async (fileItem: FileUploadItem): Promise<FileUploadItem> => {
      // Update status to uploading
      setState(prev => ({
        ...prev,
        files: prev.files.map(f =>
          f.id === fileItem.id ? { ...f, status: 'uploading' as FileUploadStatus, progress: 0 } : f
        ),
      }))

      try {
        const attachment = await uploadAttachment(fileItem.file, progress => {
          setState(prev => ({
            ...prev,
            files: prev.files.map(f => (f.id === fileItem.id ? { ...f, progress } : f)),
          }))
        })

        // Check if parsing succeeded
        if (attachment.status === 'failed') {
          const errorMessage =
            getErrorMessageFromCode(attachment.error_code, t) ||
            attachment.error_message ||
            t('common:attachment.errors.parse_failed')

          // Try to delete the failed attachment
          try {
            await deleteAttachment(attachment.id)
          } catch {
            // Ignore delete errors
          }

          return {
            ...fileItem,
            status: 'error',
            progress: 0,
            error: errorMessage,
            attachment: null,
          }
        }

        return {
          ...fileItem,
          status: 'success',
          progress: 100,
          error: null,
          attachment: {
            id: attachment.id,
            filename: attachment.filename,
            file_size: attachment.file_size,
            mime_type: attachment.mime_type,
            status: attachment.status,
            text_length: attachment.text_length,
            error_message: attachment.error_message,
            error_code: attachment.error_code,
            subtask_id: null,
            file_extension: fileItem.file.name.substring(fileItem.file.name.lastIndexOf('.')),
            created_at: new Date().toISOString(),
            truncation_info: attachment.truncation_info,
          },
        }
      } catch (err) {
        const errorMessage = (err as Error).message || t('common:attachment.errors.network_error')
        return {
          ...fileItem,
          status: 'error',
          progress: 0,
          error: errorMessage,
          attachment: null,
        }
      }
    },
    [t]
  )

  const startUpload = useCallback(async () => {
    const pendingFiles = state.files.filter(f => f.status === 'pending')
    if (pendingFiles.length === 0) return

    setState(prev => ({ ...prev, isUploading: true, summary: null }))

    let successCount = 0
    let failedCount = 0

    // Upload files sequentially to avoid overwhelming the server
    for (const fileItem of pendingFiles) {
      const result = await uploadSingleFile(fileItem)

      if (result.status === 'success') {
        successCount++
      } else {
        failedCount++
      }

      // Update the file item in state
      setState(prev => ({
        ...prev,
        files: prev.files.map(f => (f.id === fileItem.id ? result : f)),
      }))
    }

    setState(prev => ({
      ...prev,
      isUploading: false,
      summary: {
        total: pendingFiles.length,
        success: successCount,
        failed: failedCount,
      },
    }))
  }, [state.files, uploadSingleFile])

  const retryFile = useCallback(
    async (id: string) => {
      const fileItem = state.files.find(f => f.id === id)
      if (!fileItem || fileItem.status !== 'error') return

      // Reset the file status to pending
      setState(prev => ({
        ...prev,
        files: prev.files.map(f =>
          f.id === id
            ? { ...f, status: 'pending' as FileUploadStatus, error: null, progress: 0 }
            : f
        ),
        summary: null,
      }))

      const resetFileItem = {
        ...fileItem,
        status: 'pending' as FileUploadStatus,
        error: null,
        progress: 0,
      }
      const result = await uploadSingleFile(resetFileItem)

      setState(prev => ({
        ...prev,
        files: prev.files.map(f => (f.id === id ? result : f)),
      }))
    },
    [state.files, uploadSingleFile]
  )

  const reset = useCallback(() => {
    setState({
      files: [],
      isUploading: false,
      summary: null,
    })
  }, [])

  const renameFile = useCallback((id: string, newName: string) => {
    setState(prev => ({
      ...prev,
      files: prev.files.map(f => {
        if (f.id !== id || f.status !== 'success' || !f.attachment) {
          return f
        }
        // Update the attachment filename
        return {
          ...f,
          attachment: {
            ...f.attachment,
            filename: newName,
          },
        }
      }),
    }))
  }, [])

  // Note: Not using useCallback here to ensure we always get the latest state
  // This is important for rename operations where state updates may be pending
  const getSuccessfulAttachments = () => {
    return state.files
      .filter(f => f.status === 'success' && f.attachment)
      .map(f => ({ attachment: f.attachment!, file: f.file }))
  }

  return {
    state,
    addFiles,
    removeFile,
    clearFiles,
    startUpload,
    retryFile,
    renameFile,
    reset,
    getSuccessfulAttachments,
  }
}
