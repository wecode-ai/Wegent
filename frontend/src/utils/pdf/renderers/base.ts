// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * PDF Base Renderer Module
 * Contains core rendering utilities and context management
 */

import type jsPDF from 'jspdf'
import type { TextSegment, FontStyle } from '../types'
import { COLORS, LINE_HEIGHTS, PRIMARY_COLOR, PDF_CONFIG } from '../constants'
import {
  setFontForText,
  hasUnicodeFontLoaded,
  requiresUnicodeFont,
  splitTextIntoWrappableUnits,
} from '../font'
import { UNICODE_FONT_NAME } from '../constants'

/**
 * PDF Render Context - manages state during PDF generation
 */
export interface RenderContext {
  pdf: jsPDF
  pageWidth: number
  pageHeight: number
  margin: number
  contentWidth: number
  yPosition: number
  pageNum: { value: number }
}

/**
 * Create a new render context from a jsPDF instance
 */
export function createRenderContext(pdf: jsPDF): RenderContext {
  const pageWidth = pdf.internal.pageSize.getWidth()
  const pageHeight = pdf.internal.pageSize.getHeight()
  const margin = PDF_CONFIG.margin
  const contentWidth = pageWidth - margin * 2

  return {
    pdf,
    pageWidth,
    pageHeight,
    margin,
    contentWidth,
    yPosition: margin,
    pageNum: { value: 1 },
  }
}

/**
 * Add footer with watermark
 */
export function addFooter(ctx: RenderContext): void {
  const { pdf, pageWidth, pageHeight, margin, pageNum } = ctx
  pdf.setFontSize(8)
  pdf.setTextColor(160, 160, 160)
  pdf.setFont('helvetica', 'normal')
  pdf.text('Exported from Wegent', pageWidth / 2, pageHeight - 10, { align: 'center' })
  pdf.text(`Page ${pageNum.value}`, pageWidth - margin, pageHeight - 10, { align: 'right' })
}

/**
 * Check if we need a new page and handle page break
 * Returns true if a new page was added
 */
export function checkNewPage(ctx: RenderContext, requiredHeight: number): boolean {
  const { pdf, pageHeight, margin, pageNum } = ctx
  if (ctx.yPosition + requiredHeight > pageHeight - PDF_CONFIG.footerPageOffset) {
    addFooter(ctx)
    pdf.addPage()
    pageNum.value++
    ctx.yPosition = margin
    return true
  }
  return false
}

/**
 * Render inline styled text segments with proper word wrapping
 */
