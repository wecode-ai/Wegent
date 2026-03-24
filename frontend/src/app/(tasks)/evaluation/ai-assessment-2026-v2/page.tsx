// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { ExamPage } from '@wecode/components/evaluation/exam'

/**
 * AI Assessment 2026 V2 Exam Page
 *
 * Topic ID: 2
 *
 * This page uses the dynamic ExamPage component which loads slot configuration
 * from Question.content_data.answerSlots.
 */
export default function AIAssessment2026V2Page() {
  return <ExamPage topicId={2} />
}
