// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { memo, useMemo } from 'react'
import MarkdownEditor from '@uiw/react-markdown-editor'
import dynamic from 'next/dynamic'

// Dynamically import MermaidDiagram to avoid SSR issues
const MermaidDiagram = dynamic(() => import('./MermaidDiagram'), {
  ssr: false,
  loading: () => (
    <div className="my-4 p-8 rounded-lg border border-border bg-surface flex items-center justify-center">
      <div className="flex items-center gap-3 text-text-secondary">
        <div className="animate-spin rounded-full h-5 w-5 border-2 border-primary border-t-transparent" />
        <span className="text-sm">Loading diagram...</span>
      </div>
    </div>
  ),
})

// Dynamically import LinkPreviewCard to avoid SSR issues
const LinkPreviewCard = dynamic(() => import('./LinkPreviewCard'), {
  ssr: false,
  loading: () => (
    <span className="block my-2 rounded-lg border border-border bg-surface animate-pulse w-full max-w-md overflow-hidden">
      <span className="flex">
        <span className="w-[120px] h-[90px] bg-muted flex-shrink-0" />
        <span className="flex-1 p-3 space-y-2">
          <span className="block h-4 bg-muted rounded w-3/4" />
          <span className="block h-3 bg-muted rounded w-full" />
          <span className="block h-3 bg-muted rounded w-1/3" />
        </span>
      </span>
    </span>
  ),
})

/** Content part types for markdown parsing */
type ContentPartType = 'markdown' | 'mermaid' | 'card'

interface ContentPart {
  type: ContentPartType
  content: string
}

interface MarkdownWithMermaidProps {
  source: string
  theme: 'light' | 'dark'
  /** Custom components to override default rendering */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  components?: Record<string, React.ComponentType<any>>
  /**
   * Whether to disable link preview fetching.
   * Useful during streaming to avoid excessive API calls.
   */
  disableLinkPreview?: boolean
}

/**
 * Check if a URL is valid for card rendering
 */
function isValidCardUrl(url: string): boolean {
  try {
    const urlObj = new URL(url)
    return urlObj.protocol === 'http:' || urlObj.protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * Parse source to extract special blocks (mermaid, card) and regular markdown
 *
 * Supports:
 * - ```mermaid code blocks for diagrams
 * - [card:url] syntax for rich link preview cards
 */
function parseContentParts(source: string): ContentPart[] {
  const parts: ContentPart[] = []

  // Combined regex to match both mermaid blocks and card syntax
  // Card syntax: [card:url] where url is an http(s) URL
  const specialBlockRegex = /```mermaid\s*\n([\s\S]*?)```|\[card:(https?:\/\/[^\]\s]+)\]/g

  let lastIndex = 0
  let match

  while ((match = specialBlockRegex.exec(source)) !== null) {
    // Add markdown content before this special block
    if (match.index > lastIndex) {
      const markdownContent = source.slice(lastIndex, match.index)
      if (markdownContent.trim()) {
        parts.push({ type: 'markdown', content: markdownContent })
      }
    }

    // Check which type of block was matched
    if (match[1] !== undefined) {
      // Mermaid block matched (group 1)
      const mermaidCode = match[1].trim()
      if (mermaidCode) {
        parts.push({ type: 'mermaid', content: mermaidCode })
      }
    } else if (match[2] !== undefined) {
      // Card syntax matched (group 2)
      const cardUrl = match[2].trim()
      if (cardUrl && isValidCardUrl(cardUrl)) {
        parts.push({ type: 'card', content: cardUrl })
      } else {
        // Invalid URL - treat as regular text
        parts.push({ type: 'markdown', content: match[0] })
      }
    }

    lastIndex = match.index + match[0].length
  }

  // Add remaining markdown content after the last special block
  if (lastIndex < source.length) {
    const remainingContent = source.slice(lastIndex)
    if (remainingContent.trim()) {
      parts.push({ type: 'markdown', content: remainingContent })
    }
  }

  // If no special blocks found, return the entire source as markdown
  if (parts.length === 0 && source.trim()) {
    parts.push({ type: 'markdown', content: source })
  }

  return parts
}

/**
 * Enhanced Markdown renderer with Mermaid diagram and Link Preview Card support
 *
 * Features:
 * - Detects ```mermaid code blocks and renders them using MermaidDiagram component
 * - Detects [card:url] syntax and renders rich link preview cards
 * - All other markdown is rendered using the standard MarkdownEditor.Markdown
 *
 * Card Syntax:
 * - Format: [card:url]
 * - Example: [card:https://github.com/wecode-ai/Wegent]
 * - Supports: websites with Open Graph metadata, images, video platforms (YouTube, Bilibili, Vimeo)
 */
export const MarkdownWithMermaid = memo(function MarkdownWithMermaid({
  source,
  theme,
  components,
  disableLinkPreview = false,
}: MarkdownWithMermaidProps) {
  // Parse the source to extract special blocks and regular content
  const contentParts = useMemo(() => parseContentParts(source), [source])

  // Default components with link handling
  const defaultComponents = useMemo(
    () => ({
      a: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
        <a href={href} target="_blank" rel="noopener noreferrer" {...props}>
          {children}
        </a>
      ),
      ...components,
    }),
    [components]
  )

  // Check if we have any special blocks
  const hasSpecialBlocks = contentParts.some(part => part.type !== 'markdown')

  // If no special blocks, render normally (optimized path)
  if (!hasSpecialBlocks && contentParts.length === 1) {
    return (
      <MarkdownEditor.Markdown
        source={source}
        style={{ background: 'transparent' }}
        wrapperElement={{ 'data-color-mode': theme }}
        components={defaultComponents}
      />
    )
  }

  // Render mixed content with special blocks
  return (
    <div className="markdown-with-mermaid">
      {contentParts.map((part, index) => {
        if (part.type === 'mermaid') {
          return <MermaidDiagram key={`mermaid-${index}`} code={part.content} />
        }

        if (part.type === 'card') {
          return (
            <LinkPreviewCard
              key={`card-${index}`}
              url={part.content}
              disabled={disableLinkPreview}
            />
          )
        }

        return (
          <MarkdownEditor.Markdown
            key={`markdown-${index}`}
            source={part.content}
            style={{ background: 'transparent' }}
            wrapperElement={{ 'data-color-mode': theme }}
            components={defaultComponents}
          />
        )
      })}
    </div>
  )
})

export default MarkdownWithMermaid
