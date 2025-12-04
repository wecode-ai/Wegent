// SPDX-FileCopyrightText: 2025 WeCode, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import jsPDF from 'jspdf'
import html2canvas from 'html2canvas'

/**
 * Message structure for PDF export
 */
export interface ExportMessage {
  type: 'user' | 'ai'
  content: string
  timestamp: number
  botName?: string
}

/**
 * PDF export options
 */
export interface PdfExportOptions {
  taskName: string
  messages: ExportMessage[]
}

/**
 * Primary color for Wegent brand
 */
const PRIMARY_COLOR = { r: 20, g: 184, b: 166 } // #14B8A6

/**
 * Sanitize filename by removing or replacing invalid characters
 */
export function sanitizeFilename(name: string): string {
  return name
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .trim()
}

/**
 * Format date for filename
 */
function formatDateForFilename(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

/**
 * Format timestamp for display
 */
function formatTimestamp(timestamp: number): string {
  if (typeof timestamp !== 'number' || Number.isNaN(timestamp)) return ''
  return new Date(timestamp).toLocaleString(navigator.language, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
}

/**
 * Check if a line is a code block delimiter
 */
function isCodeBlockDelimiter(line: string): boolean {
  return line.trim().startsWith('```')
}

/**
 * Extract language from code block delimiter
 */
function extractCodeLanguage(line: string): string {
  const match = line.trim().match(/^```(\w*)/)
  return match?.[1] || ''
}

/**
 * Simple syntax highlighting colors
 */
const syntaxColors: Record<string, { r: number; g: number; b: number }> = {
  keyword: { r: 207, g: 34, b: 46 }, // Red for keywords
  string: { r: 3, g: 47, b: 98 }, // Dark blue for strings
  comment: { r: 106, g: 115, b: 125 }, // Gray for comments
  number: { r: 0, g: 92, b: 197 }, // Blue for numbers
  default: { r: 36, g: 41, b: 46 }, // Dark gray default
}

/**
 * Keywords for various languages
 */
const keywords = new Set([
  'const', 'let', 'var', 'function', 'class', 'return', 'if', 'else', 'for', 'while',
  'import', 'export', 'from', 'default', 'async', 'await', 'try', 'catch', 'throw',
  'new', 'this', 'super', 'extends', 'implements', 'interface', 'type', 'enum',
  'public', 'private', 'protected', 'static', 'readonly', 'abstract',
  'def', 'class', 'self', 'None', 'True', 'False', 'lambda', 'yield', 'pass',
  'int', 'float', 'double', 'char', 'boolean', 'void', 'string', 'number', 'any',
])

/**
 * Generate PDF from selected messages using a hybrid approach:
 * - Render HTML to canvas for code blocks with syntax highlighting
 * - Use jsPDF text methods for regular text content
 */
export async function generateChatPdf(options: PdfExportOptions): Promise<void> {
  const { taskName, messages } = options

  if (messages.length === 0) {
    throw new Error('No messages to export')
  }

  // Create PDF document (A4 size)
  const pdf = new jsPDF({
    orientation: 'portrait',
    unit: 'mm',
    format: 'a4',
  })

  const pageWidth = pdf.internal.pageSize.getWidth()
  const pageHeight = pdf.internal.pageSize.getHeight()
  const margin = 20
  const contentWidth = pageWidth - margin * 2
  let yPosition = margin

  /**
   * Add header with logo and title
   */
  const addHeader = () => {
    // Logo text (Wegent)
    pdf.setFontSize(24)
    pdf.setTextColor(PRIMARY_COLOR.r, PRIMARY_COLOR.g, PRIMARY_COLOR.b)
    pdf.setFont('helvetica', 'bold')
    pdf.text('Wegent', pageWidth / 2, yPosition, { align: 'center' })
    yPosition += 10

    // Task title
    pdf.setFontSize(16)
    pdf.setTextColor(PRIMARY_COLOR.r, PRIMARY_COLOR.g, PRIMARY_COLOR.b)
    pdf.setFont('helvetica', 'bold')
    const titleLines = pdf.splitTextToSize(taskName, contentWidth)
    pdf.text(titleLines, pageWidth / 2, yPosition, { align: 'center' })
    yPosition += titleLines.length * 7 + 5

    // Divider line
    pdf.setDrawColor(PRIMARY_COLOR.r, PRIMARY_COLOR.g, PRIMARY_COLOR.b)
    pdf.setLineWidth(0.5)
    pdf.line(margin, yPosition, pageWidth - margin, yPosition)
    yPosition += 10
  }

  /**
   * Add footer with watermark
   */
  const addFooter = (pageNum: number) => {
    pdf.setFontSize(8)
    pdf.setTextColor(160, 160, 160)
    pdf.setFont('helvetica', 'normal')
    pdf.text('Exported from Wegent', pageWidth / 2, pageHeight - 10, { align: 'center' })
    pdf.text(`Page ${pageNum}`, pageWidth - margin, pageHeight - 10, { align: 'right' })
  }

  /**
   * Check if we need a new page
   */
  const checkNewPage = (requiredHeight: number, pageNum: { value: number }) => {
    if (yPosition + requiredHeight > pageHeight - 20) {
      addFooter(pageNum.value)
      pdf.addPage()
      pageNum.value++
      yPosition = margin
      return true
    }
    return false
  }

  /**
   * Render code block with syntax highlighting
   */
  const renderCodeBlock = async (code: string, language: string, pageNum: { value: number }) => {
    // Create a temporary container for the code
    const container = document.createElement('div')
    container.style.cssText = `
      position: absolute;
      left: -9999px;
      top: -9999px;
      width: ${contentWidth * 3.78}px;
      font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
      font-size: 12px;
      line-height: 1.5;
      padding: 16px;
      background-color: #f6f8fa;
      border-radius: 8px;
      border: 1px solid #e0e0e0;
      white-space: pre-wrap;
      word-wrap: break-word;
      overflow-wrap: break-word;
    `

    // Apply basic syntax highlighting
    let highlightedCode = code
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')

    // Highlight strings
    highlightedCode = highlightedCode.replace(
      /(["'`])(?:(?!\1)[^\\]|\\.)*\1/g,
      `<span style="color: rgb(${syntaxColors.string.r}, ${syntaxColors.string.g}, ${syntaxColors.string.b})">$&</span>`
    )

    // Highlight comments (single line)
    highlightedCode = highlightedCode.replace(
      /(\/\/.*$|#.*$)/gm,
      `<span style="color: rgb(${syntaxColors.comment.r}, ${syntaxColors.comment.g}, ${syntaxColors.comment.b})">$&</span>`
    )

    // Highlight numbers
    highlightedCode = highlightedCode.replace(
      /\b(\d+\.?\d*)\b/g,
      `<span style="color: rgb(${syntaxColors.number.r}, ${syntaxColors.number.g}, ${syntaxColors.number.b})">$1</span>`
    )

    // Highlight keywords
    const keywordPattern = new RegExp(`\\b(${Array.from(keywords).join('|')})\\b`, 'g')
    highlightedCode = highlightedCode.replace(
      keywordPattern,
      `<span style="color: rgb(${syntaxColors.keyword.r}, ${syntaxColors.keyword.g}, ${syntaxColors.keyword.b}); font-weight: bold">$1</span>`
    )

    container.innerHTML = highlightedCode

    // Add language label if provided
    if (language) {
      const langLabel = document.createElement('div')
      langLabel.style.cssText = `
        position: absolute;
        top: 4px;
        right: 8px;
        font-size: 10px;
        color: #666;
        font-family: Arial, sans-serif;
      `
      langLabel.textContent = language
      container.style.position = 'relative'
      container.appendChild(langLabel)
    }

    document.body.appendChild(container)

    try {
      const canvas = await html2canvas(container, {
        backgroundColor: '#f6f8fa',
        scale: 2,
        logging: false,
      })

      const imgWidth = contentWidth
      const imgHeight = (canvas.height / canvas.width) * imgWidth

      // Check if we need multiple pages for large code blocks
      const maxHeightPerPage = pageHeight - margin * 2 - 20
      let remainingHeight = imgHeight
      let sourceY = 0

      while (remainingHeight > 0) {
        checkNewPage(Math.min(remainingHeight, maxHeightPerPage), pageNum)

        const heightToDraw = Math.min(remainingHeight, pageHeight - yPosition - 20)

        // Calculate the portion of the image to draw
        const sourceHeight = (heightToDraw / imgHeight) * canvas.height

        // Create a temporary canvas for the portion
        const tempCanvas = document.createElement('canvas')
        tempCanvas.width = canvas.width
        tempCanvas.height = sourceHeight
        const ctx = tempCanvas.getContext('2d')
        if (ctx) {
          ctx.drawImage(canvas, 0, sourceY, canvas.width, sourceHeight, 0, 0, canvas.width, sourceHeight)
          const portionImgData = tempCanvas.toDataURL('image/png')
          pdf.addImage(portionImgData, 'PNG', margin, yPosition, imgWidth, heightToDraw)
        }

        yPosition += heightToDraw + 5
        sourceY += sourceHeight
        remainingHeight -= heightToDraw
      }
    } finally {
      document.body.removeChild(container)
    }
  }

  /**
   * Process and render message content
   */
  const renderMessage = async (msg: ExportMessage, pageNum: { value: number }) => {
    const label = msg.type === 'user' ? 'User' : (msg.botName || 'AI')
    const timestamp = formatTimestamp(msg.timestamp)

    // Message header
    checkNewPage(15, pageNum)
    pdf.setFontSize(11)
    pdf.setFont('helvetica', 'bold')
    pdf.setTextColor(msg.type === 'user' ? 60 : PRIMARY_COLOR.r, msg.type === 'user' ? 60 : PRIMARY_COLOR.g, msg.type === 'user' ? 60 : PRIMARY_COLOR.b)
    pdf.text(`${label}:`, margin, yPosition)

    // Timestamp
    pdf.setFontSize(9)
    pdf.setFont('helvetica', 'normal')
    pdf.setTextColor(160, 160, 160)
    pdf.text(timestamp, pageWidth - margin, yPosition, { align: 'right' })
    yPosition += 7

    // Process content - separate code blocks from text
    let content = msg.content

    // Remove special markers like ${$$}$
    content = content.replace(/\$\{\$\$\}\$/g, '\n')
    // Remove progress bar markers
    content = content.replace(/__PROGRESS_BAR__:.*?:\d+/g, '')
    // Remove truncated prompt markers
    content = content.replace(/__PROMPT_TRUNCATED__:.*?::(.*?)(?=\n|$)/g, '$1')

    const lines = content.split('\n')
    let inCodeBlock = false
    let codeBlockContent = ''
    let codeLanguage = ''

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]

      if (isCodeBlockDelimiter(line)) {
        if (!inCodeBlock) {
          // Start of code block
          inCodeBlock = true
          codeLanguage = extractCodeLanguage(line)
          codeBlockContent = ''
        } else {
          // End of code block
          inCodeBlock = false
          if (codeBlockContent.trim()) {
            await renderCodeBlock(codeBlockContent, codeLanguage, pageNum)
          }
          codeBlockContent = ''
          codeLanguage = ''
        }
        continue
      }

      if (inCodeBlock) {
        codeBlockContent += (codeBlockContent ? '\n' : '') + line
      } else {
        // Regular text
        if (line.trim()) {
          pdf.setFontSize(10)
          pdf.setFont('helvetica', 'normal')
          pdf.setTextColor(36, 41, 46)

          const textLines = pdf.splitTextToSize(line, contentWidth)
          for (const textLine of textLines) {
            checkNewPage(6, pageNum)
            pdf.text(textLine, margin, yPosition)
            yPosition += 5
          }
        } else {
          yPosition += 3 // Empty line spacing
        }
      }
    }

    // Handle unclosed code block
    if (inCodeBlock && codeBlockContent.trim()) {
      await renderCodeBlock(codeBlockContent, codeLanguage, pageNum)
    }

    yPosition += 8 // Space between messages
  }

  // Generate PDF content
  const pageNum = { value: 1 }
  addHeader()

  for (const msg of messages) {
    await renderMessage(msg, pageNum)
  }

  addFooter(pageNum.value)

  // Generate filename
  const sanitizedName = sanitizeFilename(taskName)
  const date = formatDateForFilename()
  const filename = `${sanitizedName}_${date}.pdf`

  // Save PDF
  pdf.save(filename)
}

/**
 * Export type for the generator function
 */
export type { PdfExportOptions as ChatPdfExportOptions }
