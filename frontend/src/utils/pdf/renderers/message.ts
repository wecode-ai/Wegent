// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * PDF Message Renderer Module
 * Handles rendering of chat messages with bubble styles
 */

import type {
  ExportMessage,
  ExportAttachment,
  ExportKnowledgeBase,
  ParsedLine,
  TableAlignment,
} from '../types'
import { COLORS, LINE_HEIGHTS, HEADING_SIZES, BUBBLE_STYLES, PRIMARY_COLOR } from '../constants'
import { setFontForText } from '../font'
import { sanitizeEmojisForPdf } from '../emoji'
import { parseInlineMarkdown, parseLineType } from '../markdown'
import {
  formatTimestamp,
  isImageExtension,
  getFileTypeLabel,
  formatFileSize,
  getImageFormat,
  sanitizeContent,
} from '../utils'
import { RenderContext, checkNewPage, renderStyledText, renderCodeBlock, renderTable } from './base'
import { renderMermaidDiagram, isMermaidLanguage } from './mermaid'
import { renderMathFormula, extractMathBlocks, containsMathFormulas } from './math'
/**
 * Content part type for parsed message content
 */
interface ContentPart {
  type: 'text' | 'code' | 'math'
  content: string
  language?: string
  displayMode?: boolean
}

/**
 * Parse message content into text, code block, and math parts using regex
 * This handles cases where code block markers are on the same line as text
 *
 * @param content - Raw message content
 * @returns Array of content parts (text, code blocks, and math blocks)
 */
function parseMessageContent(content: string): ContentPart[] {
  const parts: ContentPart[] = []

  // First, extract code blocks
  // Regex to match code blocks: ```language\ncontent``` or ```language content```
  const codeBlockRegex = /```(\w*)\n?([\s\S]*?)```/g

  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = codeBlockRegex.exec(content)) !== null) {
    // Add text/math content before this code block
    if (match.index > lastIndex) {
      const textBefore = content.substring(lastIndex, match.index)
      if (textBefore.trim()) {
        // Check if this text contains math formulas
        if (containsMathFormulas(textBefore)) {
          const mathParts = extractMathBlocks(textBefore)
          for (const mathPart of mathParts) {
            if (mathPart.type === 'math') {
              parts.push({
                type: 'math',
                content: mathPart.content,
                displayMode: mathPart.displayMode,
              })
            } else if (mathPart.content.trim()) {
              parts.push({
                type: 'text',
                content: mathPart.content,
              })
            }
          }
        } else {
          parts.push({
            type: 'text',
            content: textBefore,
          })
        }
      }
    }

    // Add the code block
    const language = match[1] || ''
    const codeContent = match[2] || ''

    parts.push({
      type: 'code',
      content: codeContent,
      language,
    })

    lastIndex = match.index + match[0].length
  }

  // Add remaining text/math after the last code block
  if (lastIndex < content.length) {
    const textAfter = content.substring(lastIndex)
    if (textAfter.trim()) {
      // Check if remaining text contains math formulas
      if (containsMathFormulas(textAfter)) {
        const mathParts = extractMathBlocks(textAfter)
        for (const mathPart of mathParts) {
          if (mathPart.type === 'math') {
            parts.push({
              type: 'math',
              content: mathPart.content,
              displayMode: mathPart.displayMode,
            })
          } else if (mathPart.content.trim()) {
            parts.push({
              type: 'text',
              content: mathPart.content,
            })
          }
        }
      } else {
        parts.push({
          type: 'text',
          content: textAfter,
        })
      }
    }
  }

  // If no parts found, check if entire content has math
  if (parts.length === 0 && content.trim()) {
    if (containsMathFormulas(content)) {
      const mathParts = extractMathBlocks(content)
      for (const mathPart of mathParts) {
        if (mathPart.type === 'math') {
          parts.push({
            type: 'math',
            content: mathPart.content,
            displayMode: mathPart.displayMode,
          })
        } else if (mathPart.content.trim()) {
          parts.push({
            type: 'text',
            content: mathPart.content,
          })
        }
      }
    } else {
      parts.push({
        type: 'text',
        content,
      })
    }
  }

  return parts
}

/**
 * Render text content (non-code block) within a bubble
 * Handles markdown parsing for tables, lists, headings, etc.
 */
