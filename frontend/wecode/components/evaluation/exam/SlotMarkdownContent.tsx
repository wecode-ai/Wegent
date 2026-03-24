// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useMemo, memo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfmSafe from '@/lib/remark-gfm-safe'
import type { Components } from 'react-markdown'
import './slot-markdown.css'

export interface SlotMarkdownContentProps {
  /** Markdown content to render */
  content: string
  /** Additional CSS class names */
  className?: string
}

/**
 * Custom components for slot markdown rendering
 *
 * Rendering rules:
 * - # heading → Bold title (displayed separately by parent)
 * - paragraph → Main description with text-[1rem] text-gray-600 leading-[1.8]
 * - > blockquote → Secondary note with text-sm text-gray-500
 * - **bold:** + list → Deliverables section with gray background
 */
const slotMarkdownComponents: Components = {
  // Headings are hidden (title is rendered by parent component)
  h1: () => null,
  h2: () => null,
  h3: () => null,

  // Regular paragraphs
  p: ({ children }) => <p className="slot-md-p">{children}</p>,

  // Blockquotes for secondary notes
  blockquote: ({ children }) => <blockquote className="slot-md-blockquote">{children}</blockquote>,

  // Unordered lists for deliverables
  ul: ({ children }) => <ul className="slot-md-ul">{children}</ul>,

  // List items
  li: ({ children }) => (
    <li className="slot-md-li">
      <span className="slot-md-bullet">•</span>
      <span>{children}</span>
    </li>
  ),

  // Strong text (bold)
  strong: ({ children }) => <strong className="slot-md-strong">{children}</strong>,
}

// Static remark plugins array
const slotMarkdownPlugins = [remarkGfmSafe]

/**
 * SlotMarkdownContent - Specialized Markdown renderer for slot content
 *
 * Used for:
 * - Bonus item content (contentMarkdown)
 * - Slot hint preview and display
 *
 * Features:
 * - Main description styling (text-[1rem] text-gray-600 leading-[1.8])
 * - Secondary notes via blockquotes (text-sm text-gray-500)
 * - Deliverables section with gray background (triggered by **bold:** + list)
 * - Memoized to prevent unnecessary re-renders
 *
 * Expected Markdown format:
 * ```markdown
 * Main description paragraph...
 *
 * > Secondary note or platform info
 *
 * **交付参考：**
 * - Item 1
 * - Item 2
 * ```
 */
export const SlotMarkdownContent = memo(function SlotMarkdownContent({
  content,
  className = '',
}: SlotMarkdownContentProps) {
  // Memoize the markdown source
  const markdownSource = useMemo(() => content ?? '', [content])

  if (!content) return null

  return (
    <div className={`slot-markdown ${className}`}>
      <ReactMarkdown remarkPlugins={slotMarkdownPlugins} components={slotMarkdownComponents}>
        {markdownSource}
      </ReactMarkdown>
    </div>
  )
})

export default SlotMarkdownContent
