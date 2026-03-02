// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import ReactMarkdown from 'react-markdown'
import type { Question } from '@wecode/types/evaluation'

/**
 * Props for the TopicDetail component
 */
interface TopicDetailProps {
  /** Topic title */
  title: string
  /** Question content data with Markdown content */
  content: Question['content_data'] | undefined
}

/**
 * Helper to safely get string value from content data
 */
function getStringValue(
  content: Record<string, unknown> | undefined,
  key: string
): string | undefined {
  if (!content) return undefined
  const value = content[key]
  return typeof value === 'string' ? value : undefined
}

/**
 * Detailed view component for exam topic content.
 * Renders Markdown-based exam content including description and criteria.
 *
 * Features:
 * - Markdown rendering for rich text content
 * - Simplified structure with content and criteria sections
 * - Animated slide-down entrance
 *
 * @example
 * ```tsx
 * <TopicDetail
 *   title="AI Agent Development"
 *   content={questionContent}
 * />
 * ```
 */
export function TopicDetail({ title, content }: TopicDetailProps) {
  if (!content) return null

  const description = getStringValue(content, 'description') || ''
  const criteria = getStringValue(content, 'criteria') || ''

  return (
    <div className="animate-[slideDown_0.35s_ease-out] bg-white rounded-2xl shadow-md p-7 md:p-9">
      <h3 className="text-xl font-bold text-gray-900 leading-snug mb-6">{title}</h3>

      {description && (
        <div className="mb-6 text-base text-gray-600 leading-[1.8]">
          <ReactMarkdown>{description}</ReactMarkdown>
        </div>
      )}

      {criteria && (
        <div className="bg-amber-50 border-l-4 border-amber-400 rounded-r-xl p-5">
          <p className="text-base text-amber-800 leading-relaxed">
            <span className="font-bold">评分标准：</span>
            <span className="inline">
              <ReactMarkdown>{criteria}</ReactMarkdown>
            </span>
          </p>
        </div>
      )}
    </div>
  )
}