async function renderTextContentInBubble(
  ctx: RenderContext,
  content: string,
  startX: number,
  maxWidth: number
): Promise<void> {
  const lines = content.split('\n')

  // Table state
  let inTable = false
  let tableHeaders: string[] = []
  let tableAlignments: TableAlignment[] = []
  let tableRows: string[][] = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const parsedLine = parseLineType(line, { inTable })

    if (parsedLine.type === 'tableRow' || parsedLine.type === 'tableSeparator') {
      if (parsedLine.type === 'tableSeparator') {
        if (!inTable && tableRows.length === 0 && i > 0) {
          const prevLine = lines[i - 1]
          const prevParsed = parseLineType(prevLine, { inTable: true })
          if (prevParsed.type === 'tableRow' && prevParsed.tableCells) {
            tableHeaders = prevParsed.tableCells
          }
        }
        tableAlignments = parsedLine.tableAlignments || []
        inTable = true
      } else if (parsedLine.type === 'tableRow' && parsedLine.tableCells) {
        if (inTable) {
          tableRows.push(parsedLine.tableCells)
        }
      }
    } else {
      if (inTable && tableHeaders.length > 0) {
        renderTable(ctx, tableHeaders, tableAlignments, tableRows, startX, maxWidth)
        inTable = false
        tableHeaders = []
        tableAlignments = []
        tableRows = []
      }
      renderMarkdownLineInBubble(ctx, parsedLine, startX, maxWidth)
    }
  }

  // Flush remaining table
  if (inTable && tableHeaders.length > 0) {
    renderTable(ctx, tableHeaders, tableAlignments, tableRows, startX, maxWidth)
  }
}

/**
 * Draw a chat bubble icon (user or AI)
 */
export function drawBubbleIcon(
  ctx: RenderContext,
  x: number,
  y: number,
  isUser: boolean,
  _label: string
): void {
  const { pdf } = ctx
  const style = isUser ? BUBBLE_STYLES.user : BUBBLE_STYLES.ai
  const iconSize = BUBBLE_STYLES.common.iconSize
  const radius = iconSize / 2

  // Draw circular background
  pdf.setFillColor(style.iconBgColor.r, style.iconBgColor.g, style.iconBgColor.b)
  pdf.circle(x + radius, y + radius, radius, 'F')

  // Draw icon text (first letter)
  pdf.setFontSize(7)
  pdf.setFont('helvetica', 'bold')
  pdf.setTextColor(255, 255, 255)
  const iconChar = isUser ? 'U' : 'A'
  const textWidth = pdf.getTextWidth(iconChar)
  pdf.text(iconChar, x + radius - textWidth / 2, y + radius + 1.5)
}

/**
 * Render an image attachment within a bubble
 */
export function renderImageAttachmentInBubble(
  ctx: RenderContext,
  attachment: ExportAttachment,
  startX: number,
  maxWidth: number
): void {
  if (!attachment.imageData) return

  const { pdf } = ctx

  try {
    const imageFormat = getImageFormat(attachment.file_extension)
    const imgWidth = Math.min(maxWidth - 10, 60)
    const imgHeight = Math.min(50, 45)

    pdf.addImage(
      attachment.imageData,
      imageFormat,
      startX,
      ctx.yPosition,
      imgWidth,
      imgHeight,
      undefined,
      'FAST'
    )

    ctx.yPosition += imgHeight + 2

    pdf.setFontSize(7)
    pdf.setTextColor(120, 120, 120)
    pdf.setFont('helvetica', 'normal')
    pdf.text(attachment.filename, startX, ctx.yPosition)
    ctx.yPosition += 4
  } catch (error) {
    console.warn('Failed to render image attachment:', error)
    renderFileAttachmentInBubble(ctx, attachment, startX, maxWidth)
  }
}

/**
 * Render a file attachment info within a bubble
 */
