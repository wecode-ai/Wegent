// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { ExamMarkdownContent } from './ExamMarkdownContent'
import type { Topic } from './AIAssessmentTopicCard'

interface ExamTopicDetailProps {
  topic: Topic
}

/**
 * ExamTopicDetail - Displays topic details with exam styling
 *
 * @deprecated Use ExamMarkdownContent directly for new code
 */
export function ExamTopicDetail({ topic }: ExamTopicDetailProps) {
  if (!topic) return null

  return (
    <div className="animate-[slideDown_0.35s_ease-out]">
      <ExamMarkdownContent icon={topic.icon} title={topic.title} content={topic.context} />
    </div>
  )
}
