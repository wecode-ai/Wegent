// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useState } from 'react'
import {
  AIAssessmentExamPage,
  EXAM_DATA,
  UPLOAD_SLOTS_CONFIG,
} from '@wecode/components/evaluation/exam'
import { getTopic } from '@wecode/api/evaluation'

/**
 * AI Assessment 2026 Exam Page
 *
 * Topic ID: 1
 * Question IDs: 1, 2, 3
 *
 * This page uses the shared AIAssessmentExamPage component.
 */
export default function AIAssessment2026Page() {
  const [topicName, setTopicName] = useState<string>('')

  useEffect(() => {
    getTopic(1)
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
      topicId={1}
      examData={EXAM_DATA}
      uploadSlotsConfig={UPLOAD_SLOTS_CONFIG}
      pageTitle={topicName || '微博高层管理人员 AI 应用能力考核'}
      gridCols={3}
      enableFileContentLoading={false}
    />
  )
}
