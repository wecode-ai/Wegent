// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * PDF Generator Module
 * Main entry point for PDF generation
 */

import jsPDF from 'jspdf'
import type { PdfExportOptions } from './types'
import { PDF_CONFIG } from './constants'
import { addUnicodeFontToPdf } from './font'
import { sanitizeFilename, formatDateForFilename } from './utils'
import { createRenderContext, addHeader, addFooter } from './renderers/base'
import { renderMessage } from './renderers/message'

/**
 * Generate PDF from selected messages with full markdown support
 * Uses native jsPDF text rendering to preserve text selectability
 */
export async function generateChatPdf(options: PdfExportOptions): Promise<void> {
  const { taskName, messages } = options

  if (messages.length === 0) {
    throw new Error('No messages to export')
  }

  // Create PDF document (A4 size)
  const pdf = new jsPDF({
    orientation: PDF_CONFIG.orientation,
    unit: PDF_CONFIG.unit,
    format: PDF_CONFIG.format,
  })

  // Load Unicode font for extended character support (CJK, etc.)
  await addUnicodeFontToPdf(pdf)

  // Create render context
  const ctx = createRenderContext(pdf)

  // Add header
  addHeader(ctx, taskName)

  // Render all messages (async for mermaid diagram support)
  for (const msg of messages) {
    await renderMessage(ctx, msg)
  }

  // Add footer to last page
  addFooter(ctx)

  // Generate filename
  const sanitizedName = sanitizeFilename(taskName)
  const date = formatDateForFilename()
  const filename = `${sanitizedName}_${date}.pdf`

  // Save PDF
  pdf.save(filename)
}
