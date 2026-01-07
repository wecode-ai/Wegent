// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useRef, useCallback } from 'react'
import { Paperclip, X, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import {
  SUPPORTED_EXTENSIONS,
  MAX_FILE_SIZE,
  formatFileSize,
  getFileIcon,
  isImageExtension,
  getAttachmentPreviewUrl,
} from '@/apis/attachments'
import { getToken } from '@/apis/user'
import type { Attachment, MultiAttachmentUploadState } from '@/types/api'
import { useState, useEffect } from 'react'

interface MultiFileUploadProps {
  /** Current attachments state */
  state: MultiAttachmentUploadState
  /** Whether the component is disabled */
  disabled?: boolean
  /** Callback when files are selected */
  onFileSelect: (files: File | File[]) => void
  /** Callback to remove an attachment */
  onRemove: (attachmentId: number) => void
  /** Show only button without previews */
  showButtonOnly?: boolean
  /** Show only previews without button */
  showPreviewOnly?: boolean
}

/**
 * Custom hook to fetch image with authentication and return blob URL
 */
function useAuthenticatedImageInline(attachmentId: number, isImage: boolean) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState(false)

  useEffect(() => {
    if (!isImage) return

    let isMounted = true
    const fetchImage = async () => {
      setIsLoading(true)
      setError(false)

      try {
        const token = getToken()
        const response = await fetch(getAttachmentPreviewUrl(attachmentId), {
          headers: {
            ...(token && { Authorization: `Bearer ${token}` }),
          },
        })

        if (!response.ok) {
          throw new Error(`Failed to fetch image: ${response.status}`)
        }

        const blob = await response.blob()
        if (isMounted) {
          const url = URL.createObjectURL(blob)
          setBlobUrl(url)
        }
      } catch (err) {
        console.error('Failed to load image:', err)
        if (isMounted) {
          setError(true)
        }
      } finally {
        if (isMounted) {
          setIsLoading(false)
        }
      }
    }

    fetchImage()

    return () => {
      isMounted = false
    }
  }, [attachmentId, isImage])

  // Clean up blob URL when it changes or component unmounts
  useEffect(() => {
    return () => {
      if (blobUrl) {
        URL.revokeObjectURL(blobUrl)
      }
    }
  }, [blobUrl])

  return { blobUrl, isLoading, error }
}

/**
 * Inline attachment preview component
 */