export function renderFileAttachmentInBubble(
  ctx: RenderContext,
  attachment: ExportAttachment,
  startX: number,
  maxWidth: number
): void {
  const { pdf } = ctx
  const attachmentHeight = 7

  // Draw attachment box
  pdf.setFillColor(255, 255, 255)
  pdf.setDrawColor(200, 200, 200)
  pdf.roundedRect(startX, ctx.yPosition - 3, maxWidth - 10, attachmentHeight, 1, 1, 'FD')

  // File type label
  const fileTypeLabel = getFileTypeLabel(attachment.file_extension)
  pdf.setFontSize(7)
  pdf.setFont('helvetica', 'bold')
  pdf.setTextColor(100, 100, 100)
  pdf.text(fileTypeLabel, startX + 2, ctx.yPosition)

  // Filename
  pdf.setFontSize(8)
  setFontForText(pdf, attachment.filename, 'normal')
  pdf.setTextColor(COLORS.text.r, COLORS.text.g, COLORS.text.b)
  let displayFilename = attachment.filename
  const maxFilenameWidth = maxWidth - 50
  if (pdf.getTextWidth(displayFilename) > maxFilenameWidth) {
    while (
      pdf.getTextWidth(displayFilename + '...') > maxFilenameWidth &&
      displayFilename.length > 0
    ) {
      displayFilename = displayFilename.slice(0, -1)
    }
    displayFilename += '...'
  }
  pdf.text(displayFilename, startX + 10, ctx.yPosition)

  // File size
  pdf.setFontSize(7)
  pdf.setTextColor(140, 140, 140)
  pdf.setFont('helvetica', 'normal')
  const sizeText = formatFileSize(attachment.file_size)
  pdf.text(sizeText, startX + maxWidth - 15, ctx.yPosition, { align: 'right' })

  ctx.yPosition += attachmentHeight + 2
}

/**
 * Render attachments within a chat bubble
 */
export function renderAttachmentsInBubble(
  ctx: RenderContext,
  attachments: ExportAttachment[],
  startX: number,
  maxWidth: number
): void {
  for (const attachment of attachments) {
    const isImage = isImageExtension(attachment.file_extension)

    if (isImage && attachment.imageData) {
      renderImageAttachmentInBubble(ctx, attachment, startX, maxWidth)
    } else {
      renderFileAttachmentInBubble(ctx, attachment, startX, maxWidth)
    }
  }
  ctx.yPosition += 2
}

/**
 * Render a knowledge base info card within a bubble
 */
export function renderKnowledgeBaseInBubble(
  ctx: RenderContext,
  kb: ExportKnowledgeBase,
  startX: number,
  maxWidth: number
): void {
  const { pdf } = ctx
  const kbHeight = 7

  // Draw knowledge base box with gray border (consistent with attachments)
  pdf.setFillColor(255, 255, 255)
  pdf.setDrawColor(200, 200, 200)
  pdf.roundedRect(startX, ctx.yPosition - 3, maxWidth - 10, kbHeight, 1, 1, 'FD')

  // Knowledge base type label [KB] (gray color, consistent with attachment labels)
  pdf.setFontSize(7)
  pdf.setFont('helvetica', 'bold')
  pdf.setTextColor(100, 100, 100)
  pdf.text('[KB]', startX + 2, ctx.yPosition)

  // Knowledge base name
  pdf.setFontSize(8)
  setFontForText(pdf, kb.name, 'normal')
  pdf.setTextColor(COLORS.text.r, COLORS.text.g, COLORS.text.b)
  let displayName = kb.name
  const maxNameWidth = maxWidth - 50
  if (pdf.getTextWidth(displayName) > maxNameWidth) {
    while (pdf.getTextWidth(displayName + '...') > maxNameWidth && displayName.length > 0) {
      displayName = displayName.slice(0, -1)
    }
    displayName += '...'
  }
  pdf.text(displayName, startX + 12, ctx.yPosition)

  // Document count
  pdf.setFontSize(7)
  pdf.setTextColor(140, 140, 140)
  pdf.setFont('helvetica', 'normal')
  const countText = `${kb.document_count || 0} docs`
  pdf.text(countText, startX + maxWidth - 15, ctx.yPosition, { align: 'right' })

  ctx.yPosition += kbHeight + 2
}

/**
 * Render knowledge bases within a chat bubble
 */
export function renderKnowledgeBasesInBubble(
  ctx: RenderContext,
  knowledgeBases: ExportKnowledgeBase[],
  startX: number,
  maxWidth: number
): void {
  for (const kb of knowledgeBases) {
    renderKnowledgeBaseInBubble(ctx, kb, startX, maxWidth)
  }
  ctx.yPosition += 2
}

/**
 * Render a markdown line within a bubble
 */
