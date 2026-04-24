// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useMemo, memo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfmSafe from '@/lib/remark-gfm-safe'
import type { Components } from 'react-markdown'

export interface SlotMarkdownContentProps {
  /** Markdown content to render */
  content: string
  /** Additional CSS class names */
  className?: string
}

/**
 * Custom components for slot markdown rendering
 * Standard markdown styles with compact font sizes
 */
const slotMarkdownComponents: Components = {
  // Headings - standard markdown hierarchy with smaller sizes
  h1: ({ children }) => <h1 className="text-base font-bold text-gray-900 mt-3 mb-2">{children}</h1>,
  h2: ({ children }) => <h2 className="text-sm font-bold text-gray-800 mt-3 mb-2">{children}</h2>,
  h3: ({ children }) => <h3 className="text-sm font-semibold text-gray-700 mt-2 mb-1">{children}</h3>,
  h4: ({ children }) => <h4 className="text-sm font-medium text-gray-700 mt-2 mb-1">{children}</h4>,

  // Regular paragraphs - smaller text
  p: ({ children }) => <p className="text-sm text-gray-600 leading-relaxed mb-2">{children}</p>,

  // Blockquotes for secondary notes
  blockquote: ({ children }) => (
    <blockquote className="text-xs text-gray-500 border-l-2 border-gray-300 pl-3 my-2 italic">
      {children}
    </blockquote>
  ),

  // Lists
  ul: ({ children }) => <ul className="text-sm text-gray-600 list-disc pl-4 my-2 space-y-1">{children}</ul>,
  ol: ({ children }) => <ol className="text-sm text-gray-600 list-decimal pl-4 my-2 space-y-1">{children}</ol>,

  // List items
  li: ({ children }) => <li className="leading-relaxed">{children}</li>,

  // Strong text (bold)
  strong: ({ children }) => <strong className="font-semibold text-gray-800">{children}</strong>,

  // Links
  a: ({ children, href }) => (
    <a href={href} className="text-[#DF2029] hover:underline" target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ),

  // Code inline
  code: ({ children }) => <code className="text-xs bg-gray-100 px-1 py-0.5 rounded text-gray-700">{children}</code>,

  // Code blocks
  pre: ({ children }) => <pre className="text-xs bg-gray-100 p-3 rounded overflow-x-auto my-2">{children}</pre>,
}

// Static remark plugins array
const slotMarkdownPlugins = [remarkGfmSafe]

/**
 * SlotMarkdownContent - Standard Markdown renderer for slot content
 *
 * Used for:
 * - Bonus item content (contentMarkdown)
 * - Slot hint preview and display
 *
 * Features:
 * - Standard markdown rendering (headings, lists, paragraphs)
 * - Compact font sizes (text-sm for body, text-xs for small elements)
 * - Proper heading hierarchy (h1-h4)
 * - Memoized to prevent unnecessary re-renders
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
