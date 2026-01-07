// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * PDF Export Constants Module
 * Contains all constant values and configurations for PDF generation
 */

import type { RGBColor, BubbleStyle, BubbleCommonStyle } from './types'

/**
 * Primary color for Wegent brand
 */
export const PRIMARY_COLOR: RGBColor = { r: 20, g: 184, b: 166 } // #14B8A6

/**
 * Colors for markdown rendering
 * Text color changed to #1a1a1a for better readability
 */
export const COLORS = {
  text: { r: 26, g: 26, b: 26 }, // #1a1a1a - deep black for readability
  heading: { r: 26, g: 26, b: 26 }, // #1a1a1a - deep black for readability
  link: { r: 85, g: 185, b: 247 },
  code: { r: 207, g: 34, b: 46 },
  codeBlockBg: { r: 246, g: 248, b: 250 },
  codeBlockText: { r: 26, g: 26, b: 26 }, // #1a1a1a - deep black for readability
  blockquote: { r: 80, g: 80, b: 80 }, // Darker gray for better readability
  listMarker: { r: 80, g: 80, b: 80 }, // Darker gray for better readability
} as const

/**
 * Chat bubble styling configuration
 */
export const BUBBLE_STYLES: {
  user: BubbleStyle
  ai: BubbleStyle
  common: BubbleCommonStyle
} = {
  // User message bubble - light blue/green aligned right
  user: {
    bgColor: { r: 227, g: 242, b: 253 }, // #E3F2FD - light blue
    borderColor: { r: 187, g: 222, b: 251 }, // #BBDEFB - slightly darker blue
    iconText: 'User', // Will be replaced with user icon
    iconBgColor: { r: 66, g: 133, b: 244 }, // #4285F4 - Google blue
  },
  // AI message - no bubble, just plain text
  ai: {
    bgColor: { r: 255, g: 255, b: 255 }, // White - no visible background
    borderColor: { r: 255, g: 255, b: 255 }, // White - no visible border
    iconText: 'AI',
    iconBgColor: { r: 20, g: 184, b: 166 }, // #14B8A6 - Wegent teal
  },
  // Common bubble properties
  common: {
    borderRadius: 3, // mm - reduced for more compact look
    padding: 4, // mm - reduced padding for more compact bubbles
    maxWidthPercent: 0.85, // 85% of content width - wider for better readability
    iconSize: 5, // mm (diameter) - slightly smaller
    messagePadding: 8, // mm spacing between messages - reduced
  },
}

/**
 * Font sizes for different heading levels
 */
export const HEADING_SIZES: Record<string, number> = {
  heading1: 16,
  heading2: 14,
  heading3: 12,
  heading4: 11,
  heading5: 10,
  heading6: 10,
}

/**
 * Line heights for different elements
 */
export const LINE_HEIGHTS: Record<string, number> = {
  heading1: 8,
  heading2: 7,
  heading3: 6,
  heading4: 5.5,
  heading5: 5,
  heading6: 5,
  paragraph: 5,
  list: 5,
  code: 4.5,
  blockquote: 5,
  table: 6,
}

/**
 * Unicode font configuration for extended character support (CJK, etc.)
 * Using Noto Sans SC which supports Latin, CJK and other Unicode characters
 * Font file is stored locally in public/fonts/
 */
export const UNICODE_FONT_PATH = '/fonts/SourceHanSansSC-VF.ttf'
export const UNICODE_FONT_NAME = 'NotoSansSC'

/**
 * Image file extensions
 */
export const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp']

/**
 * PDF page configuration
 */
export const PDF_CONFIG = {
  orientation: 'portrait' as const,
  unit: 'mm' as const,
  format: 'a4' as const,
  margin: 20,
  footerOffset: 10,
  footerPageOffset: 20,
}

/**
 * File type labels for PDF display
 */
export const FILE_TYPE_LABELS: Record<string, string> = {
  // Documents
  pdf: '[PDF]',
  doc: '[DOC]',
  docx: '[DOC]',
  txt: '[TXT]',
  md: '[MD]',
  // Code
  js: '[JS]',
  ts: '[TS]',
  py: '[PY]',
  java: '[JAVA]',
  cpp: '[CPP]',
  c: '[C]',
  // Archives
  zip: '[ZIP]',
  rar: '[RAR]',
  '7z': '[7Z]',
  tar: '[TAR]',
  gz: '[GZ]',
  // Spreadsheets
  xls: '[XLS]',
  xlsx: '[XLSX]',
  csv: '[CSV]',
  // Presentations
  ppt: '[PPT]',
  pptx: '[PPT]',
  // Images
  jpg: '[IMG]',
  jpeg: '[IMG]',
  png: '[IMG]',
  gif: '[IMG]',
  bmp: '[IMG]',
  webp: '[IMG]',
}
