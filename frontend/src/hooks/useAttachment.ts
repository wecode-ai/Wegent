// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Hook for managing file attachment state and upload.
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
import type { AttachmentUploadState, TruncationInfo } from '@/types/api'

interface UseAttachmentReturn {
  /** Current attachment state */
  state: AttachmentUploadState
  /** Handle file selection and upload */
  handleFileSelect: (file: File) => Promise<void>
  /** Remove current attachment */
  handleRemove: () => Promise<void>
  /** Reset state */
  reset: () => void
  /** Check if ready to send (no upload in progress, attachment ready or no attachment) */
  isReadyToSend: boolean
  /** Truncation info if content was truncated */
  truncationInfo: TruncationInfo | null
}

export function useAttachment(): UseAttachmentReturn {
  const { t } = useTranslation()
  const [state, setState] = useState<AttachmentUploadState>({
    file: null,
    attachment: null,
    isUploading: false,
    uploadProgress: 0,
    error: null,
  })
  const [truncationInfo, setTruncationInfo] = useState<TruncationInfo | null>(null)

  const handleFileSelect = useCallback(
    async (file: File) => {
      // Validate file type
      if (!isSupportedExtension(file.name)) {
        setState(prev => ({
          ...prev,
          file: null,
          attachment: null,
          isUploading: false,
          uploadProgress: 0,
          error: `${t('common:attachment.errors.unsupported_type')}: ${t('common:attachment.errors.unsupported_type_hint', { types: t('common:attachment.supported_types') })}`,
        }))
        return
      }

      // Validate file size
      if (!isValidFileSize(file.size)) {
        setState(prev => ({
          ...prev,
          file: null,
          attachment: null,
          isUploading: false,
          uploadProgress: 0,
          error: `${t('common:attachment.errors.file_too_large')}: ${t('common:attachment.errors.file_too_large_hint', { size: Math.round(MAX_FILE_SIZE / (1024 * 1024)) })}`,
        }))
        return
      }

      // Start upload
      setState(prev => ({
        ...prev,
        file,
        attachment: null,
        isUploading: true,
        uploadProgress: 0,
        error: null,
      }))
      setTruncationInfo(null)

      try {
        const attachment = await uploadAttachment(file, progress => {
          setState(prev => ({
            ...prev,
            uploadProgress: progress,
          }))
        })

        // Check if parsing succeeded
        if (attachment.status === 'failed') {
          const errorMessage =
            getErrorMessageFromCode(attachment.error_code, t) ||
            attachment.error_message ||
            t('common:attachment.errors.parse_failed')
          setState(prev => ({
            ...prev,
            file: null,
            attachment: null,
            isUploading: false,
            uploadProgress: 0,
            error: errorMessage,
          }))
          // Try to delete the failed attachment
          try {
            await deleteAttachment(attachment.id)
          } catch {
            // Ignore delete errors
          }
          return
        }

        // Store truncation info if present
        if (attachment.truncation_info?.is_truncated) {
          setTruncationInfo(attachment.truncation_info)
        }

        setState(prev => ({
          ...prev,
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
            file_extension: file.name.substring(file.name.lastIndexOf('.')),
            created_at: new Date().toISOString(),
            truncation_info: attachment.truncation_info,
          },
          isUploading: false,
          uploadProgress: 100,
          error: null,
        }))
      } catch (err) {
        const errorMessage = (err as Error).message || t('common:attachment.errors.network_error')
        setState(prev => ({
          ...prev,
          file: null,
          attachment: null,
          isUploading: false,
          uploadProgress: 0,
          error: `${t('common:attachment.errors.network_error')}: ${errorMessage}`,
        }))
      }
    },
    [t]
  )

  const handleRemove = useCallback(async () => {
    const attachmentId = state.attachment?.id

    // Reset state immediately for better UX
    setState({
      file: null,
      attachment: null,
      isUploading: false,
      uploadProgress: 0,
      error: null,
    })
    setTruncationInfo(null)

    // Try to delete from server if it exists and is not linked to a subtask
    if (attachmentId && !state.attachment?.subtask_id) {
      try {
        await deleteAttachment(attachmentId)
      } catch {
        // Ignore delete errors - attachment might already be linked
      }
    }
  }, [state.attachment])

  const reset = useCallback(() => {
    setState({
      file: null,
      attachment: null,
      isUploading: false,
      uploadProgress: 0,
      error: null,
    })
    setTruncationInfo(null)
  }, [])

  const isReadyToSend =
    !state.isUploading && (state.attachment === null || state.attachment.status === 'ready')

  return {
    state,
    handleFileSelect,
    handleRemove,
    reset,
    isReadyToSend,
    truncationInfo,
  }
}
