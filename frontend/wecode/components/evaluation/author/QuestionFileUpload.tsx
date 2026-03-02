// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { FileText, ClipboardList, BookOpen } from 'lucide-react'
import { SlotBasedFileUpload } from '@wecode/components/evaluation/exam/SlotBasedFileUpload'
import type { EvalAttachment } from '@wecode/types/evaluation'

interface QuestionFileUploadProps {
  /** Topic ID for file uploads */
  topicId: number
  /** Question ID (undefined for new questions) */
  questionId?: number
  /** Content attachments */
  contentAttachments: EvalAttachment[]
  /** Criteria attachments */
  criteriaAttachments: EvalAttachment[]
  /** Instructions attachments */
  instructionsAttachments: EvalAttachment[]
  /** Callback when content attachments change */
  onContentAttachmentsChange: (files: EvalAttachment[]) => void
  /** Callback when criteria attachments change */
  onCriteriaAttachmentsChange: (files: EvalAttachment[]) => void
  /** Callback when instructions attachments change */
  onInstructionsAttachmentsChange: (files: EvalAttachment[]) => void
  /** Whether the upload is disabled */
  disabled?: boolean
}

/** Upload slot configurations for question authoring */
const QUESTION_UPLOAD_SLOTS = [
  {
    key: 'content',
    label: '题目内容附件',
    hint: '支持 PDF、Word、图片等格式，最多可上传 10 个文件',
    maxFiles: 10,
    accept: '.pdf,.doc,.docx,.txt,.md,.png,.jpg,.jpeg,.gif,.webp,.html,.json',
    icon: <FileText className="h-[18px] w-[18px] text-blue-500" />,
  },
  {
    key: 'criteria',
    label: '评分标准附件',
    hint: '支持 PDF、Word、图片等格式，最多可上传 10 个文件',
    maxFiles: 10,
    accept: '.pdf,.doc,.docx,.txt,.md,.png,.jpg,.jpeg,.gif,.webp',
    icon: <ClipboardList className="h-[18px] w-[18px] text-emerald-500" />,
  },
  {
    key: 'instructions',
    label: '考试须知附件',
    hint: '支持 PDF、Word、图片等格式，最多可上传 10 个文件',
    maxFiles: 10,
    accept: '.pdf,.doc,.docx,.txt,.md,.png,.jpg,.jpeg,.gif,.webp',
    icon: <BookOpen className="h-[18px] w-[18px] text-amber-500" />,
  },
]

/**
 * File upload section for question authoring using SlotBasedFileUpload.
 * Provides 3 upload zones for different question content types:
 * 1. Content attachments - Question content files
 * 2. Criteria attachments - Grading criteria files
 * 3. Instructions attachments - Exam instructions files
 */
export function QuestionFileUpload({
  topicId,
  questionId,
  contentAttachments,
  criteriaAttachments,
  instructionsAttachments,
  onContentAttachmentsChange,
  onCriteriaAttachmentsChange,
  onInstructionsAttachmentsChange,
  disabled = false,
}: QuestionFileUploadProps) {
  // Build attachments record for SlotBasedFileUpload
  // Note: EvalAttachment is compatible with ExamAttachment
  const attachments = {
    content:
      contentAttachments as unknown as import('@wecode/types/evaluation-exam').ExamAttachment[],
    criteria:
      criteriaAttachments as unknown as import('@wecode/types/evaluation-exam').ExamAttachment[],
    instructions:
      instructionsAttachments as unknown as import('@wecode/types/evaluation-exam').ExamAttachment[],
  }

  // Handle slot changes
  const handleChange = (
    slot: string,
    newAttachments: import('@wecode/types/evaluation-exam').ExamAttachment[]
  ) => {
    const files = newAttachments as unknown as EvalAttachment[]
    switch (slot) {
      case 'content':
        onContentAttachmentsChange(files)
        break
      case 'criteria':
        onCriteriaAttachmentsChange(files)
        break
      case 'instructions':
        onInstructionsAttachmentsChange(files)
        break
    }
  }

  // Calculate total file count
  const totalCount =
    contentAttachments.length + criteriaAttachments.length + instructionsAttachments.length

  return (
    <SlotBasedFileUpload
      topicId={topicId}
      questionId={questionId || 0}
      slots={QUESTION_UPLOAD_SLOTS}
      attachments={attachments}
      onChange={handleChange}
      disabled={disabled}
      totalFileLimit={30}
      currentTotalCount={totalCount}
    />
  )
}
