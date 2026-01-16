// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * PDF Export Module
 * Main entry point - re-exports all public APIs
 */

// Types
export type {
  ExportAttachment,
  ExportKnowledgeBase,
  ExportMessage,
  PdfExportOptions,
  TextSegment,
  ParsedLine,
  LineType,
  TableAlignment,
  FontStyle,
  RGBColor,
  BubbleStyle,
  BubbleCommonStyle,
} from './types'

// Main generator function
export { generateChatPdf } from './generator'

// Utility functions that may be useful externally
export { sanitizeFilename, formatFileSize, isImageExtension } from './utils'

// For backward compatibility, also export as ChatPdfExportOptions
export type { PdfExportOptions as ChatPdfExportOptions } from './types'
