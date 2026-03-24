// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useRef, useCallback } from 'react'
import {
  Upload,
  Loader2,
  Trash2,
  Download,
  FileArchive,
  FileVideo,
  File as FileIcon,
  FileText,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { cn, sanitizeFilename } from '@/lib/utils'
import { uploadEvaluationFile, downloadEvaluationFile } from '@wecode/api/evaluation-shared'
import type { EvalFileType } from '@wecode/api/evaluation-shared'
import type { ExamAttachment } from '@wecode/types/evaluation-exam'

// ============================================================================
// Shared Utilities
// ============================================================================

/**
 * Format file size to human-readable string
 */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1048576).toFixed(1)} MB`
}

/**
 * Get appropriate icon component for file type
 */
export function getFileIcon(contentType?: string, className?: string) {
  const iconClass = className || 'h-5 w-5'
  if (contentType?.startsWith('video/')) {
    return <FileVideo className={cn(iconClass, 'text-red-600')} />
  }
  if (contentType === 'application/zip' || contentType === 'application/x-zip-compressed') {
    return <FileArchive className={cn(iconClass, 'text-blue-600')} />
  }
  if (contentType === 'application/pdf') {
    return <FileText className={cn(iconClass, 'text-red-500')} />
  }
  return <FileIcon className={cn(iconClass, 'text-gray-600')} />
}

/**
 * Get icon background color for file type
 */
export function getIconBgColor(contentType?: string): string {
  if (contentType?.startsWith('video/')) return 'bg-red-100'
  if (contentType === 'application/zip' || contentType === 'application/x-zip-compressed')
    return 'bg-blue-100'
  if (contentType === 'application/pdf') return 'bg-red-50'
  return 'bg-gray-100'
}

// ============================================================================
// FileItem Component - Display a single uploaded file
// ============================================================================

export interface FileItemProps {
  /** The attachment to display */
  attachment: ExamAttachment
  /** Callback when remove button is clicked */
  onRemove?: () => void
  /** Callback when download button is clicked */
  onDownload?: () => void
  /** Whether the component is disabled */
  disabled?: boolean
  /** Whether download is in progress */
  isDownloading?: boolean
  /** Additional actions to render before download/remove */
  actions?: React.ReactNode
  /** Visual variant */
  variant?: 'default' | 'compact'
}

/**
 * FileItem - Displays a single file with download and delete actions
 */
export function FileItem({
  attachment,
  onRemove,
  onDownload,
  disabled,
  isDownloading,
  actions,
  variant = 'default',
}: FileItemProps) {
  const isCompact = variant === 'compact'

  return (
    <div
      className={cn(
        'flex items-center gap-3 rounded-lg border border-gray-200 bg-gray-50',
        isCompact ? 'p-2' : 'p-3'
      )}
    >
      <div
        className={cn(
          'rounded-lg flex items-center justify-center flex-shrink-0',
          getIconBgColor(attachment.content_type),
          isCompact ? 'w-8 h-8' : 'w-10 h-10'
        )}
      >
        {getFileIcon(attachment.content_type, isCompact ? 'h-4 w-4' : 'h-5 w-5')}
      </div>
      <div className="flex-1 min-w-0">
        <p className={cn('font-medium text-gray-900 truncate', isCompact ? 'text-xs' : 'text-sm')}>
          {attachment.filename}
        </p>
        <p className={cn('text-gray-500', isCompact ? 'text-[10px]' : 'text-xs')}>
          {formatFileSize(attachment.size)}
        </p>
      </div>
      <div className="flex items-center gap-1 flex-shrink-0">
        {actions}
        {onDownload && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onDownload}
            disabled={disabled || isDownloading}
            className={cn(
              'p-0 text-gray-500 hover:text-green-600',
              isCompact ? 'h-7 w-7' : 'h-8 w-8'
            )}
            data-testid="file-download-button"
          >
            {isDownloading ? (
              <Loader2 className={cn('animate-spin', isCompact ? 'h-3.5 w-3.5' : 'h-4 w-4')} />
            ) : (
              <Download className={isCompact ? 'h-3.5 w-3.5' : 'h-4 w-4'} />
            )}
          </Button>
        )}
        {onRemove && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onRemove}
            disabled={disabled}
            className={cn(
              'p-0 text-gray-500 hover:text-red-600',
              isCompact ? 'h-7 w-7' : 'h-8 w-8'
            )}
            data-testid="file-remove-button"
          >
            <Trash2 className={isCompact ? 'h-3.5 w-3.5' : 'h-4 w-4'} />
          </Button>
        )}
      </div>
    </div>
  )
}

// ============================================================================
// UploadingFileItem Component - Display a file being uploaded
// ============================================================================

export interface UploadingFileItemProps {
  /** File name */
  filename: string
  /** Upload progress (0-100) */
  progress: number
  /** Error message if upload failed */
  error?: string
  /** Callback when cancel/remove button is clicked */
  onCancel?: () => void
}

/**
 * UploadingFileItem - Displays upload progress or error state
 */
export function UploadingFileItem({ filename, progress, error, onCancel }: UploadingFileItemProps) {
  return (
    <div
      className={cn(
        'flex items-center gap-3 rounded-lg border p-3',
        error ? 'border-destructive bg-destructive/5' : 'border-gray-200 bg-gray-50'
      )}
    >
      {error ? (
        <X className="h-5 w-5 text-destructive flex-shrink-0" />
      ) : (
        <Loader2 className="h-5 w-5 animate-spin text-[#DF2029] flex-shrink-0" />
      )}
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-gray-900">{filename}</p>
        {error ? (
          <p className="text-xs text-destructive">{error}</p>
        ) : (
          <div className="flex items-center gap-2 mt-1">
            <Progress value={progress} className="h-1.5 flex-1" />
            <span className="text-xs text-gray-500 flex-shrink-0">{progress}%</span>
          </div>
        )}
      </div>
      {onCancel && (
        <Button
          variant="ghost"
          size="sm"
          className="h-8 w-8 p-0"
          onClick={onCancel}
          data-testid="upload-cancel-button"
        >
          <X className="h-4 w-4" />
        </Button>
      )}
    </div>
  )
}

// ============================================================================
// FileDropzone Component - Drag and drop upload area
// ============================================================================

export interface FileDropzoneProps {
  /** Accepted file types (e.g., ".zip", "video/*") */
  accept: string
  /** Hint text displayed below the upload text */
  hint: string
  /** Upload text displayed in the dropzone */
  uploadText: string
  /** Whether the component is disabled */
  disabled?: boolean
  /** Whether multiple files can be selected */
  multiple?: boolean
  /** Icon to display (defaults to Upload) */
  icon?: React.ReactNode
  /** Callback when files are selected (raw files, no upload) */
  onFilesSelected?: (files: File[]) => void
}

/**
 * FileDropzone - Basic drag and drop area for file selection
 * Does NOT handle upload - use SingleFileUpload or MultiFileUpload for that
 */
export function FileDropzone({
  accept,
  hint,
  uploadText,
  disabled,
  multiple = false,
  icon,
  onFilesSelected,
}: FileDropzoneProps) {
  const [isDragging, setIsDragging] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const handleFiles = useCallback(
    (files: FileList | null) => {
      if (!files || files.length === 0 || disabled) return
      onFilesSelected?.(Array.from(files))
    },
    [disabled, onFilesSelected]
  )

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      setIsDragging(false)
      handleFiles(e.dataTransfer.files)
    },
    [handleFiles]
  )

  return (
    <div
      onClick={() => !disabled && fileInputRef.current?.click()}
      onDragOver={e => {
        e.preventDefault()
        if (!disabled) setIsDragging(true)
      }}
      onDragLeave={() => setIsDragging(false)}
      onDrop={handleDrop}
      className={cn(
        'rounded-lg border-2 border-dashed p-6 cursor-pointer transition-colors',
        isDragging
          ? 'border-[#DF2029] bg-red-50'
          : 'border-gray-300 hover:border-gray-400 bg-white',
        disabled && 'opacity-50 cursor-not-allowed'
      )}
      data-testid="file-dropzone"
    >
      <div className="flex flex-col items-center gap-2 text-center">
        <div className="w-10 h-10 rounded-full bg-gray-100 flex items-center justify-center">
          {icon || <Upload className="h-5 w-5 text-gray-500" />}
        </div>
        <div>
          <p className="text-sm font-medium text-gray-700">{uploadText}</p>
          <p className="text-xs text-gray-500 mt-1">{hint}</p>
        </div>
      </div>
      <input
        ref={fileInputRef}
        type="file"
        accept={accept}
        multiple={multiple}
        onChange={e => {
          handleFiles(e.target.files)
          e.target.value = ''
        }}
        className="hidden"
        disabled={disabled}
      />
    </div>
  )
}

// ============================================================================
// SingleFileUpload Component - Complete single file upload with S3
// ============================================================================

export interface SingleFileUploadProps {
  /** Accepted file types (e.g., ".zip", "video/*") */
  accept: string
  /** Hint text displayed below the upload text */
  hint: string
  /** Upload text displayed in the dropzone */
  uploadText: string
  /** File type for S3 upload path */
  fileType: EvalFileType
  /** Topic ID for S3 path */
  topicId: number
  /** Optional question ID for S3 path */
  questionId?: number
  /** Optional slot name for S3 path */
  slot?: string
  /** Maximum file size in bytes (default 500MB) */
  maxSize?: number
  /** Whether the component is disabled */
  disabled?: boolean
  /** Current attachment (if any) */
  attachment: ExamAttachment | null
  /** Callback when upload succeeds */
  onUploadSuccess: (attachment: ExamAttachment) => void
  /** Callback when attachment is removed */
  onRemove: () => void
  /** Callback when upload fails */
  onUploadError?: (error: Error) => void
  /** Custom file validation function */
  validateFile?: (file: File) => string | null
  /** Additional actions for the file item */
  fileActions?: React.ReactNode
}

/**
 * SingleFileUpload - Complete single file upload component
 * Handles upload, progress, display, download, and delete
 */
export function SingleFileUpload({
  accept,
  hint,
  uploadText,
  fileType,
  topicId,
  questionId,
  slot,
  maxSize = 500 * 1024 * 1024,
  disabled,
  attachment,
  onUploadSuccess,
  onRemove,
  onUploadError,
  validateFile,
  fileActions,
}: SingleFileUploadProps) {
  const [isUploading, setIsUploading] = useState(false)
  const [uploadProgress, setUploadProgress] = useState(0)
  const [downloadingKey, setDownloadingKey] = useState<string | null>(null)

  const handleFilesSelected = useCallback(
    async (files: File[]) => {
      if (files.length === 0 || disabled || isUploading) return

      const file = files[0]

      // Custom validation
      if (validateFile) {
        const error = validateFile(file)
        if (error) {
          onUploadError?.(new Error(error))
          return
        }
      }

      // Size validation
      if (file.size > maxSize) {
        onUploadError?.(new Error(`File must be less than ${formatFileSize(maxSize)}`))
        return
      }

      setIsUploading(true)
      setUploadProgress(0)

      try {
        const sanitizedName = sanitizeFilename(file.name)
        const fileToUpload =
          sanitizedName !== file.name ? new File([file], sanitizedName, { type: file.type }) : file

        const response = await uploadEvaluationFile(
          fileToUpload,
          fileType,
          topicId,
          questionId,
          slot,
          (progress: number) => {
            setUploadProgress(progress)
          }
        )

        const newAttachment: ExamAttachment = {
          key: response.key,
          filename: sanitizedName,
          size: fileToUpload.size,
          content_type: fileToUpload.type,
        }

        onUploadSuccess(newAttachment)
      } catch (error) {
        onUploadError?.(error instanceof Error ? error : new Error('Upload failed'))
      } finally {
        setIsUploading(false)
        setUploadProgress(0)
      }
    },
    [
      disabled,
      isUploading,
      maxSize,
      validateFile,
      fileType,
      topicId,
      questionId,
      slot,
      onUploadSuccess,
      onUploadError,
    ]
  )

  const handleDownload = useCallback(async () => {
    if (!attachment) return
    setDownloadingKey(attachment.key)
    try {
      await downloadEvaluationFile(attachment.key, attachment.filename)
    } catch (error) {
      console.error('Download failed:', error)
    } finally {
      setDownloadingKey(null)
    }
  }, [attachment])

  // Show uploading state
  if (isUploading) {
    return <UploadingFileItem filename="Uploading..." progress={uploadProgress} />
  }

  // Show uploaded file
  if (attachment) {
    return (
      <FileItem
        attachment={attachment}
        onDownload={handleDownload}
        onRemove={onRemove}
        disabled={disabled}
        isDownloading={downloadingKey === attachment.key}
        actions={fileActions}
      />
    )
  }

  // Show dropzone
  return (
    <FileDropzone
      accept={accept}
      hint={hint}
      uploadText={uploadText}
      disabled={disabled}
      onFilesSelected={handleFilesSelected}
    />
  )
}

// ============================================================================
// MultiFileUpload Component - Multiple files upload with S3
// ============================================================================

export interface MultiFileUploadProps {
  /** Accepted file types (e.g., ".zip", "video/*") */
  accept: string
  /** Hint text displayed below the upload text */
  hint: string
  /** Upload text displayed in the dropzone */
  uploadText: string
  /** File type for S3 upload path */
  fileType: EvalFileType
  /** Topic ID for S3 path */
  topicId: number
  /** Optional question ID for S3 path */
  questionId?: number
  /** Optional slot name for S3 path */
  slot?: string
  /** Maximum number of files */
  maxFiles?: number
  /** Maximum file size in bytes (default 100MB) */
  maxSize?: number
  /** Whether the component is disabled */
  disabled?: boolean
  /** Current attachments */
  attachments: ExamAttachment[]
  /** Callback when attachments change */
  onChange: (attachments: ExamAttachment[]) => void
  /** Callback when upload fails */
  onUploadError?: (error: Error) => void
  /** Custom file validation function */
  validateFile?: (file: File) => string | null
}

interface UploadingState {
  id: string
  filename: string
  progress: number
  error?: string
}

/**
 * MultiFileUpload - Multiple files upload component
 * Handles upload, progress, display, download, and delete for multiple files
 */
export function MultiFileUpload({
  accept,
  hint,
  uploadText,
  fileType,
  topicId,
  questionId,
  slot,
  maxFiles = 10,
  maxSize = 100 * 1024 * 1024,
  disabled,
  attachments,
  onChange,
  onUploadError,
  validateFile,
}: MultiFileUploadProps) {
  const [uploading, setUploading] = useState<Map<string, UploadingState>>(new Map())
  const [downloadingKey, setDownloadingKey] = useState<string | null>(null)

  const canAddMore = attachments.length < maxFiles && !disabled

  const handleFilesSelected = useCallback(
    async (files: File[]) => {
      if (files.length === 0 || disabled) return

      const remainingSlots = maxFiles - attachments.length
      if (remainingSlots <= 0) return

      const filesToUpload = files.slice(0, remainingSlots)
      const uploadedAttachments: ExamAttachment[] = []

      for (const file of filesToUpload) {
        // Custom validation
        if (validateFile) {
          const error = validateFile(file)
          if (error) {
            onUploadError?.(new Error(`${file.name}: ${error}`))
            continue
          }
        }

        // Size validation
        if (file.size > maxSize) {
          onUploadError?.(
            new Error(`${file.name}: File must be less than ${formatFileSize(maxSize)}`)
          )
          continue
        }

        const sanitizedName = sanitizeFilename(file.name)
        const fileId = `${sanitizedName}-${Date.now()}-${Math.random()}`

        setUploading(prev => {
          const newMap = new Map(prev)
          newMap.set(fileId, { id: fileId, filename: sanitizedName, progress: 0 })
          return newMap
        })

        try {
          const fileToUpload =
            sanitizedName !== file.name
              ? new File([file], sanitizedName, { type: file.type })
              : file

          const response = await uploadEvaluationFile(
            fileToUpload,
            fileType,
            topicId,
            questionId,
            slot,
            (progress: number) => {
              setUploading(prev => {
                const newMap = new Map(prev)
                const existing = newMap.get(fileId)
                if (existing) {
                  newMap.set(fileId, { ...existing, progress })
                }
                return newMap
              })
            }
          )

          const newAttachment: ExamAttachment = {
            key: response.key,
            filename: sanitizedName,
            size: fileToUpload.size,
            content_type: fileToUpload.type,
          }
          uploadedAttachments.push(newAttachment)

          setUploading(prev => {
            const newMap = new Map(prev)
            newMap.delete(fileId)
            return newMap
          })
        } catch (error) {
          setUploading(prev => {
            const newMap = new Map(prev)
            const existing = newMap.get(fileId)
            if (existing) {
              newMap.set(fileId, {
                ...existing,
                error: error instanceof Error ? error.message : 'Upload failed',
              })
            }
            return newMap
          })
        }
      }

      if (uploadedAttachments.length > 0) {
        onChange([...attachments, ...uploadedAttachments])
      }
    },
    [
      disabled,
      maxFiles,
      maxSize,
      attachments,
      validateFile,
      fileType,
      topicId,
      questionId,
      slot,
      onChange,
      onUploadError,
    ]
  )

  const handleRemove = useCallback(
    (key: string) => {
      onChange(attachments.filter(a => a.key !== key))
    },
    [attachments, onChange]
  )

  const handleRemoveUploading = useCallback((fileId: string) => {
    setUploading(prev => {
      const newMap = new Map(prev)
      newMap.delete(fileId)
      return newMap
    })
  }, [])

  const handleDownload = useCallback(async (attachment: ExamAttachment) => {
    setDownloadingKey(attachment.key)
    try {
      await downloadEvaluationFile(attachment.key, attachment.filename)
    } catch (error) {
      console.error('Download failed:', error)
    } finally {
      setDownloadingKey(null)
    }
  }, [])

  return (
    <div className="space-y-2">
      {/* Dropzone */}
      {canAddMore && (
        <FileDropzone
          accept={accept}
          hint={hint}
          uploadText={uploadText}
          disabled={disabled}
          multiple
          onFilesSelected={handleFilesSelected}
        />
      )}

      {/* Uploading files */}
      {Array.from(uploading.values()).map(item => (
        <UploadingFileItem
          key={item.id}
          filename={item.filename}
          progress={item.progress}
          error={item.error}
          onCancel={() => handleRemoveUploading(item.id)}
        />
      ))}

      {/* Uploaded files */}
      {attachments.map(attachment => (
        <FileItem
          key={attachment.key}
          attachment={attachment}
          onDownload={() => handleDownload(attachment)}
          onRemove={() => handleRemove(attachment.key)}
          disabled={disabled}
          isDownloading={downloadingKey === attachment.key}
          variant="compact"
        />
      ))}
    </div>
  )
}

// ============================================================================
// useFileDownload Hook - Reusable download state management
// ============================================================================

interface UseFileDownloadOptions {
  onDownloadSuccess?: () => void
  onDownloadError?: (error: Error) => void
}

/**
 * Hook for handling file download with state management
 */
export function useFileDownload(options?: UseFileDownloadOptions) {
  const [downloadingKey, setDownloadingKey] = useState<string | null>(null)

  const handleDownload = useCallback(
    async (attachment: ExamAttachment) => {
      setDownloadingKey(attachment.key)
      try {
        await downloadEvaluationFile(attachment.key, attachment.filename)
        options?.onDownloadSuccess?.()
      } catch (error) {
        options?.onDownloadError?.(error instanceof Error ? error : new Error('Download failed'))
      } finally {
        setDownloadingKey(null)
      }
    },
    [options]
  )

  return {
    downloadingKey,
    handleDownload,
    isDownloading: (key: string) => downloadingKey === key,
  }
}
