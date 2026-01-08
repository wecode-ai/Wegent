// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useRef, useCallback, useState, useEffect } from 'react'
import { Paperclip, X, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import {
  MAX_FILE_SIZE,
  formatFileSize,
  getFileIcon,
  isImageExtension,
  getAttachmentPreviewUrl,
} from '@/apis/attachments'
import { getToken } from '@/apis/user'
import { useTranslation } from '@/hooks/useTranslation'
import type { Attachment } from '@/types/api'

interface FileUploadProps {
  /** Currently selected/uploaded attachment */
  attachment: Attachment | null
  /** Whether upload is in progress */
  isUploading: boolean
  /** Upload progress (0-100) */
  uploadProgress: number
  /** Error message if any */
  error: string | null
  /** Whether the component is disabled */
  disabled?: boolean
  /** Callback when file(s) are selected */
  onFileSelect: (files: File | File[]) => void
  /** Callback to remove the attachment */
  onRemove: () => void
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
 * Inline attachment preview component for the input area
 * Shows image thumbnail for images, file icon for other types
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

export default function FileUpload({
  attachment,
  isUploading,
  uploadProgress,
  error,
  disabled = false,
  onFileSelect,
  onRemove,
}: FileUploadProps) {
  const { t } = useTranslation('common')
  const fileInputRef = useRef<HTMLInputElement>(null)

  const handleClick = useCallback(() => {
    if (!disabled && !isUploading && !attachment) {
      fileInputRef.current?.click()
    }
  }, [disabled, isUploading, attachment])

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files
      if (files && files.length > 0) {
        // Pass all files as an array
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

      if (disabled || isUploading || attachment) return

      const files = e.dataTransfer.files
      if (files && files.length > 0) {
        onFileSelect(Array.from(files))
      }
    },
    [disabled, isUploading, attachment, onFileSelect]
  )

  // Tooltip content - now supports all text-based files via MIME detection
  const tooltipContent = t('attachment.upload_tooltip', { size: MAX_FILE_SIZE / (1024 * 1024) })

  return (
    <div className="flex items-center gap-2" onDragOver={handleDragOver} onDrop={handleDrop}>
      {/* Hidden file input - no accept restriction to allow all file types */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        onChange={handleFileChange}
        className="hidden"
        disabled={disabled || isUploading}
      />

      {/* Upload button or attachment preview */}
      {!attachment && !isUploading && (
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

      {/* Uploading state */}
      {isUploading && (
        <div className="flex items-center gap-2 px-3 py-1.5 bg-muted rounded-lg">
          <Loader2 className="h-4 w-4 animate-spin text-primary" />
          <div className="flex flex-col min-w-[100px]">
            <span className="text-xs text-text-muted">上传中...</span>
            <Progress value={uploadProgress} className="h-1 mt-1" />
          </div>
        </div>
      )}

      {/* Attachment preview */}
      {attachment && !isUploading && (
        <AttachmentPreviewInline attachment={attachment} disabled={disabled} onRemove={onRemove} />
      )}

      {/* Error message */}
      {error && !isUploading && !attachment && (
        <span className="text-xs text-red-500 max-w-[200px] truncate" title={error}>
          {error}
        </span>
      )}
    </div>
  )
}
