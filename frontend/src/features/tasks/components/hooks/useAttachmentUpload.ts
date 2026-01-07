// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * useAttachmentUpload Hook
 *
 * Unified hook for managing all attachment upload interactions:
 * - Button click upload
 * - Drag and drop upload
 * - Paste file upload
 *
 * This hook centralizes all attachment upload logic and provides
 * consistent behavior across different upload methods.
 */

import { useCallback, useMemo } from 'react'
import type { Team, MultiAttachmentUploadState } from '@/types/api'
import { supportsAttachments } from '../../service/attachmentService'

export interface UseAttachmentUploadOptions {
  /** Currently selected team */
  team: Team | null
  /** Whether the chat is loading */
  isLoading: boolean
  /** Whether the chat is streaming */
  isStreaming: boolean
  /** Attachment state from useMultiAttachment */
  attachmentState: MultiAttachmentUploadState
  /** File select handler from useMultiAttachment */
  onFileSelect: (files: File | File[]) => Promise<void>
  /** Drag state setter */
  setIsDragging: (isDragging: boolean) => void
}

export interface UseAttachmentUploadReturn {
  /** Whether attachments are supported for the current team */
  isAttachmentSupported: boolean
  /** Whether upload interactions are currently disabled */
  isUploadDisabled: boolean
  /** Handler for drag enter event */
  handleDragEnter: (e: React.DragEvent) => void
  /** Handler for drag leave event */
  handleDragLeave: (e: React.DragEvent) => void
  /** Handler for drag over event */
  handleDragOver: (e: React.DragEvent) => void
  /** Handler for drop event */
  handleDrop: (e: React.DragEvent) => void
  /** Handler for paste file (to be passed to ChatInput) */
  handlePasteFile: ((files: File | File[]) => void) | undefined
  /** Handler for button click file select */
  handleButtonFileSelect: (files: File | File[]) => void
}

/**
 * useAttachmentUpload Hook
 *
 * Provides unified attachment upload functionality with:
 * - Automatic team capability detection
 * - Consistent disabled state handling
 * - Drag and drop event handlers
 * - Paste file handler
 * - Button click handler
 *
 * @example
 * ```tsx
 * const {
 *   isAttachmentSupported,
 *   handleDragEnter,
 *   handleDragLeave,
 *   handleDragOver,
 *   handleDrop,
 *   handlePasteFile,
 *   handleButtonFileSelect,
 * } = useAttachmentUpload({
 *   team: selectedTeam,
 *   isLoading,
 *   isStreaming,
 *   attachmentState,
 *   onFileSelect: handleFileSelect,
 *   setIsDragging,
 * });
 * ```
 */
export function useAttachmentUpload({
  team,
  isLoading,
  isStreaming,
  attachmentState: _attachmentState,
  onFileSelect,
  setIsDragging,
}: UseAttachmentUploadOptions): UseAttachmentUploadReturn {
  // Check if attachments are supported for the current team
  const isAttachmentSupported = useMemo(() => {
    return supportsAttachments(team)
  }, [team])

  // Check if upload interactions should be disabled
  const isUploadDisabled = useMemo(() => {
    return isLoading || isStreaming
  }, [isLoading, isStreaming])

  // Drag enter handler
  const handleDragEnter = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (!isAttachmentSupported) return
      if (isUploadDisabled) return
      setIsDragging(true)
    },
    [isAttachmentSupported, isUploadDisabled, setIsDragging]
  )

  // Drag leave handler
  const handleDragLeave = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      // Only set dragging to false if we're leaving the container entirely
      if (e.currentTarget.contains(e.relatedTarget as Node)) return
      setIsDragging(false)
    },
    [setIsDragging]
  )

  // Drag over handler
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
  }, [])

  // Drop handler
  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      setIsDragging(false)

      if (!isAttachmentSupported) return
      if (isUploadDisabled) return

      const files = e.dataTransfer.files
      if (files && files.length > 0) {
        onFileSelect(Array.from(files))
      }
    },
    [isAttachmentSupported, isUploadDisabled, onFileSelect, setIsDragging]
  )

  // Paste file handler - returns undefined if not supported
  const handlePasteFile = useMemo(() => {
    if (!isAttachmentSupported) return undefined
    return (files: File | File[]) => {
      if (isUploadDisabled) return
      onFileSelect(files)
    }
  }, [isAttachmentSupported, isUploadDisabled, onFileSelect])

  // Button file select handler
  const handleButtonFileSelect = useCallback(
    (files: File | File[]) => {
      if (!isAttachmentSupported) return
      if (isUploadDisabled) return
      onFileSelect(files)
    },
    [isAttachmentSupported, isUploadDisabled, onFileSelect]
  )

  return {
    isAttachmentSupported,
    isUploadDisabled,
    handleDragEnter,
    handleDragLeave,
    handleDragOver,
    handleDrop,
    handlePasteFile,
    handleButtonFileSelect,
  }
}

export default useAttachmentUpload
