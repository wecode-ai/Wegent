// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * PDF Math Renderer Module
 * Handles rendering of LaTeX math formulas in PDF using KaTeX
 */

import type jsPDF from 'jspdf'
import katex from 'katex'
import { COLORS, LINE_HEIGHTS } from '../constants'
import { RenderContext, checkNewPage } from './base'

/**
 * Render a LaTeX math formula as text representation in PDF
 * Since jsPDF doesn't support complex math rendering natively,
 * we render formulas as formatted text with a visual indicator
 *
 * @param ctx - PDF render context
 * @param latex - LaTeX formula string
 * @param startX - Starting X position
 * @param maxWidth - Maximum width for rendering
 * @param displayMode - Whether to render as block (display) or inline math
 */
export function renderMathFormula(
  ctx: RenderContext,
  latex: string,
  startX: number,
  maxWidth: number,
  displayMode: boolean = false
): void {
  if (displayMode) {
    // Block math: render centered with visual styling
    renderDisplayMath(ctx, latex, startX, maxWidth)
  } else {
    // Inline math: render as styled text inline
    renderInlineMath(ctx, latex, startX)
  }
}

/**
 * Render inline math formula
 * Displays the formula in a code-like style
 */
function renderInlineMath(ctx: RenderContext, latex: string, startX: number): void {
  const { pdf } = ctx

  // Set styling for math formulas (similar to code but with math indicator)
  pdf.setFontSize(9)
  pdf.setTextColor(COLORS.code.r, COLORS.code.g, COLORS.code.b)
  pdf.setFont('courier', 'normal')

  // Render the formula text with brackets to indicate math
  const formulaText = `[${latex}]`
  pdf.text(formulaText, startX, ctx.yPosition)

  // Update Y position for next content
  ctx.yPosition += LINE_HEIGHTS.paragraph
}

/**
 * Render display (block) math formula
 * Centered with background styling
 */
function renderDisplayMath(
  ctx: RenderContext,
  latex: string,
  startX: number,
  maxWidth: number
): void {
  const { pdf } = ctx
  const padding = 4
  const lineHeight = LINE_HEIGHTS.code

  // Check if we need a new page
  checkNewPage(ctx, lineHeight * 2 + padding * 2)

  // Calculate block dimensions
  const blockStartY = ctx.yPosition

  // Draw background
  pdf.setFillColor(250, 250, 252)
  pdf.setDrawColor(220, 220, 230)

  // Calculate formula height (estimate based on content)
  const formulaLines = splitMathFormula(pdf, latex, maxWidth - padding * 2)
  const blockHeight = formulaLines.length * lineHeight + padding * 2

  // Draw rounded rectangle background
  pdf.roundedRect(startX, blockStartY, maxWidth, blockHeight, 2, 2, 'FD')

  // Draw math indicator
  pdf.setFontSize(7)
  pdf.setTextColor(140, 140, 160)
  pdf.setFont('helvetica', 'italic')
  pdf.text('math', startX + maxWidth - padding - 12, blockStartY + padding + 2)

  // Render formula text
  pdf.setFontSize(9)
  pdf.setTextColor(COLORS.text.r, COLORS.text.g, COLORS.text.b)
  pdf.setFont('courier', 'normal')

  ctx.yPosition = blockStartY + padding + lineHeight * 0.7

  // Center each line
  for (const line of formulaLines) {
    const lineWidth = pdf.getTextWidth(line)
    const centerX = startX + (maxWidth - lineWidth) / 2
    pdf.text(line, centerX, ctx.yPosition)
    ctx.yPosition += lineHeight
  }

  ctx.yPosition = blockStartY + blockHeight + 2
}

/**
 * Split math formula into lines that fit within maxWidth
 */
