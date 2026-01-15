// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * PDF Export Types Module
 * Contains all type definitions for PDF generation
 */

import type jsPDF from 'jspdf'

/**
 * Attachment info for PDF export
 */
export interface ExportAttachment {
  id: number
  filename: string
  file_size: number
  file_extension: string
  /** Base64 encoded image data (for images only, loaded before PDF generation) */
  imageData?: string
}

/**
 * Knowledge base info for PDF export
 */
export interface ExportKnowledgeBase {
  id: number
  name: string
  document_count?: number
}

/**
 * Message structure for PDF export
 */
export interface ExportMessage {
  type: 'user' | 'ai'
  content: string
  timestamp: number
  botName?: string
  userName?: string
  teamName?: string
  attachments?: ExportAttachment[]
  knowledgeBases?: ExportKnowledgeBase[]
}

/**
 * PDF export options
 */
export interface PdfExportOptions {
  taskName: string
  messages: ExportMessage[]
}

/**
 * RGB color type
 */
export interface RGBColor {
  r: number
  g: number
  b: number
}

/**
 * Parsed text segment with style information
 */
export interface TextSegment {
  text: string
  bold?: boolean
  italic?: boolean
  code?: boolean
  link?: string
  strikethrough?: boolean
  /** Whether this segment is a math formula */
  math?: boolean
  /** Whether this is a block-level (display) math formula */
  mathDisplay?: boolean
}

/**
 * Markdown line types
 */
export type LineType =
  | 'heading1'
  | 'heading2'
  | 'heading3'
  | 'heading4'
  | 'heading5'
  | 'heading6'
  | 'unorderedList'
  | 'orderedList'
  | 'blockquote'
  | 'horizontalRule'
  | 'tableSeparator'
  | 'tableRow'
  | 'paragraph'
  | 'empty'
  | 'mathBlock'

/**
 * Parsed line structure
 */
export interface ParsedLine {
  type: LineType
  content: string
  level?: number // For headings and lists
  listNumber?: number // For ordered lists
  tableCells?: string[] // For table rows
  tableAlignments?: ('left' | 'center' | 'right')[] // For table separator
  mathContent?: string // For math blocks (raw LaTeX content)
}

/**
 * Bubble style configuration
 */
export interface BubbleStyle {
  bgColor: RGBColor
  borderColor: RGBColor
  iconText: string
  iconBgColor: RGBColor
}

/**
 * Common bubble properties
 */
export interface BubbleCommonStyle {
  borderRadius: number
  padding: number
  maxWidthPercent: number
  iconSize: number
  messagePadding: number
}

/**
 * PDF rendering context
 */
export interface PdfRenderContext {
  pdf: jsPDF
  pageWidth: number
  pageHeight: number
  margin: number
  contentWidth: number
  yPosition: number
  pageNum: { value: number }
}

/**
 * Font style type
 */
export type FontStyle = 'normal' | 'bold' | 'italic' | 'bolditalic'

/**
 * Table alignment type
 */
export type TableAlignment = 'left' | 'center' | 'right'