export function renderStyledText(
  ctx: RenderContext,
  segments: TextSegment[],
  startX: number,
  maxWidth: number,
  baseFontSize: number = 10,
  enablePageBreak: boolean = true
): void {
  const { pdf } = ctx
  let currentX = startX
  const lineHeight = enablePageBreak ? LINE_HEIGHTS.paragraph : LINE_HEIGHTS.paragraph - 0.5

  /**
   * Helper function to set font style for a segment
   */
  const setSegmentStyle = (segment: TextSegment) => {
    let fontStyle: FontStyle = 'normal'
    if (segment.bold && segment.italic) {
      fontStyle = 'bolditalic'
    } else if (segment.bold) {
      fontStyle = 'bold'
    } else if (segment.italic) {
      fontStyle = 'italic'
    }

    pdf.setFontSize(baseFontSize)

    if (segment.math) {
      // Math formulas: render in a distinct style
      pdf.setTextColor(100, 50, 150) // Purple-ish color for math
      pdf.setFont('courier', 'normal')
    } else if (segment.code) {
      pdf.setTextColor(COLORS.code.r, COLORS.code.g, COLORS.code.b)
      pdf.setFont('courier', 'normal')
    } else if (segment.link) {
      pdf.setTextColor(COLORS.link.r, COLORS.link.g, COLORS.link.b)
      setFontForText(pdf, segment.text, fontStyle)
    } else {
      pdf.setTextColor(COLORS.text.r, COLORS.text.g, COLORS.text.b)
      setFontForText(pdf, segment.text, fontStyle)
    }
  }

  /**
   * Helper function to draw text with optional decorations
   */
  const drawTextWithDecorations = (text: string, x: number, y: number, segment: TextSegment) => {
    pdf.text(text, x, y)
    const textWidth = pdf.getTextWidth(text)

    if (segment.link) {
      pdf.setDrawColor(COLORS.link.r, COLORS.link.g, COLORS.link.b)
      pdf.setLineWidth(0.2)
      pdf.line(x, y + 0.5, x + textWidth, y + 0.5)
      pdf.link(x, y - 3, textWidth, 4, { url: segment.link })
    }

    if (segment.strikethrough) {
      pdf.setDrawColor(COLORS.text.r, COLORS.text.g, COLORS.text.b)
      pdf.setLineWidth(0.3)
      pdf.line(x, y - 1.5, x + textWidth, y - 1.5)
    }

    return textWidth
  }

  /**
   * Helper function to handle line break with optional page break check
   */
  const handleLineBreak = (segment: TextSegment) => {
    ctx.yPosition += lineHeight
    if (enablePageBreak && checkNewPage(ctx, lineHeight)) {
      setSegmentStyle(segment)
    }
    currentX = startX
  }

  for (const segment of segments) {
    setSegmentStyle(segment)

    const text = segment.text
    const availableWidth = startX + maxWidth - currentX
    const fullTextWidth = pdf.getTextWidth(text)

    if (fullTextWidth <= availableWidth) {
      const drawnWidth = drawTextWithDecorations(text, currentX, ctx.yPosition, segment)
      currentX += drawnWidth
    } else {
      const words = splitTextIntoWrappableUnits(text)
      let currentLineText = ''

      for (let i = 0; i < words.length; i++) {
        const word = words[i]
        const testText = currentLineText + word
        const testWidth = pdf.getTextWidth(testText)
        const currentAvailableWidth = startX + maxWidth - currentX

        if (testWidth <= currentAvailableWidth) {
          currentLineText = testText
        } else {
          if (currentLineText.length > 0) {
            const drawnWidth = drawTextWithDecorations(
              currentLineText,
              currentX,
              ctx.yPosition,
              segment
            )
            currentX += drawnWidth
          }

          const wordWidth = pdf.getTextWidth(word)
          if (currentX > startX && wordWidth > startX + maxWidth - currentX) {
            handleLineBreak(segment)
          }

          if (wordWidth > maxWidth) {
            let charIndex = 0
            while (charIndex < word.length) {
              let charText = ''
              while (charIndex < word.length) {
                const nextChar = word[charIndex]
                const nextWidth = pdf.getTextWidth(charText + nextChar)
                if (nextWidth > maxWidth && charText.length > 0) {
                  break
                }
                charText += nextChar
                charIndex++
              }

              if (charText.length > 0) {
                drawTextWithDecorations(charText, currentX, ctx.yPosition, segment)
                if (charIndex < word.length) {
                  handleLineBreak(segment)
                } else {
                  currentX = startX + pdf.getTextWidth(charText)
                }
              }
            }
            currentLineText = ''
          } else {
            currentLineText = word
          }
        }
      }

      if (currentLineText.length > 0) {
        const drawnWidth = drawTextWithDecorations(
          currentLineText,
          currentX,
          ctx.yPosition,
          segment
        )
        currentX += drawnWidth
      }
    }
  }
}

/**
 * Render a code block with background
 * Uses a two-pass approach: first calculate all line positions, then draw backgrounds and text
 */
