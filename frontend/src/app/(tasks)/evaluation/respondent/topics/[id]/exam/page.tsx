// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { redirect } from 'next/navigation'
import { ExamPage } from '@wecode/components/evaluation/exam/ExamPage'

interface PageProps {
  params: Promise<{ id: string }>
}

/**
 * Next.js route component for the exam page.
 *
 * Route: /evaluation/respondent/topics/[id]/exam
 *
 * This page redirects to /evaluation/ai-assessment-2026 only for topic id=1.
 * For other topics, it renders the exam page.
 *
 * @example
 * ```
 * Navigate to: /evaluation/respondent/topics/1/exam
 * Redirects to: /evaluation/ai-assessment-2026
 *
 * Navigate to: /evaluation/respondent/topics/123/exam
 * Renders: ExamPage
 * ```
 */
export default async function ExamPageRoute({ params }: PageProps) {
  const { id } = await params

  // Redirect to ai-assessment-2026 only for topic id=1
  if (id === '1') {
    redirect('/evaluation/ai-assessment-2026')
  }

  return <ExamPage />
}
