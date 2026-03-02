// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { FileText, Pen, Workflow, Layers } from 'lucide-react'
import { SlotBasedFileUpload } from './SlotBasedFileUpload'
import type { ExamAttachment } from '@wecode/types/evaluation-exam'

interface FileUploadSectionProps {
  /** Topic ID for file uploads */
  topicId: number
  /** Question ID for file uploads */
  questionId: number
  /** Main report files */
  mainFiles: ExamAttachment[]
  /** Interaction record files */
  interactionFiles: ExamAttachment[]
  /** Bonus agent deployment link */
  bonusAgentLink: string
  /** Bonus agent supporting files */
  bonusAgentFiles: ExamAttachment[]
  /** Bonus multimodal files */
  bonusMultimodalFiles: ExamAttachment[]
  /** Callback when main files change */
  onMainFilesChange: (files: ExamAttachment[]) => void
  /** Callback when interaction files change */
  onInteractionFilesChange: (files: ExamAttachment[]) => void
  /** Callback when bonus agent link changes */
  onBonusAgentLinkChange: (link: string) => void
  /** Callback when bonus agent files change */
  onBonusAgentFilesChange: (files: ExamAttachment[]) => void
  /** Callback when bonus multimodal files change */
  onBonusMultimodalFilesChange: (files: ExamAttachment[]) => void
  /** Callback for real-time attachments update to backend */
  onAttachmentsUpdate?: (attachments: {
    main: ExamAttachment[]
    interaction: ExamAttachment[]
    bonusAgent: ExamAttachment[]
    bonusMultimodal: ExamAttachment[]
  }) => void
  /** Current total file count (including files outside this component) */
  currentTotalCount?: number
  /** Whether the upload section is disabled */
  disabled?: boolean
}

/** Upload slot configurations */
const UPLOAD_SLOTS = [
  {
    key: 'main',
    label: '考核报告 / 方案文档',
    hint: '支持 PDF、Word、TXT 等格式，最多可上传 20 个文件',
    required: true,
    maxFiles: 20,
    accept: '.pdf,.doc,.docx,.txt,.md,.rtf,.pages',
    icon: <FileText className="h-[18px] w-[18px] text-[#DF2029]" />,
  },
  {
    key: 'interaction',
    label: '交互过程记录',
    hint: '支持 PDF、图片、文本等格式，最多可上传 20 个文件',
    maxFiles: 20,
    accept: '.pdf,.doc,.docx,.txt,.md,.png,.jpg,.jpeg,.gif,.webp,.html,.json',
    icon: <Pen className="h-[18px] w-[18px] text-gray-400" />,
  },
  {
    key: 'bonusAgent',
    label: '附加题一：Agent / 工作流',
    hint: '支持图片、PDF、文档等格式，最多可上传 20 个文件',
    maxFiles: 20,
    accept: '.pdf,.doc,.docx,.png,.jpg,.jpeg,.gif,.webp,.pptx,.ppt,.html',
    icon: <Workflow className="h-[18px] w-[18px] text-indigo-500" />,
    showLinkInput: true,
    linkLabel: 'Agent 分享链接',
    linkPlaceholder: '粘贴可访问/可运行的 Agent 分享链接',
  },
  {
    key: 'bonusMultimodal',
    label: '附加题二：多模态交付物',
    hint: '支持 PPTX、PDF、图片、MP4 等格式，最多可上传 20 个文件',
    maxFiles: 20,
    accept: '.pptx,.ppt,.pdf,.doc,.docx,.png,.jpg,.jpeg,.gif,.webp,.mp4,.mov,.avi,.svg',
    icon: <Layers className="h-[18px] w-[18px] text-rose-500" />,
  },
]

/**
 * File upload section for exam submission using SlotBasedFileUpload.
 * Provides 4 upload zones for different deliverable types:
 * 1. Main report (required) - PDF, Word, TXT
 * 2. Interaction records (optional) - PDF, images, TXT
 * 3. Bonus Agent - Link input + file upload
 * 4. Bonus Multimodal - PPT, PDF, images, video
 */
export function FileUploadSection({
  topicId,
  questionId,
  mainFiles,
  interactionFiles,
  bonusAgentLink,
  bonusAgentFiles,
  bonusMultimodalFiles,
  onMainFilesChange,
  onInteractionFilesChange,
  onBonusAgentLinkChange,
  onBonusAgentFilesChange,
  onBonusMultimodalFilesChange,
  onAttachmentsUpdate,
  currentTotalCount = 0,
  disabled = false,
}: FileUploadSectionProps) {
  // Build attachments record for SlotBasedFileUpload
  const attachments = {
    main: mainFiles,
    interaction: interactionFiles,
    bonusAgent: bonusAgentFiles,
    bonusMultimodal: bonusMultimodalFiles,
  }

  // Build link values for slots with showLinkInput
  const linkValues = {
    bonusAgent: bonusAgentLink,
  }

  // Handle slot changes
  const handleChange = (slot: string, newAttachments: ExamAttachment[]) => {
    switch (slot) {
      case 'main':
        onMainFilesChange(newAttachments)
        break
      case 'interaction':
        onInteractionFilesChange(newAttachments)
        break
      case 'bonusAgent':
        onBonusAgentFilesChange(newAttachments)
        break
      case 'bonusMultimodal':
        onBonusMultimodalFilesChange(newAttachments)
        break
    }
  }

  // Handle real-time attachments update
  const handleAttachmentsUpdate = (newAttachments: Record<string, ExamAttachment[]>) => {
    onAttachmentsUpdate?.({
      main: newAttachments.main || [],
      interaction: newAttachments.interaction || [],
      bonusAgent: newAttachments.bonusAgent || [],
      bonusMultimodal: newAttachments.bonusMultimodal || [],
    })
  }

  // Handle link changes
  const handleLinkChange = (slot: string, value: string) => {
    if (slot === 'bonusAgent') {
      onBonusAgentLinkChange(value)
    }
  }

  return (
    <section className="slide-down">
      <div className="flex items-center gap-3 mb-6">
        <div className="w-1.5 h-7 bg-emerald-500 rounded-full" />
        <h2 className="text-xl font-bold text-gray-900">提交材料</h2>
      </div>
      <SlotBasedFileUpload
        topicId={topicId}
        questionId={questionId}
        slots={UPLOAD_SLOTS}
        attachments={attachments}
        onChange={handleChange}
        onAttachmentsUpdate={handleAttachmentsUpdate}
        linkValues={linkValues}
        onLinkChange={handleLinkChange}
        disabled={disabled}
        totalFileLimit={20}
        currentTotalCount={currentTotalCount}
      />
    </section>
  )
}
