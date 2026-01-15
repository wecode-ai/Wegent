// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * PDF Markdown Parser Module
 * Handles markdown parsing for PDF generation
 */

import type { TextSegment, ParsedLine, LineType, TableAlignment } from './types'

/**
 * Parse inline markdown formatting and return styled segments
 * Supports: **bold**, *italic*, `code`, [link](url), ~~strikethrough~~, $math$
 */
export function parseInlineMarkdown(text: string): TextSegment[] {
  const segments: TextSegment[] = []
  let remaining = text

  // Regex patterns for inline markdown (order matters - more specific patterns first)
  const patterns: Array<{
    regex: RegExp
    bold?: boolean
    italic?: boolean
    code?: boolean
    strikethrough?: boolean
    isLink?: boolean
    math?: boolean
  }> = [
    // Inline math: $...$  (must not be escaped \$)
    { regex: /(?<!\\)\$([^$\n]+?)(?<!\\)\$/, math: true },
    // Bold + Italic (must come before bold and italic)
    { regex: /\*\*\*(.+?)\*\*\*/, bold: true, italic: true },
    { regex: /___(.+?)___/, bold: true, italic: true },
    // Bold
    { regex: /\*\*(.+?)\*\*/, bold: true },
    { regex: /__(.+?)__/, bold: true },
    // Italic
    { regex: /\*([^*]+)\*/, italic: true },
    { regex: /_([^_]+)_/, italic: true },
    // Strikethrough
    { regex: /~~(.+?)~~/, strikethrough: true },
    // Inline code
    { regex: /`([^`]+)`/, code: true },
    // Link
    { regex: /\[([^\]]+)\]\(([^)]+)\)/, isLink: true },
  ]

  while (remaining.length > 0) {
    let earliestMatch: { index: number; length: number; segment: TextSegment } | null = null

    for (const pattern of patterns) {
      const match = remaining.match(pattern.regex)
      if (match && match.index !== undefined) {
        const matchIndex = match.index
        if (!earliestMatch || matchIndex < earliestMatch.index) {
          let segment: TextSegment
          if (pattern.isLink) {
            segment = { text: match[1], link: match[2] }
          } else if (pattern.math) {
            segment = {
              text: match[1],
              math: true,
              mathDisplay: false,
            }
          } else {
            segment = {
              text: match[1],
              bold: pattern.bold,
              italic: pattern.italic,
              code: pattern.code,
              strikethrough: pattern.strikethrough,
            }
          }
          earliestMatch = {
            index: matchIndex,
            length: match[0].length,
            segment,
          }
        }
      }
    }

    if (earliestMatch) {
      // Add plain text before the match
      if (earliestMatch.index > 0) {
        segments.push({ text: remaining.substring(0, earliestMatch.index) })
      }
      // Add the styled segment
      segments.push(earliestMatch.segment)
      // Continue with remaining text
      remaining = remaining.substring(earliestMatch.index + earliestMatch.length)
    } else {
      // No more matches, add remaining as plain text
      if (remaining.length > 0) {
        segments.push({ text: remaining })
      }
      break
    }
  }

  return segments.length > 0 ? segments : [{ text }]
}

/**
 * Parse table row cells from a markdown table line
 */
export function parseTableCells(line: string): string[] {
  // Remove leading and trailing pipes and split by pipe
  const trimmed = line.trim()
  const withoutPipes = trimmed.startsWith('|') ? trimmed.slice(1) : trimmed
  const withoutEndPipe = withoutPipes.endsWith('|') ? withoutPipes.slice(0, -1) : withoutPipes
  return withoutEndPipe.split('|').map(cell => cell.trim())
}

/**
 * Check if a line is a table separator (e.g., |---|---|---|)
 */
export function isTableSeparator(line: string): boolean {
  const trimmed = line.trim()
  // Table separator pattern: |:?-+:?|:?-+:?|... or :?-+:?|:?-+:?|...
  return /^\|?[\s]*:?-+:?[\s]*(\|[\s]*:?-+:?[\s]*)+\|?$/.test(trimmed)
}

/**
 * Check if a line looks like a table row
 */
export function isTableRow(line: string): boolean {
  const trimmed = line.trim()
  // Table row must contain at least one pipe character
  // and should have content (not just pipes)
  if (!trimmed.includes('|')) return false
  // Check if it has actual content between pipes
  const cells = parseTableCells(trimmed)
  return cells.length >= 1 && cells.some(cell => cell.length > 0)
}

/**
 * Parse table alignments from separator line
 */
export function parseTableAlignments(line: string): TableAlignment[] {
  const cells = parseTableCells(line)
  return cells.map(cell => {
    const trimmed = cell.trim()
    const hasLeftColon = trimmed.startsWith(':')
    const hasRightColon = trimmed.endsWith(':')
    if (hasLeftColon && hasRightColon) return 'center'
    if (hasRightColon) return 'right'
    return 'left'
  })
}

/**
 * Parse a single line to determine its markdown type
 */
export function parseLineType(line: string, context?: { inTable?: boolean }): ParsedLine {
  const trimmed = line.trim()

  if (trimmed === '') {
    return { type: 'empty', content: '' }
  }

  // Table separator (must check before horizontal rule)
  if (isTableSeparator(trimmed)) {
    return {
      type: 'tableSeparator',
      content: trimmed,
      tableAlignments: parseTableAlignments(trimmed),
    }
  }

  // Table row (check if in table context or looks like a table row)
  if (context?.inTable || isTableRow(trimmed)) {
    const cells = parseTableCells(trimmed)
    if (cells.length >= 1) {
      return {
        type: 'tableRow',
        content: trimmed,
        tableCells: cells,
      }
    }
  }

  // Horizontal rule
  if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
    return { type: 'horizontalRule', content: '' }
  }

  // Headings
  const headingMatch = trimmed.match(/^(#{1,6})\s+(.*)$/)
  if (headingMatch) {
    const level = headingMatch[1].length as 1 | 2 | 3 | 4 | 5 | 6
    const typeMap: Record<number, LineType> = {
      1: 'heading1',
      2: 'heading2',
      3: 'heading3',
      4: 'heading4',
      5: 'heading5',
      6: 'heading6',
    }
    return { type: typeMap[level], content: headingMatch[2], level }
  }

  // Unordered list
  const unorderedMatch = trimmed.match(/^[-*+]\s+(.*)$/)
  if (unorderedMatch) {
    // Calculate indentation level
    const indent = line.length - line.trimStart().length
    const level = Math.floor(indent / 2)
    return { type: 'unorderedList', content: unorderedMatch[1], level }
  }

  // Ordered list
  const orderedMatch = trimmed.match(/^(\d+)\.\s+(.*)$/)
  if (orderedMatch) {
    const indent = line.length - line.trimStart().length
    const level = Math.floor(indent / 2)
    return {
      type: 'orderedList',
      content: orderedMatch[2],
      level,
      listNumber: parseInt(orderedMatch[1]),
    }
  }

  // Blockquote
  const blockquoteMatch = trimmed.match(/^>\s*(.*)$/)
  if (blockquoteMatch) {
    return { type: 'blockquote', content: blockquoteMatch[1] }
  }

  // Regular paragraph
  return { type: 'paragraph', content: trimmed }
}

/**
 * Check if a line is the start of a display math block ($$)
 */
export function isDisplayMathStart(line: string): boolean {
  const trimmed = line.trim()
  return trimmed.startsWith('$$') && !trimmed.endsWith('$$')
}

/**
 * Check if a line is the end of a display math block ($$)
 */
export function isDisplayMathEnd(line: string): boolean {
  const trimmed = line.trim()
  return trimmed.endsWith('$$') && !trimmed.startsWith('$$')
}

/**
 * Check if a line is a single-line display math block ($$...$$)
 */
export function isSingleLineDisplayMath(line: string): boolean {
  const trimmed = line.trim()
  return trimmed.startsWith('$$') && trimmed.endsWith('$$') && trimmed.length > 4
}

/**
 * Check if a line is the start of a LaTeX environment (\begin{...})
 */
export function isLatexEnvStart(line: string): boolean {
  return /\\begin\{[^}]+\}/.test(line)
}

/**
 * Check if a line is the end of a LaTeX environment (\end{...})
 * Uses string matching instead of regex to avoid ReDoS vulnerabilities
 */
export function isLatexEnvEnd(line: string, envName: string): boolean {
  // Use string matching instead of regex to avoid ReDoS from malicious input
  const expectedEnd = `\\end{${envName}}`
  return line.includes(expectedEnd)
}

/**
 * Extract environment name from \begin{envName}
 */
export function extractLatexEnvName(line: string): string | null {
  const match = line.match(/\\begin\{([^}]+)\}/)
  return match ? match[1] : null
}

/**
 * Extract math content from a display math block
 */
export function extractDisplayMathContent(content: string): string {
  // Remove $$ from start and end
  let math = content.trim()
  if (math.startsWith('$$')) {
    math = math.slice(2)
  }
  if (math.endsWith('$$')) {
    math = math.slice(0, -2)
  }
  return math.trim()
}
