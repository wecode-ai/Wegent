// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useRef, useCallback } from 'react'
import { Paperclip, X, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  SUPPORTED_EXTENSIONS,
  MAX_FILE_SIZE,
  isSupportedExtension,
  isValidFileSize,
  formatFileSize,
  getFileIcon,
} from '@/apis/attachments'
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
  /** Callback when file is selected */
  onFileSelect: (file: File) => void
  /** Callback to remove the attachment */
  onRemove: () => void
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
  const fileInputRef = useRef<HTMLInputElement>(null)

  const handleClick = useCallback(() => {
    if (!disabled && !isUploading && !attachment) {
      fileInputRef.current?.click()
    }
  }, [disabled, isUploading, attachment])

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      if (file) {
        // Validate file before passing to parent
        if (!isSupportedExtension(file.name)) {
          // Let parent handle the error
          onFileSelect(file)
          return
        }
        if (!isValidFileSize(file.size)) {
          onFileSelect(file)
          return
        }
        onFileSelect(file)
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

      const file = e.dataTransfer.files?.[0]
      if (file) {
        onFileSelect(file)
      }
    },
    [disabled, isUploading, attachment, onFileSelect]
  )

  // Build accept string for file input
  const acceptString = SUPPORTED_EXTENSIONS.join(',')

  // Tooltip content
  const tooltipContent = `支持的文件类型: PDF, Word, PPT, Excel, TXT, Markdown\n最大文件大小: ${MAX_FILE_SIZE / (1024 * 1024)} MB`

  return (
    <div
      className="flex items-center gap-2"
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        accept={acceptString}
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
                variant="ghost"
                size="icon"
                onClick={handleClick}
                disabled={disabled}
                className="h-8 w-8 text-text-muted hover:text-text-primary hover:bg-muted"
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
        <div
          className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border ${
            attachment.status === 'ready'
              ? 'bg-muted border-border'
              : attachment.status === 'failed'
                ? 'bg-red-50 border-red-200 dark:bg-red-900/20 dark:border-red-800'
                : 'bg-muted border-border'
          }`}
        >
          <span className="text-base">
            {getFileIcon(attachment.file_extension)}
          </span>
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