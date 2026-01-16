// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Hook for managing multiple file attachments state and upload.
 */

import { useState, useCallback } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import {
  uploadAttachment,
  deleteAttachment,
  isSupportedExtension,
  isValidFileSize,
  MAX_FILE_SIZE,
  getErrorMessageFromCode,
} from '@/apis/attachments'
import type { MultiAttachmentUploadState, TruncationInfo } from '@/types/api'
import { toast } from '@/hooks/use-toast'

interface UseMultiAttachmentReturn {
  /** Current attachment state */
  state: MultiAttachmentUploadState
  /** Handle file selection and upload */
  handleFileSelect: (files: File | File[]) => Promise<void>
  /** Remove specific attachment */
  handleRemove: (attachmentId: number) => Promise<void>
  /** Reset state */
  reset: () => void
  /** Check if ready to send (no upload in progress, all attachments ready) */
  isReadyToSend: boolean
  /** Check if any upload is in progress */
  isUploading: boolean
  /** Truncation info for attachments that were truncated */
  truncatedAttachments: Map<number, TruncationInfo>
}

export function useMultiAttachment(): UseMultiAttachmentReturn {
  const { t } = useTranslation()
  const [state, setState] = useState<MultiAttachmentUploadState>({
    attachments: [],
    uploadingFiles: new Map(),
    errors: new Map(),
  })
  const [truncatedAttachments, setTruncatedAttachments] = useState<Map<number, TruncationInfo>>(
    new Map()
  )

  const handleFileSelect = useCallback(
    async (files: File | File[]) => {
      const fileList = Array.isArray(files) ? files : [files]

      // Clear previous errors before new upload attempt
      setState(prev => ({
        ...prev,
        errors: new Map(),
      }))

      for (const file of fileList) {
        // Use only filename as fileId to avoid duplicate errors for the same file
        const fileId = file.name

        // Validate file type
        if (!isSupportedExtension(file.name)) {
          setState(prev => {
            const newErrors = new Map(prev.errors)
            newErrors.set(
              fileId,
              `${t('common:attachment.errors.unsupported_type')}: ${t('common:attachment.errors.unsupported_type_hint', { types: t('common:attachment.supported_types') })}`
            )
            return { ...prev, errors: newErrors }
          })
          continue
        }

        // Validate file size
        if (!isValidFileSize(file.size)) {
          setState(prev => {
            const newErrors = new Map(prev.errors)
            newErrors.set(
              fileId,
              `${t('common:attachment.errors.file_too_large')}: ${t('common:attachment.errors.file_too_large_hint', { size: Math.round(MAX_FILE_SIZE / (1024 * 1024)) })}`
            )
            return { ...prev, errors: newErrors }
          })
          continue
        }

        // Start upload
        setState(prev => {
          const newUploadingFiles = new Map(prev.uploadingFiles)
          newUploadingFiles.set(fileId, { file, progress: 0 })
          const newErrors = new Map(prev.errors)
          newErrors.delete(fileId)
          return {
            ...prev,
            uploadingFiles: newUploadingFiles,
            errors: newErrors,
          }
        })

        try {
          const attachment = await uploadAttachment(file, progress => {
            setState(prev => {
              const newUploadingFiles = new Map(prev.uploadingFiles)
              const existing = newUploadingFiles.get(fileId)
              if (existing) {
                newUploadingFiles.set(fileId, { ...existing, progress })
              }
              return { ...prev, uploadingFiles: newUploadingFiles }
            })
          })

          // Check if parsing succeeded
          if (attachment.status === 'failed') {
            const errorMessage =
              getErrorMessageFromCode(attachment.error_code, t) ||
              attachment.error_message ||
              t('common:attachment.errors.parse_failed')
            setState(prev => {
              const newUploadingFiles = new Map(prev.uploadingFiles)
              newUploadingFiles.delete(fileId)
              const newErrors = new Map(prev.errors)
              newErrors.set(fileId, errorMessage)
              return {
                ...prev,
                uploadingFiles: newUploadingFiles,
                errors: newErrors,
              }
            })
            // Try to delete the failed attachment
            try {
              await deleteAttachment(attachment.id)
            } catch {
              // Ignore delete errors
            }
            continue
          }

          // Store truncation info if present
          if (attachment.truncation_info?.is_truncated) {
            setTruncatedAttachments(prev => {
              const newMap = new Map(prev)
              newMap.set(attachment.id, attachment.truncation_info!)
              return newMap
            })
            // Show toast notification for truncation
            toast({
              title: t('common:attachment.errors.content_truncated'),
              description: t('common:attachment.truncation.notice', {
                original: attachment.truncation_info.original_length?.toLocaleString(),
                truncated: attachment.truncation_info.truncated_length?.toLocaleString(),
              }),
              variant: 'default',
            })
          }

          // Add to attachments list
          setState(prev => {
            const newUploadingFiles = new Map(prev.uploadingFiles)
            newUploadingFiles.delete(fileId)
            return {
              ...prev,
              attachments: [
                ...prev.attachments,
                {
                  id: attachment.id,
                  filename: attachment.filename,
                  file_size: attachment.file_size,
                  mime_type: attachment.mime_type,
                  status: attachment.status,
                  text_length: attachment.text_length,
                  error_message: attachment.error_message,
                  error_code: attachment.error_code,
                  subtask_id: null,
                  file_extension: file.name.substring(file.name.lastIndexOf('.')),
                  created_at: new Date().toISOString(),
                  truncation_info: attachment.truncation_info,
                },
              ],
              uploadingFiles: newUploadingFiles,
            }
          })
        } catch (err) {
          setState(prev => {
            const newUploadingFiles = new Map(prev.uploadingFiles)
            newUploadingFiles.delete(fileId)
            const newErrors = new Map(prev.errors)
            newErrors.set(
              fileId,
              `${t('common:attachment.errors.network_error')}: ${(err as Error).message || t('common:attachment.errors.network_error_hint')}`
            )
            return {
              ...prev,
              uploadingFiles: newUploadingFiles,
              errors: newErrors,
            }
          })
        }
      }
    },
    [state.attachments, t]
  )

  const handleRemove = useCallback(
    async (attachmentId: number) => {
      const attachment = state.attachments.find(a => a.id === attachmentId)

      // Remove from state immediately for better UX
      setState(prev => ({
        ...prev,
        attachments: prev.attachments.filter(a => a.id !== attachmentId),
      }))

      // Remove truncation info
      setTruncatedAttachments(prev => {
        const newMap = new Map(prev)
        newMap.delete(attachmentId)
        return newMap
      })

      // Try to delete from server if it exists and is not linked to a subtask
      if (attachment && !attachment.subtask_id) {
        try {
          await deleteAttachment(attachmentId)
        } catch {
          // Ignore delete errors - attachment might already be linked
        }
      }
    },
    [state.attachments]
  )

  const reset = useCallback(() => {
    setState({
      attachments: [],
      uploadingFiles: new Map(),
      errors: new Map(),
    })
    setTruncatedAttachments(new Map())
  }, [])

  const isUploading = state.uploadingFiles.size > 0
  const isReadyToSend =
    !isUploading &&
    state.attachments.every(att => att.status === 'ready') &&
    state.errors.size === 0

  return {
    state,
    handleFileSelect,
    handleRemove,
    reset,
    isReadyToSend,
    isUploading,
    truncatedAttachments,
  }
}
