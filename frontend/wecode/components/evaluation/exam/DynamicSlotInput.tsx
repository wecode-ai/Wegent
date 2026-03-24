// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useCallback, useRef, useMemo, useEffect } from 'react'
import { FileText, Loader2, X, Download, Eye, EyeOff, Link2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { Input } from '@/components/ui/input'
import { cn, sanitizeFilename } from '@/lib/utils'
import {
  uploadEvaluationFile,
  downloadEvaluationFile,
  fetchFileContent,
  type EvalFileType,
} from '@wecode/api/evaluation-shared'
import type { ExamAttachment, AnswerSlot, SlotAnswer } from '@wecode/types/evaluation-exam'
import { useTranslation } from '@/hooks/useTranslation'
import { Icon } from './ExamIcons'
import { SlotMarkdownContent } from './SlotMarkdownContent'
import { useTheme } from '@/features/theme/ThemeProvider'
import EnhancedMarkdown from '@/components/common/EnhancedMarkdown'

interface DynamicSlotInputProps {
  slot: AnswerSlot
  value: SlotAnswer
  onChange: (value: SlotAnswer) => void
  disabled?: boolean
  topicId: number
  questionId: number
  /** Callback when text/link field changes (for debounced auto-save) */
  onTextChange?: () => void
  /** Save status for text input */
  saveStatus?: 'idle' | 'saving' | 'saved' | 'error'
  /** Last saved timestamp */
  lastSavedAt?: Date | null
}

interface UploadingFile {
  file: File
  progress: number
  error?: string
}

const FILE_TYPE: EvalFileType = 'exam_attachment'

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1048576).toFixed(1)} MB`
}

/**
 * Dynamic slot input component for exam answer collection.
 * Renders different input types based on slot configuration:
 * - attachment: file upload only
 * - text: text input with Markdown preview (styled like SupplementaryNotesSection)
 * - link+attachment: link input and file upload
 */
export function DynamicSlotInput({
  slot,
  value,
  onChange,
  disabled = false,
  topicId,
  questionId,
  onTextChange,
  saveStatus = 'idle',
  lastSavedAt,
}: DynamicSlotInputProps) {
  const { t } = useTranslation('evaluation')
  const { theme } = useTheme()
  const [uploadingFiles, setUploadingFiles] = useState<Map<string, UploadingFile>>(new Map())
  const [isDragOver, setIsDragOver] = useState(false)
  // When disabled (e.g., after exam ends), default to preview mode to show full content
  const [showPreview, setShowPreview] = useState(disabled)
  // Loading state for fetching text from S3 attachment
  const [loadingFromS3, setLoadingFromS3] = useState(false)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  // Auto-switch to preview mode when disabled changes to true (e.g., exam ends)
  useEffect(() => {
    if (disabled) {
      setShowPreview(true)
    }
  }, [disabled])

  // Determine which inputs to show based on inputMode
  const showText = slot.inputMode === 'text'
  const showLink = slot.inputMode === 'link+attachment'
  const showAttachment = slot.inputMode === 'attachment' || slot.inputMode === 'link+attachment'

  const currentFiles = useMemo(() => value.files || [], [value.files])
  const maxFiles = slot.maxFiles || 10
  const canAddMore = currentFiles.length < maxFiles && !disabled

  // Check if there's a .txt file in the attachments (for loading text from S3)
  const txtAttachment = useMemo(() => {
    if (showText && currentFiles.length > 0) {
      return currentFiles.find(f => f.filename.endsWith('.txt'))
    }
    return undefined
  }, [showText, currentFiles])

  // Load text from S3 attachment if exists and text field is empty
  // Note: Load regardless of disabled state - text may have been converted to S3 during review phase
  useEffect(() => {
    if (txtAttachment && !value.text && !loadingFromS3) {
      setLoadingFromS3(true)
      fetchFileContent(txtAttachment.key)
        .then(content => {
          onChange({ ...value, text: content })
        })
        .catch(error => {
          console.error('Failed to load text from S3:', error)
        })
        .finally(() => {
          setLoadingFromS3(false)
        })
    }
  }, [txtAttachment, value, loadingFromS3, onChange])

  const handleTextChange = useCallback(
    (newText: string) => {
      onChange({ ...value, text: newText })
      // Trigger debounced auto-save
      onTextChange?.()
    },
    [value, onChange, onTextChange]
  )

  const handleLinkChange = useCallback(
    (newLink: string) => {
      onChange({ ...value, link: newLink })
      // Trigger debounced auto-save for link changes too
      onTextChange?.()
    },
    [value, onChange, onTextChange]
  )

  const handleFileSelect = useCallback(
    async (files: FileList | null) => {
      if (!files || files.length === 0 || disabled) return

      const remainingSlots = maxFiles - currentFiles.length
      if (remainingSlots <= 0) return

      const filesToUpload = Array.from(files).slice(0, remainingSlots)
      const uploadedAttachments: ExamAttachment[] = []

      for (const file of filesToUpload) {
        // Sanitize filename to remove zero-width and invisible Unicode characters
        const sanitizedName = sanitizeFilename(file.name)
        // Create a new File object with sanitized name if different
        const fileToUpload =
          sanitizedName !== file.name ? new File([file], sanitizedName, { type: file.type }) : file

        const fileId = `${sanitizedName}-${Date.now()}-${Math.random()}`

        setUploadingFiles(prev => {
          const newMap = new Map(prev)
          newMap.set(fileId, { file: fileToUpload, progress: 0 })
          return newMap
        })

        try {
          const response = await uploadEvaluationFile(
            fileToUpload,
            FILE_TYPE,
            topicId,
            questionId,
            slot.key,
            (progress: number) => {
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

          const newAttachment: ExamAttachment = {
            key: response.key,
            filename: sanitizedName,
            size: fileToUpload.size,
            content_type: fileToUpload.type,
          }
          uploadedAttachments.push(newAttachment)

          setUploadingFiles(prev => {
            const newMap = new Map(prev)
            newMap.delete(fileId)
            return newMap
          })
        } catch (error) {
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

      if (uploadedAttachments.length > 0) {
        onChange({
          ...value,
          files: [...currentFiles, ...uploadedAttachments],
        })
      }
    },
    [topicId, questionId, slot.key, maxFiles, currentFiles, disabled, onChange, value]
  )

  const handleRemove = useCallback(
    (key: string) => {
      onChange({
        ...value,
        files: currentFiles.filter(f => f.key !== key),
      })
    },
    [value, currentFiles, onChange]
  )

  const handleRemoveUploading = useCallback((fileId: string) => {
    setUploadingFiles(prev => {
      const newMap = new Map(prev)
      newMap.delete(fileId)
      return newMap
    })
  }, [])

  const handleDownload = useCallback(async (attachment: ExamAttachment) => {
    try {
      await downloadEvaluationFile(attachment.key, attachment.filename)
    } catch (error) {
      console.error('Download failed:', error)
    }
  }, [])

  // Text mode - render like SupplementaryNotesSection
  if (showText) {
    return (
      <div className="space-y-4">
        {/* Hint - rendered with Markdown support */}
        {slot.hint && <SlotMarkdownContent content={slot.hint} />}

        {/* Loading indicator when fetching from S3 */}
        {loadingFromS3 && (
          <div className="flex items-center gap-2 text-sm text-gray-500">
            <Loader2 className="w-4 h-4 animate-spin" />
            {t('slots.loading_content')}
          </div>
        )}

        {/* Edit/Preview Toggle */}
        <div className="flex items-center justify-between">
          <span className="text-sm text-gray-500">
            {showPreview ? t('slots.preview_mode') : t('slots.edit_mode')}
            {t('slots.markdown_auto_save_hint')}
          </span>
          {!disabled && (
            <button
              onClick={() => setShowPreview(!showPreview)}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-[#DF2029] bg-red-50 hover:bg-red-100 rounded-lg transition"
            >
              {showPreview ? (
                <>
                  <EyeOff className="w-4 h-4" />
                  {t('common:actions.edit')}
                </>
              ) : (
                <>
                  <Eye className="w-4 h-4" />
                  {t('slots.preview')}
                </>
              )}
            </button>
          )}
        </div>

        {/* Content Area */}
        {showPreview ? (
          <div className="min-h-[200px] rounded-2xl border border-gray-200 bg-gray-50 p-5">
            {(value.text || '').trim() ? (
              <div className="markdown-content">
                <EnhancedMarkdown
                  source={value.text || ''}
                  theme={theme === 'dark' ? 'dark' : 'light'}
                />
              </div>
            ) : (
              <p className="text-gray-400 text-center py-8">{t('slots.no_content')}</p>
            )}
          </div>
        ) : (
          <textarea
            value={value.text || ''}
            onChange={e => handleTextChange(e.target.value)}
            placeholder={t('answers.text_placeholder')}
            disabled={disabled || loadingFromS3}
            className="w-full min-h-[200px] px-5 py-4 rounded-2xl border border-gray-200 text-[1rem] leading-[1.8] resize-y transition placeholder:text-gray-300 disabled:opacity-50 disabled:bg-gray-50 font-mono text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#DF2029]"
          />
        )}

        {/* Character Count and Save Status */}
        <div className="flex justify-between items-center">
          <div className="flex items-center gap-3">
            <span className="text-sm text-gray-400">
              {(value.text || '').length} {t('slots.characters')}
            </span>
            {/* Save Status Indicator */}
            {!disabled && !showPreview && (
              <span className="flex items-center gap-1.5 text-xs">
                {saveStatus === 'saving' && (
                  <>
                    <span className="w-1.5 h-1.5 rounded-full bg-yellow-400 animate-pulse" />
                    <span className="text-yellow-600">{t('slots.saving')}</span>
                  </>
                )}
                {saveStatus === 'saved' && (
                  <>
                    <svg
                      className="w-3.5 h-3.5 text-green-500"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M5 13l4 4L19 7"
                      />
                    </svg>
                    <span className="text-green-600">
                      {t('slots.saved')}
                      {lastSavedAt
                        ? ` ${lastSavedAt.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`
                        : ''}
                    </span>
                  </>
                )}
                {saveStatus === 'error' && (
                  <>
                    <svg
                      className="w-3.5 h-3.5 text-red-500"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                      />
                    </svg>
                    <span className="text-red-600">{t('slots.save_failed')}</span>
                  </>
                )}
              </span>
            )}
          </div>
          <div className="flex items-center gap-3">
            {!disabled && !showPreview && (
              <span className="text-xs text-gray-400">{t('slots.markdown_syntax_hint')}</span>
            )}
          </div>
        </div>
      </div>
    )
  }

  // Attachment-only or Link+Attachment mode
  return (
    <div className="space-y-3">
      {/* Header */}
      <div className="flex items-center gap-2">
        <Icon name={slot.icon as keyof typeof Icon} size={18} className="text-gray-400" />
        <h3 className="text-base font-bold text-gray-700 flex items-center gap-2">
          {slot.label}
          {slot.required && (
            <span className="text-[#DF2029] text-sm font-normal">({t('slots.required')})</span>
          )}
          {!slot.required && slot.required !== undefined && (
            <span className="text-sm text-gray-400 font-normal">({t('slots.optional')})</span>
          )}
        </h3>
      </div>

      {/* Hint - rendered with Markdown support */}
      {slot.hint && <SlotMarkdownContent content={slot.hint} />}

      {/* Link Input - for link+attachment mode */}
      {showLink && (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Link2 size={18} className="text-gray-300 flex-shrink-0" />
            <Input
              type="url"
              value={value.link || ''}
              onChange={e => handleLinkChange(e.target.value)}
              placeholder={t('answers.link_placeholder')}
              disabled={disabled}
              className="flex-1 px-4 py-3 rounded-xl border border-gray-200 bg-white text-[1rem] text-gray-900 transition placeholder:text-gray-300 disabled:opacity-50 disabled:bg-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#DF2029]"
            />
          </div>
        </div>
      )}

      {/* File Upload Zone */}
      {showAttachment && canAddMore && (
        <div
          className={cn(
            'rounded-2xl border-2 border-dashed p-6 transition-all duration-200 cursor-pointer',
            isDragOver
              ? 'border-[#c81d25] bg-red-100 border-solid'
              : 'border-gray-200 hover:border-[#DF2029] hover:bg-red-50',
            disabled && 'opacity-50 pointer-events-none'
          )}
          onDragOver={e => {
            e.preventDefault()
            setIsDragOver(true)
          }}
          onDragLeave={() => setIsDragOver(false)}
          onDrop={e => {
            e.preventDefault()
            setIsDragOver(false)
            handleFileSelect(e.dataTransfer.files)
          }}
          onClick={() => !disabled && fileInputRef.current?.click()}
        >
          <input
            ref={fileInputRef}
            type="file"
            className="hidden"
            multiple
            accept={slot.accept}
            onChange={e => {
              handleFileSelect(e.target.files)
              e.target.value = ''
            }}
          />
          <div className="flex flex-col items-center gap-3">
            <div className="w-12 h-12 rounded-full bg-red-50 flex items-center justify-center">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="24"
                height="24"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                className="text-[#DF2029]"
              >
                <path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242" />
                <path d="M12 12v9" />
                <path d="m16 16-4-4-4 4" />
              </svg>
            </div>
            <div className="text-center">
              <p className="text-base font-medium text-gray-700">{t('answers.upload_drag_hint')}</p>
              {slot.accept && (
                <p className="text-sm text-gray-400 mt-1">
                  {t('answers.accepted_formats')}: {slot.accept.replace(/\./g, '').toUpperCase()}
                </p>
              )}
            </div>
          </div>
        </div>
      )}

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
      {currentFiles.map(attachment => (
        <div
          key={attachment.key}
          className="flex items-center gap-3 rounded-lg border border-gray-200 bg-gray-50 p-3"
        >
          <FileText className="h-5 w-5 text-gray-400" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{attachment.filename}</p>
            {attachment.size && (
              <p className="text-xs text-gray-400">{formatFileSize(attachment.size)}</p>
            )}
          </div>
          <div className="flex gap-1">
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={() => handleDownload(attachment)}
              title="Download"
            >
              <Download className="h-4 w-4" />
            </Button>
            {!disabled && (
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 text-destructive hover:text-destructive"
                onClick={() => handleRemove(attachment.key)}
                title="Delete"
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
