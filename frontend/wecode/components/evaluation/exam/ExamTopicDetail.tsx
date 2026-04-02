// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { FileArchive } from 'lucide-react'
import { useToast } from '@/hooks/use-toast'
import { useTranslation } from '@/hooks/useTranslation'
import { ExamMarkdownContent } from './ExamMarkdownContent'
import { AttachmentList, type GenericAttachment } from '../common/AttachmentList'
import type { Topic } from './AIAssessmentTopicCard'

interface ExamTopicDetailProps {
  topic: Topic
}

/**
 * ExamTopicDetail - Displays topic details with exam styling
 * Renders title, markdown content, and material attachments in a single card
 */
export function ExamTopicDetail({ topic }: ExamTopicDetailProps) {
  const { t } = useTranslation('evaluation')
  const { toast } = useToast()

  if (!topic) return null

  const hasAttachments = topic.attachments && topic.attachments.length > 0

  // Convert ExamAttachment to GenericAttachment format
  const attachments: GenericAttachment[] = (topic.attachments || []).map(a => ({
    key: a.key,
    filename: a.filename,
    size: a.size,
    content_type: a.content_type,
  }))

  const handleDownloadSuccess = () => {
    toast({
      title: t('errors.download_success'),
      description: '',
    })
  }

  const handleDownloadError = (_attachment: GenericAttachment, error: unknown) => {
    toast({
      title: t('errors.download_failed'),
      description: error instanceof Error ? error.message : t('errors.download_failed'),
      variant: 'destructive',
    })
  }

  // Simple filename generator - just use the original filename
  const generateFilename = (attachment: GenericAttachment) => attachment.filename

  return (
    <div className="animate-[slideDown_0.35s_ease-out]">
      <div className="bg-white rounded-2xl shadow-md p-7 md:p-9">
        {/* Title and Markdown Content */}
        <ExamMarkdownContent icon={topic.icon} title={topic.title} content={topic.context} bare />

        {/* Material Package Attachments */}
        {hasAttachments && (
          <div className="mt-8 pt-6 border-t border-gray-100">
            <div className="flex items-center gap-2 mb-4">
              <FileArchive className="h-5 w-5 text-[#DF2029]" />
              <h4 className="text-base font-semibold text-gray-900">
                {t('questions.exam_content.download_material')}
              </h4>
            </div>
            <AttachmentList
              attachments={attachments}
              generatePrefixedFilename={generateFilename}
              onDownloadSuccess={handleDownloadSuccess}
              onDownloadError={handleDownloadError}
            />
          </div>
        )}
      </div>
    </div>
  )
}
