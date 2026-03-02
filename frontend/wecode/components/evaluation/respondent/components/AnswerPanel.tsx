// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useCallback } from 'react'
import { Upload, Send, File, X, ChevronDown, ChevronUp, FileText } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { SlotBasedFileUpload } from '@wecode/components/evaluation/exam/SlotBasedFileUpload'
import { useTranslation } from '@/hooks/useTranslation'
import { formatFileSize } from '@/apis/attachments'
import { MAX_BATCH_FILES } from '@/hooks/useBatchAttachment'
import type { EvalAttachment } from '@wecode/types/evaluation'
import type { ExamAttachment } from '@wecode/types/evaluation-exam'

interface AnswerPanelProps {
  topicId: number
  questionId: number
  answerText: string
  setAnswerText: (text: string) => void
  attachments: EvalAttachment[]
  setAttachments: (attachments: EvalAttachment[]) => void
  onSubmit: () => void
  isSubmitting: boolean
  lastSaved: string | null
}

export function AnswerPanel({
  topicId,
  questionId,
  answerText,
  setAnswerText,
  attachments,
  setAttachments,
  onSubmit,
  isSubmitting,
  lastSaved,
}: AnswerPanelProps) {
  const { t } = useTranslation('evaluation')
  const [isTextInputOpen, setIsTextInputOpen] = useState(false)
  const [isDragging, setIsDragging] = useState(false)

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(true)
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
  }, [])

  // Upload slot configuration for answer attachments
  const ANSWER_UPLOAD_SLOTS = [
    {
      key: 'answer',
      label: t('answers.upload_title', 'Upload Answer Files'),
      hint: t('answers.upload_format_hint', 'Support PDF, Word, images, etc.'),
      maxFiles: MAX_BATCH_FILES,
      accept: '.pdf,.doc,.docx,.txt,.md,.png,.jpg,.jpeg,.gif,.webp,.html,.json',
      icon: <FileText className="h-[18px] w-[18px] text-blue-500" />,
    },
  ]

  // Convert EvalAttachment[] to ExamAttachment[] for SlotBasedFileUpload
  const examAttachments = {
    answer: attachments as unknown as ExamAttachment[],
  }

  // Handle slot changes
  const handleSlotChange = (slot: string, newAttachments: ExamAttachment[]) => {
    if (slot === 'answer') {
      setAttachments(newAttachments as unknown as EvalAttachment[])
    }
  }

  const handleRemoveAttachment = (index: number) => {
    const newAttachments = [...attachments]
    newAttachments.splice(index, 1)
    setAttachments(newAttachments)
  }

  const isEmpty = answerText.trim().length === 0 && attachments.length === 0

  const formatSavedTime = (isoString: string | null) => {
    if (!isoString) return null
    const date = new Date(isoString)
    return (
      date.getHours().toString().padStart(2, '0') +
      ':' +
      date.getMinutes().toString().padStart(2, '0')
    )
  }

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto p-6">
      {/* File Upload Zone */}
      <Card
        className={`relative border-2 transition-colors ${
          isDragging
            ? 'border-primary bg-primary/5'
            : 'border-dashed border-border hover:border-primary/50'
        }`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
      >
        <CardContent className="p-6">
          <div className="flex flex-col items-center justify-center gap-3 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
              <Upload className="h-6 w-6 text-primary" />
            </div>
            <div>
              <p className="text-sm font-medium text-text-primary">
                {t('answers.upload_drag_hint')}
              </p>
              <p className="mt-1 text-xs text-text-muted">{t('answers.upload_format_hint')}</p>
            </div>
            <SlotBasedFileUpload
              topicId={topicId}
              questionId={questionId}
              slots={ANSWER_UPLOAD_SLOTS}
              attachments={examAttachments}
              onChange={handleSlotChange}
              disabled={isSubmitting}
              totalFileLimit={MAX_BATCH_FILES}
              currentTotalCount={attachments.length}
            />
          </div>
        </CardContent>
      </Card>

      {/* Uploaded Files List */}
      {attachments.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-sm font-medium text-text-secondary">
            {t('answers.uploaded_files')} ({attachments.length})
          </h3>
          <div className="space-y-2">
            {attachments.map((attachment, index) => (
              <div
                key={attachment.key || index}
                className="group flex items-center gap-3 rounded-lg border border-border bg-surface px-3 py-2"
              >
                <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded bg-primary/10">
                  <File className="h-4 w-4 text-primary" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm">{attachment.filename}</p>
                  {attachment.file_size && (
                    <p className="text-xs text-text-muted">
                      {formatFileSize(attachment.file_size)}
                    </p>
                  )}
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 flex-shrink-0 opacity-0 group-hover:opacity-100"
                  onClick={() => handleRemoveAttachment(index)}
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Text Input (Collapsible) */}
      <Card className="border-dashed">
        <CardContent className="p-0">
          <button
            onClick={() => setIsTextInputOpen(!isTextInputOpen)}
            className="flex w-full items-center justify-between px-4 py-3"
          >
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-text-secondary">
                {t('answers.text_supplement')}
              </span>
              <span className="text-xs text-text-muted">({t('common:optional')})</span>
            </div>
            {isTextInputOpen ? (
              <ChevronUp className="h-4 w-4 text-text-muted" />
            ) : (
              <ChevronDown className="h-4 w-4 text-text-muted" />
            )}
          </button>
          {isTextInputOpen && (
            <div className="border-t border-border px-4 pb-4 pt-2">
              <Textarea
                value={answerText}
                onChange={e => setAnswerText(e.target.value)}
                placeholder={t('answers.content_placeholder')}
                className="min-h-[120px] resize-y"
              />
            </div>
          )}
        </CardContent>
      </Card>

      {/* Submit Area */}
      <div className="mt-auto flex items-center justify-between border-t border-border pt-4">
        <div className="text-xs text-text-muted">
          {lastSaved && (
            <span>
              {t('answers.auto_saved')} {formatSavedTime(lastSaved)}
            </span>
          )}
        </div>
        <Button
          variant="primary"
          onClick={onSubmit}
          disabled={isSubmitting || isEmpty}
          className="min-w-[120px]"
        >
          <Send className="mr-2 h-4 w-4" />
          {isSubmitting ? '...' : t('answers.submit')}
        </Button>
      </div>
    </div>
  )
}
