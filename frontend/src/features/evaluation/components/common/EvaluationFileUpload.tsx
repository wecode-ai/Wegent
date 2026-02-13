// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useCallback, useRef } from 'react'
import { Upload, X, File, Download, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/hooks/useTranslation'
import {
  uploadEvaluationFile,
  downloadEvaluationFile,
  type EvalFileType,
  type EvalAttachment,
} from '@wecode/api/evaluation-shared'
import { formatFileSize } from '@/apis/attachments'

interface EvaluationFileUploadProps {
  /** Topic ID for the upload */
  topicId: number
  /** Question ID for question files */
  questionId?: number
  /** Type of file being uploaded */
  fileType: EvalFileType
  /** Current attachments */
  attachments: EvalAttachment[]
  /** Callback when attachments change */
  onChange: (attachments: EvalAttachment[]) => void
  /** Maximum number of files allowed */
  maxFiles?: number
  /** Whether the upload is disabled */
  disabled?: boolean
  /** Additional CSS classes */
  className?: string
}

interface UploadingFile {
  file: File
  progress: number
  error?: string
}

/**
 * File upload component for evaluation module.
 * Supports multiple file uploads with progress tracking.
 */
export function EvaluationFileUpload({
  topicId,
  questionId,
  fileType,
  attachments,
  onChange,
  maxFiles = 10,
  disabled = false,
  className,
}: EvaluationFileUploadProps) {
  const { t } = useTranslation('evaluation')
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [uploadingFiles, setUploadingFiles] = useState<Map<string, UploadingFile>>(new Map())
  const [isDragging, setIsDragging] = useState(false)

  const handleFileSelect = useCallback(
    async (files: FileList | null) => {
      if (!files || files.length === 0) return
      if (disabled) return

      const remainingSlots = maxFiles - attachments.length
      if (remainingSlots <= 0) {
        return
      }

      const filesToUpload = Array.from(files).slice(0, remainingSlots)

      for (const file of filesToUpload) {
        const fileId = `${file.name}-${Date.now()}`

        // Add to uploading state
        setUploadingFiles(prev => {
          const newMap = new Map(prev)
          newMap.set(fileId, { file, progress: 0 })
          return newMap
        })

        try {
          const response = await uploadEvaluationFile(
            file,
            fileType,
            topicId,
            questionId,
            progress => {
              setUploadingFiles(prev => {
                const newMap = new Map(prev)
                const existing = newMap.get(fileId)
                if (existing) {
                  newMap.set(fileId, { ...existing, progress })
                }
                return newMap
              })
            }
          )

          // Add to attachments
          const newAttachment: EvalAttachment = {
            key: response.key,
            filename: file.name,
            file_size: file.size,
            content_type: file.type,
          }

          onChange([...attachments, newAttachment])

          // Remove from uploading state
          setUploadingFiles(prev => {
            const newMap = new Map(prev)
            newMap.delete(fileId)
            return newMap
          })
        } catch (error) {
          // Mark as error
          setUploadingFiles(prev => {
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
    },
    [topicId, questionId, fileType, attachments, onChange, maxFiles, disabled]
  )

  const handleRemove = useCallback(
    (key: string) => {
      onChange(attachments.filter(a => a.key !== key))
    },
    [attachments, onChange]
  )

  const handleRemoveUploading = useCallback((fileId: string) => {
    setUploadingFiles(prev => {
      const newMap = new Map(prev)
      newMap.delete(fileId)
      return newMap
    })
  }, [])

  const handleDownload = useCallback(async (attachment: EvalAttachment) => {
    try {
      await downloadEvaluationFile(attachment.key, attachment.filename)
    } catch (error) {
      console.error('Download failed:', error)
    }
  }, [])

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      setIsDragging(false)
      handleFileSelect(e.dataTransfer.files)
    },
    [handleFileSelect]
  )

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(true)
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
  }, [])

  const _isUploading = uploadingFiles.size > 0 // Reserved for future loading state display
  const canAddMore = attachments.length < maxFiles && !disabled

  return (
    <div className={cn('space-y-3', className)}>
      {/* Drop zone */}
      {canAddMore && (
        <div
          className={cn(
            'flex min-h-[100px] cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed p-4 transition-colors',
            isDragging
              ? 'border-primary bg-primary/5'
              : 'border-border hover:border-primary/50 hover:bg-surface/50',
            disabled && 'cursor-not-allowed opacity-50'
          )}
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onClick={() => !disabled && fileInputRef.current?.click()}
        >
          <Upload className="mb-2 h-6 w-6 text-text-muted" />
          <p className="text-sm text-text-secondary">
            {t('questions.drag_drop_hint', 'Drag & drop files or click to browse')}
          </p>
          <p className="mt-1 text-xs text-text-muted">
            {t('questions.max_files', { count: maxFiles - attachments.length })}
          </p>
        </div>
      )}

      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={e => handleFileSelect(e.target.files)}
        disabled={disabled}
      />

      {/* Uploading files */}
      {Array.from(uploadingFiles.entries()).map(([fileId, { file, progress, error }]) => (
        <div
          key={fileId}
          className={cn(
            'flex items-center gap-3 rounded-lg border p-3',
            error ? 'border-destructive bg-destructive/5' : 'border-border bg-surface'
          )}
        >
          {error ? (
            <X className="h-5 w-5 text-destructive" />
          ) : (
            <Loader2 className="h-5 w-5 animate-spin text-primary" />
          )}
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{file.name}</p>
            {error ? (
              <p className="text-xs text-destructive">{error}</p>
            ) : (
              <Progress value={progress} className="mt-1 h-1" />
            )}
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={() => handleRemoveUploading(fileId)}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      ))}

      {/* Uploaded attachments */}
      {attachments.map(attachment => (
        <div
          key={attachment.key}
          className="flex items-center gap-3 rounded-lg border border-border bg-surface p-3"
        >
          <File className="h-5 w-5 text-text-secondary" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{attachment.filename}</p>
            {attachment.file_size && (
              <p className="text-xs text-text-muted">{formatFileSize(attachment.file_size)}</p>
            )}
          </div>
          <div className="flex gap-1">
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={() => handleDownload(attachment)}
              title={t('actions.download', 'Download')}
            >
              <Download className="h-4 w-4" />
            </Button>
            {!disabled && (
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 text-destructive hover:text-destructive"
                onClick={() => handleRemove(attachment.key)}
                title={t('actions.delete', 'Delete')}
              >
                <X className="h-4 w-4" />
              </Button>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}
