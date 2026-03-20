// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useParams } from 'next/navigation'
import dynamic from 'next/dynamic'

// Dynamically import ExamPage to avoid SSR issues
const ExamPage = dynamic(
  () => import('@wecode/components/evaluation/exam/ExamPage').then(mod => mod.ExamPage),
  { ssr: false }
)

/**
 * Next.js route component for the exam page (New Format).
 *
 * Route: /evaluation/respondent/topics/[id]/exam
 *
 * This page uses the new Markdown-based exam format.
 */
export default function ExamPageRoute() {
  const params = useParams()
  const topicId = parseInt(params.id as string)

  return <ExamPage topicId={topicId} />
}
