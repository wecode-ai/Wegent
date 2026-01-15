// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { memo, useMemo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import rehypeRaw from 'rehype-raw'
import dynamic from 'next/dynamic'
import type { Components } from 'react-markdown'

import 'katex/dist/katex.min.css'

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

interface MarkdownWithMermaidProps {
  source: string
  theme: 'light' | 'dark'
  /** Custom components to override default rendering */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  components?: Record<string, React.ComponentType<any>>
}

/**
 * Check if the content contains LaTeX math formulas
 * Supports: $...$, $$...$$, \begin{...}...\end{...}
 */
function containsMathFormulas(text: string): boolean {
  // Check for inline math: $...$
  const inlineMathRegex = /\$[^$\n]+\$/
  // Check for block math: $$...$$
  const blockMathRegex = /\$\$[\s\S]+?\$\$/
  // Check for LaTeX environments: \begin{...}...\end{...}
  const latexEnvRegex = /\\begin\{[^}]+\}[\s\S]*?\\end\{[^}]+\}/

  return inlineMathRegex.test(text) || blockMathRegex.test(text) || latexEnvRegex.test(text)
}

/**
 * Enhanced Markdown renderer with Mermaid diagram and LaTeX math formula support
 *
 * Detects ```mermaid code blocks and renders them using MermaidDiagram component.
 * Supports LaTeX math formulas with $...$ for inline and $$...$$ for block math.
 * All other markdown is rendered using react-markdown with remark/rehype plugins.
 */
export const MarkdownWithMermaid = memo(function MarkdownWithMermaid({
  source,
  theme,
  components,
}: MarkdownWithMermaidProps) {
  // Check if source contains math formulas
  const hasMath = useMemo(() => containsMathFormulas(source), [source])

  // Parse the source to extract mermaid blocks and regular content
  const contentParts = useMemo(() => {
    const parts: Array<{ type: 'markdown' | 'mermaid'; content: string }> = []
    const mermaidRegex = /```mermaid\s*\n([\s\S]*?)```/g

    let lastIndex = 0
    let match

    while ((match = mermaidRegex.exec(source)) !== null) {
      // Add markdown content before this mermaid block
      if (match.index > lastIndex) {
        const markdownContent = source.slice(lastIndex, match.index)
        if (markdownContent.trim()) {
          parts.push({ type: 'markdown', content: markdownContent })
        }
      }

      // Add the mermaid block
      const mermaidCode = match[1].trim()
      if (mermaidCode) {
        parts.push({ type: 'mermaid', content: mermaidCode })
      }

      lastIndex = match.index + match[0].length
    }

    // Add remaining markdown content after the last mermaid block
    if (lastIndex < source.length) {
      const remainingContent = source.slice(lastIndex)
      if (remainingContent.trim()) {
        parts.push({ type: 'markdown', content: remainingContent })
      }
    }

    // If no mermaid blocks found, return the entire source as markdown
    if (parts.length === 0 && source.trim()) {
      parts.push({ type: 'markdown', content: source })
    }

    return parts
  }, [source])

  // Default components with link handling
  const defaultComponents = useMemo(
    (): Components => ({
      a: ({ href, children, ...props }) => (
        <a href={href} target="_blank" rel="noopener noreferrer" {...props}>
          {children}
        </a>
      ),
      ...components,
    }),
    [components]
  )

  // Configure remark/rehype plugins based on content
  const remarkPlugins = useMemo(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const plugins: any[] = [remarkGfm]
    if (hasMath) {
      plugins.push(remarkMath)
    }
    return plugins
  }, [hasMath])

  const rehypePlugins = useMemo(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const plugins: any[] = [rehypeRaw]
    if (hasMath) {
      plugins.push(rehypeKatex)
    }
    return plugins
  }, [hasMath])

  // Render markdown content
  const renderMarkdown = (content: string) => (
    <ReactMarkdown
      remarkPlugins={remarkPlugins}
      rehypePlugins={rehypePlugins}
      components={defaultComponents}
    >
      {content}
    </ReactMarkdown>
  )

  // If no mermaid blocks, render normally
  if (contentParts.length === 1 && contentParts[0].type === 'markdown') {
    return (
      <div className="markdown-content" data-color-mode={theme}>
        {renderMarkdown(source)}
      </div>
    )
  }

  // Render mixed content with mermaid diagrams
  return (
    <div className="markdown-with-mermaid" data-color-mode={theme}>
      {contentParts.map((part, index) => {
        if (part.type === 'mermaid') {
          return <MermaidDiagram key={`mermaid-${index}`} code={part.content} />
        }

        return (
          <div key={`markdown-${index}`} className="markdown-content">
            {renderMarkdown(part.content)}
          </div>
        )
      })}
    </div>
  )
})

export default MarkdownWithMermaid