function AttachmentPreviewInline({
  attachment,
  disabled,
  onRemove,
}: {
  attachment: Attachment
  disabled?: boolean
  onRemove: () => void
}) {
  const isImage = isImageExtension(attachment.file_extension)
  const {
    blobUrl: imageUrl,
    isLoading: imageLoading,
    error: imageError,
  } = useAuthenticatedImageInline(attachment.id, isImage)

  // For images, show thumbnail preview
  if (isImage && !imageError) {
    // Show loading state
    if (imageLoading) {
      return (
        <div
          className={`relative flex items-center gap-2 px-2 py-1.5 rounded-lg border bg-muted border-border`}
        >
          <div className="relative h-10 w-10 rounded overflow-hidden border border-border flex items-center justify-center bg-muted">
            <Loader2 className="h-4 w-4 animate-spin text-text-muted" />
          </div>
          <div className="flex flex-col min-w-0 max-w-[120px]">
            <span className="text-xs font-medium truncate" title={attachment.filename}>
              {attachment.filename}
            </span>
            <span className="text-xs text-text-muted">{formatFileSize(attachment.file_size)}</span>
          </div>
          {!disabled && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={onRemove}
              className="h-5 w-5 ml-1 text-text-muted hover:text-text-primary"
            >
              <X className="h-3 w-3" />
            </Button>
          )}
        </div>
      )
    }

    // Show image once loaded
    if (imageUrl) {
      return (
        <div
          className={`relative flex items-center gap-2 px-2 py-1.5 rounded-lg border ${
            attachment.status === 'ready'
              ? 'bg-muted border-border'
              : attachment.status === 'failed'
                ? 'bg-red-50 border-red-200 dark:bg-red-900/20 dark:border-red-800'
                : 'bg-muted border-border'
          }`}
        >
          <div className="relative h-10 w-10 rounded overflow-hidden border border-border">
            <img src={imageUrl} alt={attachment.filename} className="h-full w-full object-cover" />
          </div>
          <div className="flex flex-col min-w-0 max-w-[120px]">
            <span className="text-xs font-medium truncate" title={attachment.filename}>
              {attachment.filename}
            </span>
            <span className="text-xs text-text-muted">{formatFileSize(attachment.file_size)}</span>
          </div>
          {attachment.status === 'parsing' && (
            <Loader2 className="h-3 w-3 animate-spin text-primary ml-1" />
          )}
          {!disabled && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={onRemove}
              className="h-5 w-5 ml-1 text-text-muted hover:text-text-primary"
            >
              <X className="h-3 w-3" />
            </Button>
          )}
        </div>
      )
    }
  }

  // For non-images or image load errors, show file icon
  return (
    <div
      className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border ${
        attachment.status === 'ready'
          ? 'bg-muted border-border'
          : attachment.status === 'failed'
            ? 'bg-red-50 border-red-200 dark:bg-red-900/20 dark:border-red-800'
            : 'bg-muted border-border'
      }`}
    >
      <span className="text-base">{getFileIcon(attachment.file_extension)}</span>
      <div className="flex flex-col min-w-0 max-w-[150px]">
        <span className="text-xs font-medium truncate" title={attachment.filename}>
          {attachment.filename}
        </span>
        <span className="text-xs text-text-muted">
          {formatFileSize(attachment.file_size)}
          {attachment.text_length && ` · ${attachment.text_length.toLocaleString()} 字符`}
        </span>
      </div>
      {attachment.status === 'parsing' && (
        <Loader2 className="h-3 w-3 animate-spin text-primary ml-1" />
      )}
      {!disabled && (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={onRemove}
          className="h-5 w-5 ml-1 text-text-muted hover:text-text-primary"
        >
          <X className="h-3 w-3" />
        </Button>
      )}
    </div>
  )
}

export default function MultiFileUpload({
  state,
  disabled = false,
  onFileSelect,
  onRemove,
  showButtonOnly = false,
  showPreviewOnly = false,
}: MultiFileUploadProps) {
  const fileInputRef = useRef<HTMLInputElement>(null)

  const handleClick = useCallback(() => {
    if (!disabled) {
      fileInputRef.current?.click()
    }
  }, [disabled])

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files
      if (files && files.length > 0) {
        onFileSelect(Array.from(files))
      }
      // Reset input so same file can be selected again
      if (fileInputRef.current) {
        fileInputRef.current.value = ''
      }
    },
    [onFileSelect]
  )

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
  }, [])

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      e.stopPropagation()

      if (disabled) return

      const files = e.dataTransfer.files
      if (files && files.length > 0) {
        onFileSelect(Array.from(files))
      }
    },
    [disabled, onFileSelect]
  )

  // Build accept string for file input
  const acceptString = SUPPORTED_EXTENSIONS.join(',')

  // Tooltip content
  const tooltipContent = `支持的文件类型: PDF, Word, PPT, Excel, TXT, Markdown, 图片(JPG, PNG, GIF, BMP, WebP)\n最大文件大小: ${MAX_FILE_SIZE / (1024 * 1024)} MB\n支持多文件同时上传`

  const hasAttachments = state.attachments.length > 0
  const isUploading = state.uploadingFiles.size > 0

  // Control what to show based on props
  const shouldShowButton = !showPreviewOnly && !isUploading
  const shouldShowPreview = !showButtonOnly && hasAttachments
  const shouldShowUploading = !showButtonOnly && isUploading
  const shouldShowErrors = !showButtonOnly && state.errors.size > 0

  return (
    <div className="flex flex-col gap-2" onDragOver={handleDragOver} onDrop={handleDrop}>
      {/* Hidden file input with multiple support */}
      <input
        ref={fileInputRef}
        type="file"
        accept={acceptString}
        multiple
        onChange={handleFileChange}
        className="hidden"
        disabled={disabled}
      />

      {/* Upload button - always show when not uploading */}
      {shouldShowButton && (
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="icon"
                onClick={handleClick}
                disabled={disabled}
                className="h-9 w-9 rounded-full border-border bg-base text-text-primary hover:bg-hover"
              >
                <Paperclip className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-xs whitespace-pre-line">
              <p>{tooltipContent}</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}

      {/* Uploading files */}
      {shouldShowUploading &&
        Array.from(state.uploadingFiles.entries()).map(([fileId, { file, progress }]) => (
          <div key={fileId} className="flex items-center gap-2 px-3 py-1.5 bg-muted rounded-lg">
            <Loader2 className="h-4 w-4 animate-spin text-primary flex-shrink-0" />
            <div className="flex flex-col min-w-[100px] flex-1">
              <span className="text-xs text-text-muted truncate">{file.name}</span>
              <Progress value={progress} className="h-1 mt-1" />
            </div>
          </div>
        ))}

      {/* Attachment previews in a horizontal scrollable container */}
      {shouldShowPreview && (
        <div className="flex items-center gap-2 overflow-x-auto max-w-full">
          {state.attachments.map(attachment => (
            <div key={attachment.id} className="flex-shrink-0">
              <AttachmentPreviewInline
                attachment={attachment}
                disabled={disabled}
                onRemove={() => onRemove(attachment.id)}
              />
            </div>
          ))}
        </div>
      )}

      {/* Error messages */}
      {shouldShowErrors && (
        <div className="flex flex-col gap-1">
          {Array.from(state.errors.entries()).map(([fileId, error]) => (
            <span key={fileId} className="text-xs text-red-500 truncate" title={error}>
              {error}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