export function renderMarkdownLineInBubble(
  ctx: RenderContext,
  parsedLine: ParsedLine,
  startX: number,
  maxWidth: number
): void {
  const { pdf } = ctx
  const { type, content, level, listNumber } = parsedLine

  switch (type) {
    case 'empty':
      ctx.yPosition += 2
      break

    case 'tableSeparator':
    case 'tableRow':
      break

    case 'horizontalRule':
      checkNewPage(ctx, 5)
      pdf.setDrawColor(180, 180, 180)
      pdf.setLineWidth(0.3)
      pdf.line(startX, ctx.yPosition, startX + maxWidth, ctx.yPosition)
      ctx.yPosition += 3
      break

    case 'heading1':
    case 'heading2':
    case 'heading3':
    case 'heading4':
    case 'heading5':
    case 'heading6': {
      const fontSize = Math.max(HEADING_SIZES[type] - 2, 9)
      const lineHeight = LINE_HEIGHTS[type] - 1
      checkNewPage(ctx, lineHeight + 3)
      ctx.yPosition += 1

      pdf.setFontSize(fontSize)
      pdf.setTextColor(COLORS.heading.r, COLORS.heading.g, COLORS.heading.b)
      setFontForText(pdf, content, 'bold')

      const headingLines = pdf.splitTextToSize(content, maxWidth)
      for (const headingLine of headingLines) {
        checkNewPage(ctx, lineHeight)
        pdf.text(headingLine, startX, ctx.yPosition)
        ctx.yPosition += lineHeight
      }
      ctx.yPosition += 1
      break
    }

    case 'unorderedList': {
      const indent = (level || 0) * 4
      checkNewPage(ctx, LINE_HEIGHTS.list)
      pdf.setFillColor(COLORS.listMarker.r, COLORS.listMarker.g, COLORS.listMarker.b)
      const bulletX = startX + indent + 1.5
      const bulletY = ctx.yPosition - 1.2
      pdf.circle(bulletX, bulletY, 0.6, 'F')

      pdf.setFontSize(9)
      pdf.setTextColor(COLORS.text.r, COLORS.text.g, COLORS.text.b)
      setFontForText(pdf, content, 'normal')

      const listLines = pdf.splitTextToSize(content, maxWidth - indent - 5)
      for (let i = 0; i < listLines.length; i++) {
        checkNewPage(ctx, LINE_HEIGHTS.list)
        pdf.text(listLines[i], startX + indent + 4, ctx.yPosition)
        if (i < listLines.length - 1) ctx.yPosition += LINE_HEIGHTS.list - 0.5
      }
      ctx.yPosition += LINE_HEIGHTS.list - 0.5
      break
    }

    case 'orderedList': {
      const indent = (level || 0) * 4
      checkNewPage(ctx, LINE_HEIGHTS.list)
      pdf.setFontSize(9)
      pdf.setTextColor(COLORS.listMarker.r, COLORS.listMarker.g, COLORS.listMarker.b)
      pdf.setFont('helvetica', 'normal')
      const numberText = `${listNumber}.`
      pdf.text(numberText, startX + indent, ctx.yPosition)

      pdf.setTextColor(COLORS.text.r, COLORS.text.g, COLORS.text.b)
      setFontForText(pdf, content, 'normal')

      const listLines = pdf.splitTextToSize(content, maxWidth - indent - 6)
      for (let i = 0; i < listLines.length; i++) {
        checkNewPage(ctx, LINE_HEIGHTS.list)
        pdf.text(listLines[i], startX + indent + 5, ctx.yPosition)
        if (i < listLines.length - 1) ctx.yPosition += LINE_HEIGHTS.list - 0.5
      }
      ctx.yPosition += LINE_HEIGHTS.list - 0.5
      break
    }

    case 'blockquote': {
      checkNewPage(ctx, LINE_HEIGHTS.blockquote + 2)
      pdf.setDrawColor(180, 180, 180)
      pdf.setLineWidth(0.8)
      pdf.line(startX + 1, ctx.yPosition - 2.5, startX + 1, ctx.yPosition + 1)

      pdf.setFontSize(9)
      pdf.setTextColor(COLORS.blockquote.r, COLORS.blockquote.g, COLORS.blockquote.b)
      setFontForText(pdf, content, 'italic')

      const quoteLines = pdf.splitTextToSize(content, maxWidth - 6)
      for (const quoteLine of quoteLines) {
        checkNewPage(ctx, LINE_HEIGHTS.blockquote)
        pdf.text(quoteLine, startX + 5, ctx.yPosition)
        ctx.yPosition += LINE_HEIGHTS.blockquote - 0.5
      }
      break
    }

    case 'paragraph':
    default: {
      checkNewPage(ctx, LINE_HEIGHTS.paragraph)
      const segments = parseInlineMarkdown(content)
      renderStyledText(ctx, segments, startX, maxWidth, 9, true)
      ctx.yPosition += LINE_HEIGHTS.paragraph - 0.5
      break
    }
  }
}
/**
 * Render a code block, with special handling for mermaid diagrams
 * For mermaid code blocks, attempts to render as diagram image
 * Falls back to regular code block on failure
 *
 * @param ctx - PDF render context
 * @param code - Code block content
 * @param language - Code language identifier
 * @param startX - Starting X position
 * @param maxWidth - Maximum width
 */