export function renderCodeBlock(
  ctx: RenderContext,
  code: string,
  language: string,
  startX: number,
  maxWidth: number
): void {
  const { pdf, pageHeight, margin, pageNum } = ctx
  const codeLines = code.split('\n')
  const lineHeight = LINE_HEIGHTS.code
  const codePadding = 3
  const codeBlockSpacing = 2

  checkNewPage(ctx, lineHeight * 3 + codePadding * 2)

  // Structure to store line info for each page segment
  interface PageSegment {
    pageIndex: number
    startY: number
    lines: Array<{ text: string; y: number; needsUnicode: boolean }>
  }

  const segments: PageSegment[] = []
  const blockStartY = ctx.yPosition
  let currentSegment: PageSegment = {
    pageIndex: pageNum.value,
    startY: blockStartY,
    lines: [],
  }

  // Show language label
  if (language) {
    pdf.setFontSize(7)
    pdf.setTextColor(140, 140, 140)
    pdf.setFont('helvetica', 'normal')
    pdf.text(language, startX + maxWidth - 3, ctx.yPosition + codePadding, { align: 'right' })
  }

  ctx.yPosition += codePadding
  pdf.setFontSize(8)

  // First pass: calculate positions and handle page breaks
  for (const codeLine of codeLines) {
    const needsUnicode = hasUnicodeFontLoaded(pdf) && requiresUnicodeFont(codeLine)
    if (needsUnicode) {
      pdf.setFont(UNICODE_FONT_NAME, 'normal')
    } else {
      pdf.setFont('courier', 'normal')
    }
    const wrappedLines = pdf.splitTextToSize(codeLine || ' ', maxWidth - codePadding * 2)

    for (const wrappedLine of wrappedLines) {
      if (ctx.yPosition + lineHeight > pageHeight - 20) {
        // Save current segment before page break
        segments.push(currentSegment)

        // Add footer and new page
        addFooter(ctx)
        pdf.addPage()
        pageNum.value++
        ctx.yPosition = margin

        // Start new segment
        currentSegment = {
          pageIndex: pageNum.value,
          startY: ctx.yPosition,
          lines: [],
        }
        ctx.yPosition += codePadding
      }

      currentSegment.lines.push({
        text: wrappedLine,
        y: ctx.yPosition,
        needsUnicode,
      })
      ctx.yPosition += lineHeight
    }
  }

  // Save the last segment
  segments.push(currentSegment)

  // Add bottom padding to yPosition (this is where the code block ends)
  ctx.yPosition += codePadding
  const codeBlockEndY = ctx.yPosition

  // Second pass: draw backgrounds and text for each segment
  const totalPages = pageNum.value

  for (let segIdx = 0; segIdx < segments.length; segIdx++) {
    const segment = segments[segIdx]

    // Go to the correct page
    pdf.setPage(segment.pageIndex)

    // Calculate segment height
    let segmentEndY: number
    if (segIdx === segments.length - 1) {
      // Last segment: use the final codeBlockEndY
      segmentEndY = codeBlockEndY
    } else {
      // Not last segment: calculate based on last line position + lineHeight
      const lastLine = segment.lines[segment.lines.length - 1]
      segmentEndY = lastLine ? lastLine.y + lineHeight : segment.startY + codePadding
    }
    const segmentHeight = segmentEndY - segment.startY

    // Draw background
    pdf.setFillColor(COLORS.codeBlockBg.r, COLORS.codeBlockBg.g, COLORS.codeBlockBg.b)
    pdf.setDrawColor(200, 200, 200)
    pdf.roundedRect(startX, segment.startY, maxWidth, segmentHeight, 1.5, 1.5, 'FD')

    // Draw text
    pdf.setFontSize(8)
    pdf.setTextColor(COLORS.codeBlockText.r, COLORS.codeBlockText.g, COLORS.codeBlockText.b)

    for (const line of segment.lines) {
      if (line.needsUnicode) {
        pdf.setFont(UNICODE_FONT_NAME, 'normal')
      } else {
        pdf.setFont('courier', 'normal')
      }
      pdf.text(line.text, startX + codePadding, line.y)
    }
  }

  // Return to the last page
  pdf.setPage(totalPages)

  // Add spacing after code block for next content
  ctx.yPosition += codeBlockSpacing
}
/**
 * Normalize cell content by converting HTML tags to plain text
 * - <br>, <br/>, <br /> -> newline
 * - <p>, </p> -> newline (block element)
 * - <div>, </div> -> newline (block element)
 * - <li> -> newline + bullet
 * - Other HTML tags -> removed
 * - HTML entities -> decoded
 */
function normalizeCellContent(content: string): string {
  if (!content) return ''

  let result = content

  // Replace <br>, <br/>, <br /> tags with newlines
  result = result.replace(/<br\s*\/?>/gi, '\n')

  // Replace block-level closing tags with newlines
  result = result.replace(/<\/(?:p|div|li|tr|h[1-6])>/gi, '\n')

  // Replace block-level opening tags (except first one) - they often indicate new lines
  result = result.replace(/<(?:p|div|tr|h[1-6])(?:\s[^>]*)?>/gi, '')

  // Handle list items - add bullet point
  result = result.replace(/<li(?:\s[^>]*)?>/gi, '\n• ')

  // Remove all remaining HTML tags
  result = result.replace(/<[^>]+>/g, '')

  // Decode common HTML entities
  result = result
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'")

  // Clean up multiple consecutive newlines
  result = result.replace(/\n{3,}/g, '\n\n')

  // Trim leading/trailing whitespace from each line but preserve newlines
  result = result
    .split('\n')
    .map(line => line.trim())
    .join('\n')

  // Trim leading/trailing newlines from the whole content
  result = result.trim()

  return result
}

function calculateRowHeight(
  pdf: jsPDF,
  cells: string[],
  colWidth: number,
  cellPadding: number,
  cellLineHeight: number
): number {
  let maxLines = 1
  for (const cell of cells) {
    const normalizedCell = normalizeCellContent(cell)
    // Split by explicit newlines first, then wrap each line
    const explicitLines = normalizedCell.split('\n')
    let totalLines = 0
    for (const line of explicitLines) {
      const wrappedLines = pdf.splitTextToSize(line || ' ', colWidth - cellPadding * 2)
      totalLines += wrappedLines.length
    }
    maxLines = Math.max(maxLines, totalLines)
  }
  return maxLines * cellLineHeight + cellPadding * 2
}

/**
 * Render a table with headers and rows
 */
