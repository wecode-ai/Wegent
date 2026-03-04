// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useCallback, useRef, useMemo } from 'react'
import { FileText, Loader2, X, Download, Link2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { Input } from '@/components/ui/input'
import { cn, sanitizeFilename } from '@/lib/utils'
import {
  uploadEvaluationFile,
  downloadEvaluationFile,
  type EvalFileType,
} from '@wecode/api/evaluation-shared'
import type { ExamAttachment } from '@wecode/types/evaluation-exam'

interface UploadSlot {
  key: string
  label: string
  hint?: string
  required?: boolean
  maxFiles?: number
  accept?: string
  icon?: React.ReactNode
  /** Whether to show a link input for this slot */
  showLinkInput?: boolean
  linkLabel?: string
  linkPlaceholder?: string
}

interface SlotBasedFileUploadProps {
  topicId: number
  questionId: number
  slots: UploadSlot[]
  attachments: Record<string, ExamAttachment[]>
  onChange: (slot: string, attachments: ExamAttachment[]) => void
  onAttachmentsUpdate?: (attachments: Record<string, ExamAttachment[]>) => void
  disabled?: boolean
  /** Link values for slots that have showLinkInput enabled */
  linkValues?: Record<string, string>
  onLinkChange?: (slot: string, value: string) => void
  /** Total file limit across all slots */
  totalFileLimit?: number
  /** Current total file count (including files outside this component) */
  currentTotalCount?: number
  /** Callback when total limit is exceeded */
  onLimitExceeded?: () => void
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
 * Slot-based file upload component for exam submissions.
 * Each slot represents a specific attachment category (main report, interaction records, etc.)
 */
export function SlotBasedFileUpload({
  topicId,
  questionId,
  slots,
  attachments,
  onChange,
  onAttachmentsUpdate,
  disabled = false,
  linkValues = {},
  onLinkChange,
  totalFileLimit = 20,
  currentTotalCount = 0,
  onLimitExceeded,
}: SlotBasedFileUploadProps) {
  const [uploadingFiles, setUploadingFiles] = useState<Record<string, Map<string, UploadingFile>>>(
    {}
  )
  const [dragOverSlot, setDragOverSlot] = useState<string | null>(null)
  const fileInputRefs = useRef<Record<string, HTMLInputElement | null>>({})

  // Calculate total attachments count within this component
  const totalAttachmentsCount = useMemo(() => {
    return Object.values(attachments).reduce((sum, arr) => sum + arr.length, 0)
  }, [attachments])

  const handleFileSelect = useCallback(
    async (slotKey: string, files: FileList | null) => {
      if (!files || files.length === 0 || disabled) return

      const slot = slots.find(s => s.key === slotKey)
      if (!slot) return

      const currentAttachments = attachments[slotKey] || []
      const maxFiles = slot.maxFiles || 10
      const remainingSlots = maxFiles - currentAttachments.length

      if (remainingSlots <= 0) {
        return
      }

      // Check total file limit across all slots
      const totalFiles = currentTotalCount + totalAttachmentsCount
      const remainingTotal = totalFileLimit - totalFiles

      if (remainingTotal <= 0) {
        onLimitExceeded?.()
        return
      }

      const filesToUpload = Array.from(files).slice(0, Math.min(remainingSlots, remainingTotal))
      const uploadedAttachments: ExamAttachment[] = []

      for (const file of filesToUpload) {
        // Sanitize filename to remove zero-width and invisible Unicode characters
        const sanitizedName = sanitizeFilename(file.name)
        // Create a new File object with sanitized name if different
        const fileToUpload =
          sanitizedName !== file.name ? new File([file], sanitizedName, { type: file.type }) : file

        const fileId = `${sanitizedName}-${Date.now()}-${Math.random()}`

        setUploadingFiles(prev => {
          const newMap = new Map(prev[slotKey] || new Map())
          newMap.set(fileId, { file: fileToUpload, progress: 0 })
          return { ...prev, [slotKey]: newMap }
        })

        try {
          const response = await uploadEvaluationFile(
            fileToUpload,
            FILE_TYPE,
            topicId,
            questionId,
            slotKey,
            (progress: number) => {
              setUploadingFiles(prev => {
                const newMap = new Map(prev[slotKey] || new Map())
                const existing = newMap.get(fileId)
                if (existing) {
                  newMap.set(fileId, { ...existing, progress })
                }
                return { ...prev, [slotKey]: newMap }
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
            const newMap = new Map(prev[slotKey] || new Map())
            newMap.delete(fileId)
            return { ...prev, [slotKey]: newMap }
          })
        } catch (error) {
          setUploadingFiles(prev => {
            const newMap = new Map(prev[slotKey] || new Map())
            const existing = newMap.get(fileId)
            if (existing) {
              newMap.set(fileId, {
                ...existing,
                error: error instanceof Error ? error.message : 'Upload failed',
              })
            }
            return { ...prev, [slotKey]: newMap }
          })
        }
      }

      if (uploadedAttachments.length > 0) {
        const newAttachments = [...currentAttachments, ...uploadedAttachments]
        onChange(slotKey, newAttachments)
        // Notify parent to update backend
        onAttachmentsUpdate?.({ ...attachments, [slotKey]: newAttachments })
      }
    },
    [topicId, questionId, slots, attachments, onChange, onAttachmentsUpdate, disabled]
  )

  const handleRemove = useCallback(
    (slotKey: string, key: string) => {
      const currentAttachments = attachments[slotKey] || []
      const newAttachmentsForSlot = currentAttachments.filter(a => a.key !== key)
      onChange(slotKey, newAttachmentsForSlot)
      // Notify parent to update backend
      onAttachmentsUpdate?.({ ...attachments, [slotKey]: newAttachmentsForSlot })
    },
    [attachments, onChange, onAttachmentsUpdate]
  )

  const handleRemoveUploading = useCallback((slotKey: string, fileId: string) => {
    setUploadingFiles(prev => {
      const newMap = new Map(prev[slotKey] || new Map())
      newMap.delete(fileId)
      return { ...prev, [slotKey]: newMap }
    })
  }, [])

  const handleDownload = useCallback(async (attachment: ExamAttachment) => {
    try {
      await downloadEvaluationFile(attachment.key, attachment.filename)
    } catch (error) {
      console.error('Download failed:', error)
    }
  }, [])

  const renderUploadZone = (slot: UploadSlot) => {
    const slotAttachments = attachments[slot.key] || []
    const slotUploading = uploadingFiles[slot.key] || new Map()
    const canAddMore = slotAttachments.length < (slot.maxFiles || 10) && !disabled
    const isDragOver = dragOverSlot === slot.key

    const linkValue = linkValues[slot.key] || ''

    return (
      <div key={slot.key} className="space-y-3">
        <div className="flex items-center gap-2">
          {slot.icon}
          <h3 className="text-base font-bold text-gray-700 flex items-center gap-2">
            {slot.label}
            {slot.required && <span className="text-[#DF2029] text-sm font-normal">（必传）</span>}
            {!slot.required && slot.required !== undefined && (
              <span className="text-sm text-gray-400 font-normal">（选做）</span>
            )}
          </h3>
        </div>

        {/* Link Input */}
        {slot.showLinkInput && (
          <div className="space-y-2">
            <label className="block text-sm text-gray-500">{slot.linkLabel || '分享链接'}</label>
            <div className="flex items-center gap-2">
              <Link2 size={18} className="text-gray-300 flex-shrink-0" />
              <Input
                type="url"
                value={linkValue}
                onChange={e => onLinkChange?.(slot.key, e.target.value)}
                placeholder={slot.linkPlaceholder || '粘贴可访问的链接'}
                disabled={disabled}
                className="flex-1 px-4 py-3 rounded-xl border border-gray-200 bg-white text-[1rem] text-gray-900 focus:border-[#DF2029] focus:ring-2 focus:ring-red-100 transition placeholder:text-gray-300 disabled:opacity-50 disabled:bg-gray-100"
              />
            </div>
          </div>
        )}

        {canAddMore && (
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
              setDragOverSlot(slot.key)
            }}
            onDragLeave={() => setDragOverSlot(null)}
            onDrop={e => {
              e.preventDefault()
              setDragOverSlot(null)
              handleFileSelect(slot.key, e.dataTransfer.files)
            }}
            onClick={() => !disabled && fileInputRefs.current[slot.key]?.click()}
          >
            <input
              ref={el => {
                fileInputRefs.current[slot.key] = el
              }}
              type="file"
              className="hidden"
              multiple
              accept={slot.accept}
              onChange={e => {
                handleFileSelect(slot.key, e.target.files)
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
                <p className="text-base font-medium text-gray-700">点击选择或拖拽文件到此处</p>
                {slot.hint && <p className="text-sm text-gray-400 mt-1">{slot.hint}</p>}
              </div>
            </div>
          </div>
        )}

        {/* Uploading files */}
        {Array.from(slotUploading.entries()).map(([fileId, { file, progress, error }]) => (
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
              onClick={() => handleRemoveUploading(slot.key, fileId)}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        ))}

        {/* Uploaded attachments */}
        {slotAttachments.map(attachment => (
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
                title="下载"
              >
                <Download className="h-4 w-4" />
              </Button>
              {!disabled && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-destructive hover:text-destructive"
                  onClick={() => handleRemove(slot.key, attachment.key)}
                  title="删除"
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

  return (
    <section className="slide-down">
      <div className="flex items-center gap-3 mb-6">
        <div className="w-1.5 h-7 bg-emerald-500 rounded-full" />
        <h2 className="text-xl font-bold text-gray-900">提交材料</h2>
      </div>
      <div className="bg-white rounded-3xl shadow-sm border border-gray-100 p-7 sm:p-9 space-y-6">
        {slots.map((slot, index) => (
          <div key={slot.key}>
            {index > 0 && <hr className="border-gray-100 mb-6" />}
            {renderUploadZone(slot)}
          </div>
        ))}
      </div>
    </section>
  )
}
