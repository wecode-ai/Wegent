// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import {
  Upload,
  Edit3,
  History,
  File,
  Download,
  ChevronDown,
  ChevronUp,
  Send,
  FileText,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Textarea } from '@/components/ui/textarea'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { SlotBasedFileUpload } from '@wecode/components/evaluation/exam/SlotBasedFileUpload'
import { useTranslation } from '@/hooks/useTranslation'
import { useIsMobile } from '@/features/layout/hooks/useMediaQuery'
import { MAX_BATCH_FILES } from '@/hooks/useBatchAttachment'
import { formatFileSize } from '@/apis/attachments'
import type { EvalAttachment, Answer } from '@wecode/types/evaluation'
import type { ExamAttachment } from '@wecode/types/evaluation-exam'

interface AnswerPanelProps {
  answerText: string
  attachments: EvalAttachment[]
  showTextInput: boolean
  onTextChange: (text: string) => void
  onAttachmentsChange: (attachments: EvalAttachment[]) => void
  onToggleTextInput: () => void
  lastSubmittedAnswer: Answer | null
  showLastSubmitted: boolean
  onToggleLastSubmitted: () => void
  isSubmitting: boolean
  isEmpty: boolean
  lastSaved: string | null
  onSubmitClick: () => void
  topicId: number
  questionId: number
  isResubmit: boolean
}

