// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { memo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfmSafe from '@/lib/remark-gfm-safe'
import type { Components } from 'react-markdown'
import type { Element } from 'hast'
import './exam-instructions.css'

export interface ExamInstructionsMarkdownProps {
  /** Markdown content to render */
  content: string
  /** Additional CSS class names */
  className?: string
}

/**
 * Check if a list node contains rule card items (items starting with **label**)
 * by examining the HAST (HTML AST) node structure
 */
function isRuleCardListNode(node: Element | undefined): boolean {
  if (!node || !node.children) return false

  // Check list items (li elements)
  for (const child of node.children) {
    if (child.type === 'element' && child.tagName === 'li') {
      // Check if li's first meaningful child is a paragraph with strong as first child
      for (const liChild of child.children) {
        if (liChild.type === 'element' && liChild.tagName === 'p') {
          // Check if paragraph's first child is strong
          for (const pChild of liChild.children) {
            if (pChild.type === 'element' && pChild.tagName === 'strong') {
              return true
            }
            // Skip whitespace text nodes
            if (pChild.type === 'text' && pChild.value.trim() === '') {
              continue
            }
            // First non-whitespace element is not strong
            break
          }
          break
        }
        // Skip whitespace text nodes
        if (liChild.type === 'text' && liChild.value.trim() === '') {
          continue
        }
        break
      }
    }
  }
  return false
}

/**
 * Check if a blockquote node starts with a heading (h3)
 * If so, render it as a "method block" with red background
 */
function isMethodBlockNode(node: Element | undefined): boolean {
  if (!node || !node.children) return false

  // Check if first meaningful child is h3
  for (const child of node.children) {
    if (child.type === 'element' && child.tagName === 'h3') {
      return true
    }
    // Skip whitespace text nodes
    if (child.type === 'text' && child.value.trim() === '') {
      continue
    }
    // First non-whitespace element is not h3
    break
  }
  return false
}

// Components for exam instructions rendering
const instructionsComponents: Components = {
  h2: ({ children }) => <h2 className="exam-inst-h2">{children}</h2>,
  h3: ({ children }) => <h3 className="exam-inst-h3">{children}</h3>,
  // Detect if ul contains rule cards by examining the AST node
  ul: ({ children, node }) => {
    const isRulesList = isRuleCardListNode(node as Element | undefined)
    return <ul className={isRulesList ? 'exam-inst-rules' : 'exam-inst-ul'}>{children}</ul>
  },
  // Detect if ol contains rule cards by examining the AST node
  ol: ({ children, node }) => {
    const isRulesList = isRuleCardListNode(node as Element | undefined)
    return <ol className={isRulesList ? 'exam-inst-rules' : 'exam-inst-ol'}>{children}</ol>
  },
  li: ({ children }) => <li>{children}</li>,
  // Detect if blockquote is a "method block" (starts with h3) or a warning block
  blockquote: ({ children, node }) => {
    const isMethodBlock = isMethodBlockNode(node as Element | undefined)
    return (
      <blockquote className={isMethodBlock ? 'exam-inst-method' : 'exam-inst-blockquote'}>
        {children}
      </blockquote>
    )
  },
  p: ({ children }) => <p className="exam-inst-p">{children}</p>,
  strong: ({ children }) => <strong className="exam-inst-strong">{children}</strong>,
}

const remarkPlugins = [remarkGfmSafe]

/**
 * ExamInstructionsMarkdown - Markdown renderer for exam instructions (考前须知)
 *
 * Features:
 * - Rule cards: `1. **标题**\n\n   内容` renders as responsive grid cards
 * - Warning blocks: `> text` renders as amber warning box
 * - Headings with red accent styling
 * - Separate from ExamMarkdownContent to avoid affecting question content rendering
 */
export const ExamInstructionsMarkdown = memo(function ExamInstructionsMarkdown({
  content,
  className = '',
}: ExamInstructionsMarkdownProps) {
  if (!content?.trim()) return null

  return (
    <div className={`exam-instructions-markdown ${className}`}>
      <ReactMarkdown remarkPlugins={remarkPlugins} components={instructionsComponents}>
        {content}
      </ReactMarkdown>
    </div>
  )
})

export default ExamInstructionsMarkdown
