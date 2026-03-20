// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useState } from 'react'
import {
  AIAssessmentExamPage,
  EXAM_DATA_V2,
  UPLOAD_SLOTS_CONFIG_V2,
} from '@wecode/components/evaluation/exam'
import { getTopic } from '@wecode/api/evaluation'

/**
 * AI Assessment 2026 Exam Page V2
 *
 * Topic ID: 2
 * Question IDs: 4, 5
 *
 * This page uses the shared AIAssessmentExamPage component.
 */
export default function AIAssessment2026V2Page() {
  const [topicName, setTopicName] = useState<string>('')

  useEffect(() => {
    getTopic(2)
      .then(topic => {
        if (topic?.name) {
          setTopicName(topic.name)
        }
      })
      .catch(() => {
        // Fallback to default title
      })
  }, [])

  return (
    <AIAssessmentExamPage
      topicId={2}
      examData={EXAM_DATA_V2}
      uploadSlotsConfig={UPLOAD_SLOTS_CONFIG_V2}
      pageTitle={topicName || '微博高层管理人员 AI 应用能力考核（第二场）'}
      gridCols={2}
      enableFileContentLoading={true}
    />
  )
}