export function AnswerPanel({
  answerText,
  attachments,
  showTextInput,
  onTextChange,
  onAttachmentsChange,
  onToggleTextInput,
  lastSubmittedAnswer,
  showLastSubmitted,
  onToggleLastSubmitted,
  isSubmitting,
  isEmpty,
  lastSaved,
  onSubmitClick,
  topicId,
  questionId,
  isResubmit,
}: AnswerPanelProps) {
  const { t } = useTranslation('evaluation')
  const isMobile = useIsMobile()

  const lastSubmittedAttachments = lastSubmittedAnswer?.content_data?.attachments as
    | Array<{ key: string; filename: string; file_size?: number }>
    | undefined

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
      onAttachmentsChange(newAttachments as unknown as EvalAttachment[])
    }
  }

  // Last Submitted Section
  const lastSubmittedSection = lastSubmittedAnswer && (
    <Card className={`${isMobile ? 'mb-4' : ''} border-blue-200 bg-blue-50/50`}>
      <Collapsible open={showLastSubmitted} onOpenChange={onToggleLastSubmitted}>
        <CollapsibleTrigger asChild>
          <button
            className={`w-full flex items-center justify-between text-left hover:bg-blue-50/80 transition-colors ${
              isMobile ? 'p-3' : 'p-4 rounded-t-lg'
            }`}
          >
            <div className="flex items-center gap-2 text-blue-900">
              <History className="h-4 w-4" />
              <span className={`font-medium ${isMobile ? 'text-sm' : 'text-sm'}`}>
                {t('ui.last_submitted')}
              </span>
              <span className={`text-blue-600 ${isMobile ? 'text-xs font-normal' : 'text-xs'}`}>
                (
                {new Date(lastSubmittedAnswer.submitted_at).toLocaleString('zh-CN', {
                  month: 'short',
                  day: 'numeric',
                  hour: '2-digit',
                  minute: '2-digit',
                })}
                )
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span className={`text-blue-600 ${isMobile ? 'text-sm' : 'text-sm'}`}>
                {showLastSubmitted ? t('actions.collapse') : t('actions.expand')}
              </span>
              {showLastSubmitted ? (
                <ChevronUp className="h-4 w-4 text-blue-600" />
              ) : (
                <ChevronDown className="h-4 w-4 text-blue-600" />
              )}
            </div>
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <CardContent className={`pt-0 ${isMobile ? 'pb-3 px-3' : 'pb-4 px-4'} space-y-3`}>
            {typeof lastSubmittedAnswer.content_data?.text === 'string' && (
              <div
                className={`rounded-lg bg-white border border-blue-100 ${isMobile ? 'p-3' : 'p-3'}`}
              >
                <p className="text-sm text-text-secondary mb-2">{t('ui.text_answer')}：</p>
                <p className="text-sm text-text-primary whitespace-pre-wrap">
                  {lastSubmittedAnswer.content_data.text}
                </p>
              </div>
            )}
            {lastSubmittedAttachments && lastSubmittedAttachments.length > 0 && (
              <div className="space-y-2">
                <p className="text-sm text-text-secondary">
                  {t('ui.attachments')} ({lastSubmittedAttachments.length})：
                </p>
                <div className="space-y-2">
                  {lastSubmittedAttachments.map((attachment, index) => (
                    <a
                      key={attachment.key || index}
                      href={`/api/evaluation/respondent/files/${attachment.key}?filename=${encodeURIComponent(attachment.filename)}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className={`flex items-center gap-3 rounded-lg border border-blue-100 bg-white hover:bg-blue-50 transition-colors group ${
                        isMobile ? 'p-2 gap-2' : 'p-3'
                      }`}
                    >
                      <File className="h-4 w-4 text-blue-600" />
                      <span className="text-sm text-text-primary truncate flex-1">
                        {attachment.filename}
                      </span>
                      {attachment.file_size && (
                        <span className="text-xs text-text-muted">
                          {formatFileSize(attachment.file_size)}
                        </span>
                      )}
                      <Download
                        className={`h-4 w-4 text-blue-600 ${
                          isMobile ? '' : 'opacity-0 group-hover:opacity-100'
                        } transition-opacity`}
                      />
                    </a>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  )

  // Text Input Section
  const textInputSection = (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-text-secondary">
          {t('answers.text_supplement')}
        </span>
        {isMobile ? (
          <button onClick={onToggleTextInput} className="text-sm text-text-muted">
            {showTextInput ? t('actions.collapse') : t('actions.expand')}
          </button>
        ) : (
          <Button variant="ghost" size="sm" onClick={onToggleTextInput}>
            {showTextInput ? t('actions.collapse') : t('actions.expand')}
          </Button>
        )}
      </div>
      {showTextInput && (
        <Textarea
          value={answerText}
          onChange={e => onTextChange(e.target.value)}
          placeholder={t('answers.content_placeholder')}
          className={`resize-y ${isMobile ? 'min-h-[100px]' : 'min-h-[150px]'}`}
        />
      )}
    </div>
  )

  // Submit Button
  const submitButton = (
    <Button
      variant="primary"
      onClick={onSubmitClick}
      disabled={isSubmitting || isEmpty}
      className={`${isMobile ? 'w-full h-11' : 'h-11 px-8'}`}
    >
      {!isMobile && <Send className="h-4 w-4 mr-2" />}
      {isSubmitting ? t('actions.submitting') : t('answers.submit')}
    </Button>
  )

  if (isMobile) {
    return (
      <div className="border-t border-border bg-surface p-4">
        {lastSubmittedSection}

        <h2 className="mb-3 text-base font-medium">
          {isResubmit ? t('ui.resubmit') : t('ui.submit_answer')}
        </h2>

        {/* Upload Area */}
        <Card className="mb-4 border-dashed">
          <CardContent className="p-4">
            <div className="flex flex-col items-center gap-2 text-center">
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

        {/* Text Input */}
        {textInputSection}

        {/* Submit */}
        {submitButton}
      </div>
    )
  }

  // Desktop Layout
  return (
    <div className="overflow-y-auto bg-surface">
      {/* Panel Header */}
      <div className="sticky top-0 z-10 bg-surface border-b border-border px-8 py-4 flex items-center gap-2">
        <Edit3 className="h-5 w-5 text-primary" />
        <span className="font-medium text-text-primary">{t('ui.answer_area')}</span>
      </div>

      <div className="max-w-2xl mx-auto p-8 space-y-6">
        {lastSubmittedSection}

        {/* New Answer Form */}
        <Card className="border-0 shadow-sm">
          <CardHeader className="pb-4">
            <CardTitle className="text-lg font-semibold flex items-center gap-2">
              <Upload className="h-5 w-5 text-primary" />
              {isResubmit ? t('ui.resubmit') : t('ui.submit_answer')}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            {/* File Upload */}
            <div className="space-y-3">
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

            <div className="h-px bg-border" />

            {/* Text Input */}
            {textInputSection}

            {/* Submit Button */}
            <div className="flex items-center justify-between pt-4">
              <div className="text-xs text-text-muted">
                {lastSaved && (
                  <span>
                    {t('answers.auto_saved')}{' '}
                    {new Date(lastSaved).toLocaleTimeString('zh-CN', {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </span>
                )}
              </div>
              {submitButton}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