async function renderCodeBlockWithMermaidSupport(
  ctx: RenderContext,
  code: string,
  language: string,
  startX: number,
  maxWidth: number
): Promise<void> {
  // Check if this is a mermaid code block by language identifier
  let isMermaid = isMermaidLanguage(language)

  // If language is empty or not recognized as mermaid, try to detect from content
  if (!isMermaid && (!language || language === '')) {
    isMermaid = detectMermaidFromContent(code)
  }

  if (isMermaid) {
    try {
      // Attempt to render mermaid diagram as image
      await renderMermaidDiagram(ctx, code, startX, maxWidth)
      return
    } catch (error) {
      // Log warning and fall back to code block display
      console.warn('Mermaid diagram rendering failed, falling back to code block:', error)
      // Fall through to render as regular code block
    }
  }

  // Render as regular code block
  renderCodeBlock(ctx, code, language, startX, maxWidth)
}

/**
 * Detect mermaid diagram type from code content
 * Used as fallback when language is not explicitly specified
 */
function detectMermaidFromContent(content: string): boolean {
  const firstLine = content.trim().split('\n')[0]?.trim() || ''
  const mermaidDiagramTypes = [
    'flowchart',
    'graph',
    'sequenceDiagram',
    'classDiagram',
    'stateDiagram',
    'erDiagram',
    'gantt',
    'pie',
    'journey',
    'gitGraph',
    'mindmap',
    'timeline',
    'quadrantChart',
    'sankey-beta',
    'radar-beta',
    'xychart-beta',
    'block-beta',
    'packet-beta',
    'architecture-beta',
  ]

  const isMermaid = mermaidDiagramTypes.some(
    type =>
      firstLine.toLowerCase().startsWith(type.toLowerCase()) ||
      firstLine.toLowerCase().startsWith(type.toLowerCase().replace('-', ''))
  )

  return isMermaid
}

/**
 * Render message content within a chat bubble
 * Uses regex-based parsing to correctly handle code blocks that are inline with text
 * Supports async rendering for mermaid diagrams and math formulas
 */
export async function renderMessageContentInBubble(
  ctx: RenderContext,
  content: string,
  startX: number,
  maxWidth: number
): Promise<void> {
  // Parse content into text, code block, and math parts using regex
  const parts = parseMessageContent(content)

  // Render each part
  for (const part of parts) {
    if (part.type === 'text') {
      // Render text content with markdown support
      await renderTextContentInBubble(ctx, part.content, startX, maxWidth)
    } else if (part.type === 'code') {
      // Render code block with mermaid support
      const language = part.language || ''
      const codeContent = part.content

      if (codeContent.trim()) {
        await renderCodeBlockWithMermaidSupport(ctx, codeContent, language, startX, maxWidth)
      }
    } else if (part.type === 'math') {
      // Render math formula
      const mathContent = part.content
      const displayMode = part.displayMode || false

      if (mathContent.trim()) {
        renderMathFormula(ctx, mathContent, startX, maxWidth, displayMode)
      }
    }
  }
}

/**
 * Render a complete message with bubble style
 * Supports async rendering for mermaid diagrams
 */