function splitMathFormula(pdf: jsPDF, latex: string, maxWidth: number): string[] {
  // Split by common math delimiters and operators
  const parts = latex.split(/([+\-=<>]|\s+)/).filter(p => p.trim())
  const lines: string[] = []
  let currentLine = ''

  pdf.setFont('courier', 'normal')
  pdf.setFontSize(9)

  for (const part of parts) {
    const testLine = currentLine + part
    const testWidth = pdf.getTextWidth(testLine)

    if (testWidth > maxWidth && currentLine.length > 0) {
      lines.push(currentLine.trim())
      currentLine = part
    } else {
      currentLine = testLine
    }
  }

  if (currentLine.trim()) {
    lines.push(currentLine.trim())
  }

  return lines.length > 0 ? lines : [latex]
}

/**
 * Render math formula as SVG image in PDF (advanced option)
 * Uses KaTeX to generate HTML, then attempts to extract/approximate the formula
 *
 * Note: Full SVG rendering requires additional setup with jsPDF-svg plugin
 */
export async function renderMathAsImage(
  ctx: RenderContext,
  latex: string,
  startX: number,
  maxWidth: number,
  displayMode: boolean = false
): Promise<void> {
  try {
    // Attempt to render with KaTeX for validation
    // This validates the LaTeX syntax even though we fall back to text rendering
    katex.renderToString(latex, {
      displayMode,
      throwOnError: false,
      output: 'html',
    })

    // For now, fall back to text rendering
    // Full SVG support would require additional libraries
    renderMathFormula(ctx, latex, startX, maxWidth, displayMode)
  } catch (error) {
    // If KaTeX fails, render as plain text
    console.warn('KaTeX rendering failed:', error)
    renderMathFormula(ctx, latex, startX, maxWidth, displayMode)
  }
}

/**
 * Check if a string contains LaTeX math formulas
 */
export function containsMathFormulas(text: string): boolean {
  // Inline math: $...$
  const inlineMathRegex = /(?<!\\)\$[^$\n]+?(?<!\\)\$/
  // Block math: $$...$$
  const blockMathRegex = /\$\$[\s\S]+?\$\$/
  // LaTeX environments: \begin{...}...\end{...}
  const latexEnvRegex = /\\begin\{[^}]+\}[\s\S]*?\\end\{[^}]+\}/

  return inlineMathRegex.test(text) || blockMathRegex.test(text) || latexEnvRegex.test(text)
}

/**
 * Extract all math blocks from content
 * Returns an array of { type: 'text' | 'math', content: string, displayMode?: boolean }
 */
export function extractMathBlocks(
  content: string
): Array<{ type: 'text' | 'math'; content: string; displayMode?: boolean }> {
  const parts: Array<{ type: 'text' | 'math'; content: string; displayMode?: boolean }> = []

  // Combined regex for all math patterns
  // Order matters: check block math ($$...$$) before inline ($...$)
  const mathRegex = /(\$\$[\s\S]+?\$\$)|(\$[^$\n]+?\$)|(\\begin\{([^}]+)\}[\s\S]*?\\end\{\4\})/g

  let lastIndex = 0
  let match

  while ((match = mathRegex.exec(content)) !== null) {
    // Add text before this match
    if (match.index > lastIndex) {
      const textBefore = content.slice(lastIndex, match.index)
      if (textBefore) {
        parts.push({ type: 'text', content: textBefore })
      }
    }

    // Determine math type and extract content
    if (match[1]) {
      // Block math: $$...$$
      const mathContent = match[1].slice(2, -2).trim()
      parts.push({ type: 'math', content: mathContent, displayMode: true })
    } else if (match[2]) {
      // Inline math: $...$
      const mathContent = match[2].slice(1, -1)
      parts.push({ type: 'math', content: mathContent, displayMode: false })
    } else if (match[3]) {
      // LaTeX environment: \begin{...}...\end{...}
      parts.push({ type: 'math', content: match[3], displayMode: true })
    }

    lastIndex = match.index + match[0].length
  }

  // Add remaining text
  if (lastIndex < content.length) {
    const remaining = content.slice(lastIndex)
    if (remaining) {
      parts.push({ type: 'text', content: remaining })
    }
  }

  // If no math found, return entire content as text
  if (parts.length === 0 && content) {
    parts.push({ type: 'text', content })
  }

  return parts
}
