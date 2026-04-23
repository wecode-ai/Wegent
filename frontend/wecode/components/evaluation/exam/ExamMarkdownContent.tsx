// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useMemo, memo } from 'react'
import { Icon } from './ExamIcons'
import type { IconName } from './ExamIcons'
import ReactMarkdown from 'react-markdown'
import remarkGfmSafe from '@/lib/remark-gfm-safe'
import type { Components } from 'react-markdown'
import './exam-markdown.css'

export interface ExamMarkdownContentProps {
  /** Markdown content to render */
  content: string
  /** Optional icon name to display */
  icon?: IconName
  /** Optional title to display */
  title?: string
  /** Additional CSS class names */
  className?: string
  /** When true, renders without card container (header + markdown only) */
  bare?: boolean
}

// Static components definition - defined outside component to prevent recreation
export const examMarkdownComponents: Components = {
  ol: ({ children }) => <ol className="new-exam-ol">{children}</ol>,
  li: ({ children }) => <li className="new-exam-li">{children}</li>,
  blockquote: ({ children }) => <blockquote className="new-exam-blockquote">{children}</blockquote>,
  table: ({ children }) => (
    <div className="table-wrapper">
      <table>{children}</table>
    </div>
  ),
}

// Static remark plugins array - defined outside component
export const examMarkdownPlugins = [remarkGfmSafe]

/**
 * ExamMarkdownContent - Reusable Markdown content renderer with exam styling
 *
 * Features:
 * - Consistent styling with exam page
 * - Task list support (ordered lists with numbered badges)
 * - Blockquote styling
 * - Optional icon and title header
 * - Memoized to prevent unnecessary re-renders
 * - Bare mode for embedding in other containers
 */
export const ExamMarkdownContent = memo(function ExamMarkdownContent({
  content,
  icon,
  title,
  className = '',
  bare = false,
}: ExamMarkdownContentProps) {
  // Memoize the markdown source to prevent unnecessary re-renders
  const markdownSource = useMemo(() => content ?? '', [content])

  if (!content) return null

  // Bare mode: render header + markdown without card container
  if (bare) {
    return (
      <div className={className}>
        {(icon || title) && (
          <div className="flex items-start gap-3 mb-6">
            {icon && (
              <div className="w-9 h-9 rounded-lg bg-red-50 flex items-center justify-center flex-shrink-0 mt-0.5">
                <Icon name={icon} size={20} className="text-[#DF2029]" />
              </div>
            )}
            {title && <h3 className="text-xl font-bold text-gray-900 leading-snug">{title}</h3>}
          </div>
        )}
        <div className="new-exam-markdown">
          <ReactMarkdown remarkPlugins={examMarkdownPlugins} components={examMarkdownComponents}>
            {markdownSource}
          </ReactMarkdown>
        </div>
      </div>
    )
  }

  // Default mode: full card container
  return (
    <div className={`bg-white rounded-2xl shadow-md p-7 md:p-9 ${className}`}>
      {(icon || title) && (
        <div className="flex items-start gap-3 mb-6">
          {icon && (
            <div className="w-9 h-9 rounded-lg bg-red-50 flex items-center justify-center flex-shrink-0 mt-0.5">
              <Icon name={icon} size={20} className="text-[#DF2029]" />
            </div>
          )}
          {title && <h3 className="text-xl font-bold text-gray-900 leading-snug">{title}</h3>}
        </div>
      )}

      <div className="new-exam-markdown">
        <ReactMarkdown remarkPlugins={examMarkdownPlugins} components={examMarkdownComponents}>
          {markdownSource}
        </ReactMarkdown>
      </div>
    </div>
  )
})

export default ExamMarkdownContent