export function renderTable(
  ctx: RenderContext,
  headers: string[],
  alignments: ('left' | 'center' | 'right')[],
  rows: string[][],
  startX: number,
  maxWidth: number
): void {
  if (headers.length === 0) return

  const { pdf } = ctx
  const cellPadding = 1.5
  const cellLineHeight = 4
  const numCols = headers.length
  const colWidth = maxWidth / numCols

  // Calculate header row height based on content
  pdf.setFontSize(8)
  const headerRowHeight = calculateRowHeight(pdf, headers, colWidth, cellPadding, cellLineHeight)

  checkNewPage(ctx, headerRowHeight + 5)

  const headerY = ctx.yPosition
  pdf.setFillColor(240, 240, 240)
  pdf.setDrawColor(200, 200, 200)
  pdf.rect(startX, headerY, maxWidth, headerRowHeight, 'FD')

  pdf.setFontSize(8)
  pdf.setTextColor(COLORS.heading.r, COLORS.heading.g, COLORS.heading.b)

  let xPos = startX
  for (let col = 0; col < numCols; col++) {
    const normalizedHeader = normalizeCellContent(headers[col])
    setFontForText(pdf, normalizedHeader || '', 'bold')
    // Split by explicit newlines first, then wrap each line
    const explicitLines = normalizedHeader.split('\n')
    let lineY = headerY + cellPadding + cellLineHeight * 0.7
    for (const explicitLine of explicitLines) {
      const wrappedLines = pdf.splitTextToSize(explicitLine || ' ', colWidth - cellPadding * 2)
      for (const line of wrappedLines) {
        pdf.text(line, xPos + cellPadding, lineY)
        lineY += cellLineHeight
      }
    }
    xPos += colWidth
  }

  pdf.setDrawColor(200, 200, 200)
  pdf.line(startX, headerY, startX + maxWidth, headerY)

  ctx.yPosition = headerY + headerRowHeight

  for (let rowIdx = 0; rowIdx < rows.length; rowIdx++) {
    const row = rows[rowIdx]

    // Calculate row height based on content
    pdf.setFontSize(8)
    const rowHeight = calculateRowHeight(pdf, row, colWidth, cellPadding, cellLineHeight)

    checkNewPage(ctx, rowHeight)

    const rowStartY = ctx.yPosition

    if (rowIdx % 2 === 1) {
      pdf.setFillColor(248, 248, 248)
      pdf.rect(startX, rowStartY, maxWidth, rowHeight, 'F')
    }

    pdf.setDrawColor(200, 200, 200)
    pdf.line(startX, rowStartY + rowHeight, startX + maxWidth, rowStartY + rowHeight)

    pdf.setFontSize(8)
    pdf.setTextColor(COLORS.text.r, COLORS.text.g, COLORS.text.b)

    xPos = startX
    for (let col = 0; col < numCols; col++) {
      const normalizedCell = normalizeCellContent(row[col])
      setFontForText(pdf, normalizedCell || '', 'normal')
      // Split by explicit newlines first, then wrap each line
      const explicitLines = normalizedCell.split('\n')
      let lineY = rowStartY + cellPadding + cellLineHeight * 0.7
      for (const explicitLine of explicitLines) {
        const wrappedLines = pdf.splitTextToSize(explicitLine || ' ', colWidth - cellPadding * 2)
        for (const line of wrappedLines) {
          pdf.text(line, xPos + cellPadding, lineY)
          lineY += cellLineHeight
        }
      }
      xPos += colWidth
    }

    ctx.yPosition += rowHeight
  }

  ctx.yPosition += 2
}

/**
 * Add header with logo and title
 */
export function addHeader(ctx: RenderContext, taskName: string): void {
  const { pdf, pageWidth, margin, contentWidth } = ctx

  pdf.setFontSize(24)
  pdf.setTextColor(PRIMARY_COLOR.r, PRIMARY_COLOR.g, PRIMARY_COLOR.b)
  pdf.setFont('helvetica', 'bold')
  pdf.text('Wegent AI', pageWidth / 2, ctx.yPosition, { align: 'center' })
  ctx.yPosition += 10

  pdf.setFontSize(16)
  pdf.setTextColor(PRIMARY_COLOR.r, PRIMARY_COLOR.g, PRIMARY_COLOR.b)
  setFontForText(pdf, taskName, 'bold')
  const titleLines = pdf.splitTextToSize(taskName, contentWidth)
  pdf.text(titleLines, pageWidth / 2, ctx.yPosition, { align: 'center' })
  ctx.yPosition += titleLines.length * 7 + 5

  pdf.setDrawColor(PRIMARY_COLOR.r, PRIMARY_COLOR.g, PRIMARY_COLOR.b)
  pdf.setLineWidth(0.5)
  pdf.line(margin, ctx.yPosition, pageWidth - margin, ctx.yPosition)
  ctx.yPosition += 10
}