export async function renderMessage(ctx: RenderContext, msg: ExportMessage): Promise<void> {
  const { pdf, pageWidth, margin, contentWidth } = ctx
  const isUser = msg.type === 'user'
  const label = isUser ? msg.userName || 'User' : msg.teamName || msg.botName || 'AI'
  const timestamp = formatTimestamp(msg.timestamp)
  const style = isUser ? BUBBLE_STYLES.user : BUBBLE_STYLES.ai
  const { padding, iconSize, messagePadding, maxWidthPercent, borderRadius } = BUBBLE_STYLES.common

  // Sanitize and prepare content
  let content = sanitizeEmojisForPdf(msg.content)
  content = sanitizeContent(content)

  if (isUser) {
    // User message: render with compact bubble style
    const bubbleMaxWidth = contentWidth * maxWidthPercent
    const bubbleContentWidth = bubbleMaxWidth - padding * 2
    const iconSpacing = iconSize + 2

    checkNewPage(ctx, 20 + messagePadding)

    const bubbleStartY = ctx.yPosition
    const bubbleX = pageWidth - margin - bubbleMaxWidth
    const iconX = bubbleX - iconSpacing

    drawBubbleIcon(ctx, iconX, bubbleStartY, isUser, label)

    const contentStartX = bubbleX + padding
    const contentMaxWidth = bubbleContentWidth

    ctx.yPosition = bubbleStartY + padding

    // Draw message header
    pdf.setFontSize(8)
    setFontForText(pdf, label, 'bold')
    pdf.setTextColor(66, 133, 244)
    pdf.text(label, contentStartX, ctx.yPosition)

    pdf.setFontSize(6)
    pdf.setFont('helvetica', 'normal')
    pdf.setTextColor(140, 140, 140)
    pdf.text(timestamp, bubbleX + bubbleMaxWidth - padding, ctx.yPosition, { align: 'right' })
    ctx.yPosition += 4

    if (msg.attachments && msg.attachments.length > 0) {
      renderAttachmentsInBubble(ctx, msg.attachments, contentStartX, contentMaxWidth)
    }

    if (msg.knowledgeBases && msg.knowledgeBases.length > 0) {
      renderKnowledgeBasesInBubble(ctx, msg.knowledgeBases, contentStartX, contentMaxWidth)
    }

    await renderMessageContentInBubble(ctx, content, contentStartX, contentMaxWidth)

    const bubbleEndY = ctx.yPosition + padding
    const actualBubbleHeight = bubbleEndY - bubbleStartY

    // Draw bubble background
    pdf.setFillColor(style.bgColor.r, style.bgColor.g, style.bgColor.b)
    pdf.setDrawColor(style.borderColor.r, style.borderColor.g, style.borderColor.b)
    pdf.setLineWidth(0.2)
    pdf.roundedRect(
      bubbleX,
      bubbleStartY,
      bubbleMaxWidth,
      actualBubbleHeight,
      borderRadius,
      borderRadius,
      'FD'
    )

    // Re-render content on top of bubble
    ctx.yPosition = bubbleStartY + padding

    pdf.setFontSize(8)
    setFontForText(pdf, label, 'bold')
    pdf.setTextColor(66, 133, 244)
    pdf.text(label, contentStartX, ctx.yPosition)

    pdf.setFontSize(6)
    pdf.setFont('helvetica', 'normal')
    pdf.setTextColor(140, 140, 140)
    pdf.text(timestamp, bubbleX + bubbleMaxWidth - padding, ctx.yPosition, { align: 'right' })
    ctx.yPosition += 4

    if (msg.attachments && msg.attachments.length > 0) {
      renderAttachmentsInBubble(ctx, msg.attachments, contentStartX, contentMaxWidth)
    }

    if (msg.knowledgeBases && msg.knowledgeBases.length > 0) {
      renderKnowledgeBasesInBubble(ctx, msg.knowledgeBases, contentStartX, contentMaxWidth)
    }

    await renderMessageContentInBubble(ctx, content, contentStartX, contentMaxWidth)

    ctx.yPosition = bubbleEndY + messagePadding
  } else {
    // AI message: render without bubble
    const aiContentWidth = contentWidth

    checkNewPage(ctx, 15 + messagePadding)

    const iconX = margin
    const iconY = ctx.yPosition
    drawBubbleIcon(ctx, iconX, iconY, false, label)

    pdf.setFontSize(8)
    setFontForText(pdf, label, 'bold')
    pdf.setTextColor(PRIMARY_COLOR.r, PRIMARY_COLOR.g, PRIMARY_COLOR.b)
    pdf.text(label, margin + iconSize + 2, ctx.yPosition + 3)

    pdf.setFontSize(6)
    pdf.setFont('helvetica', 'normal')
    pdf.setTextColor(140, 140, 140)
    pdf.text(timestamp, pageWidth - margin, ctx.yPosition + 3, { align: 'right' })
    ctx.yPosition += iconSize + 6 // Increased spacing between header and content

    await renderMessageContentInBubble(ctx, content, margin, aiContentWidth)

    ctx.yPosition += messagePadding
  }
}
