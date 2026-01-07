// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * PDF Mermaid Renderer Module
 * Handles rendering of Mermaid diagrams as images in PDF
 */

import type { RenderContext } from './base'
import { checkNewPage } from './base'
import { PDF_CONFIG } from '../constants'

/**
 * A4 page dimensions in mm
 */
const A4_WIDTH_MM = 210

/**
 * Calculate the full content width for Mermaid diagrams in mm
 * Uses page width minus margins to ensure diagrams use maximum available space
 */
const MERMAID_CONTENT_WIDTH_MM = A4_WIDTH_MM - PDF_CONFIG.margin * 2 // 170mm

/**
 * Convert mm to pixels (assuming 96 DPI)
 * 1 inch = 25.4mm, 1 inch = 96 pixels
 */
const MM_TO_PX = 96 / 25.4

/**
 * Mermaid diagram rendering width in pixels
 * Using full content width for better readability
 */
const MERMAID_RENDER_WIDTH_PX = MERMAID_CONTENT_WIDTH_MM * MM_TO_PX // ~640px

/**
 * Result of SVG to PNG conversion
 */
interface SvgToPngResult {
  dataUrl: string
  width: number
  height: number
}

/**
 * Convert SVG string to PNG data URL
 * Creates a canvas, draws the SVG on it with white background, and returns PNG data URL
 *
 * @param svg - SVG string content
 * @param maxWidth - Maximum width for the output image
 * @returns Promise with PNG data URL and dimensions
 */
async function svgToPng(svg: string, maxWidth: number): Promise<SvgToPngResult> {
  return new Promise((resolve, reject) => {
    try {
      // Create a temporary container to parse SVG
      const tempDiv = document.createElement('div')
      tempDiv.innerHTML = svg
      const svgElement = tempDiv.querySelector('svg')

      if (!svgElement) {
        reject(new Error('SVG element not found'))
        return
      }

      // Get SVG dimensions from attributes or viewBox
      let svgWidth = 0
      let svgHeight = 0

      const widthAttr = svgElement.getAttribute('width')
      const heightAttr = svgElement.getAttribute('height')
      const viewBox = svgElement.getAttribute('viewBox')

      if (widthAttr && heightAttr) {
        svgWidth = parseFloat(widthAttr.replace('px', ''))
        svgHeight = parseFloat(heightAttr.replace('px', ''))
      }

      // If dimensions are still 0, try viewBox
      if ((!svgWidth || !svgHeight) && viewBox) {
        const parts = viewBox.split(/\s+|,/)
        if (parts.length >= 4) {
          svgWidth = parseFloat(parts[2])
          svgHeight = parseFloat(parts[3])
        }
      }

      // Default dimensions if still not found
      if (!svgWidth || !svgHeight) {
        svgWidth = 800
        svgHeight = 600
      }

      // Calculate scaled dimensions to fit within maxWidth
      let outputWidth = svgWidth
      let outputHeight = svgHeight

      if (outputWidth > maxWidth) {
        const scale = maxWidth / outputWidth
        outputWidth = maxWidth
        outputHeight = svgHeight * scale
      }

      // Set explicit dimensions on SVG for proper rendering
      svgElement.setAttribute('width', String(svgWidth))
      svgElement.setAttribute('height', String(svgHeight))

      // Ensure viewBox is set
      if (!svgElement.getAttribute('viewBox')) {
        svgElement.setAttribute('viewBox', `0 0 ${svgWidth} ${svgHeight}`)
      }

      // Remove external image references that could taint the canvas
      // Note: foreignObject elements are kept as they contain text labels
      // When using base64 data URL for SVG, foreignObject content renders correctly
      const images = svgElement.querySelectorAll('image')
      images.forEach(img => {
        const href = img.getAttribute('href') || img.getAttribute('xlink:href')
        // Remove images with external URLs (http/https) as they will taint the canvas
        if (href && (href.startsWith('http://') || href.startsWith('https://'))) {
          img.remove()
        }
      })

      // Create canvas
      const canvas = document.createElement('canvas')
      const ctx = canvas.getContext('2d')

      if (!ctx) {
        reject(new Error('Failed to get canvas context'))
        return
      }

      // Use higher resolution for better quality (2x device pixel ratio)
      const dpr = 2
      canvas.width = outputWidth * dpr
      canvas.height = outputHeight * dpr
      ctx.scale(dpr, dpr)

      // Fill white background
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, outputWidth, outputHeight)

      // Convert SVG to data URL instead of Blob URL to avoid cross-origin issues
      // Using base64 encoded data URL ensures the image is treated as same-origin
      const svgData = new XMLSerializer().serializeToString(svgElement)
      const base64Svg = btoa(unescape(encodeURIComponent(svgData)))
      const svgDataUrl = `data:image/svg+xml;base64,${base64Svg}`

      // Load image and draw to canvas
      const img = new Image()

      // Set crossOrigin to anonymous to handle any remaining cross-origin resources
      img.crossOrigin = 'anonymous'

      img.onload = () => {
        try {
          ctx.drawImage(img, 0, 0, outputWidth, outputHeight)

          // Get PNG data URL
          const dataUrl = canvas.toDataURL('image/png')
          resolve({
            dataUrl,
            width: outputWidth,
            height: outputHeight,
          })
        } catch (canvasError) {
          // If canvas is still tainted, reject with error
          reject(new Error(`Canvas tainted: ${canvasError}`))
        }
      }

      img.onerror = () => {
        reject(new Error('Failed to load SVG image'))
      }

      img.src = svgDataUrl
    } catch (error) {
      reject(error)
    }
  })
}

/**
 * Render a Mermaid diagram as an image in the PDF
 * Dynamically imports mermaid library, renders SVG, converts to PNG, and embeds in PDF
 *
 * Note: Mermaid diagrams are rendered at full page content width for better readability,
 * ignoring the passed maxWidth parameter which may be constrained by message bubble width.
 *
 * @param ctx - PDF render context
 * @param code - Mermaid diagram code
 * @param _startX - Starting X position (ignored, uses page margin instead)
 * @param _maxWidth - Maximum width for the diagram (ignored, uses full content width)
 * @returns Promise that resolves when rendering is complete
 */
export async function renderMermaidDiagram(
  ctx: RenderContext,
  code: string,
  _startX: number,
  _maxWidth: number
): Promise<void> {
  const { pdf, margin } = ctx

  try {
    // Dynamically import mermaid library
    const mermaid = (await import('mermaid')).default

    // Initialize mermaid with light theme configuration matching page display
    // PDF always uses light theme since PDF background is white
    mermaid.initialize({
      startOnLoad: false,
      suppressErrorRendering: true,
      theme: 'base' as const,
      themeVariables: {
        // Light theme variables - matching MermaidDiagram.tsx light mode config
        primaryColor: '#f8fafc',
        primaryTextColor: '#0f172a',
        primaryBorderColor: '#94a3b8',
        lineColor: '#64748b',
        secondaryColor: '#f1f5f9',
        tertiaryColor: '#e2e8f0',
        background: '#ffffff',
        mainBkg: '#f8fafc',
        secondBkg: '#f1f5f9',
        mainContrastColor: '#0f172a',
        darkTextColor: '#0f172a',
        textColor: '#0f172a',
        labelTextColor: '#0f172a',
        signalTextColor: '#0f172a',
        // Sequence diagram specific variables
        actorBkg: '#f8fafc',
        actorBorder: '#14b8a6',
        actorTextColor: '#0f172a',
        actorLineColor: '#cbd5e1',
        noteBkgColor: '#fef9c3',
        noteBorderColor: '#fbbf24',
        noteTextColor: '#1e293b',
        activationBkgColor: '#e0f2fe',
        activationBorderColor: '#0ea5e9',
        sequenceNumberColor: '#ffffff',
      },
      securityLevel: 'strict' as const,
      flowchart: {
        useMaxWidth: true,
        htmlLabels: true,
        curve: 'basis' as const,
        padding: 15,
      },
      sequence: {
        diagramMarginX: 50,
        diagramMarginY: 20,
        actorMargin: 80,
        width: 180,
        height: 65,
        boxMargin: 10,
        boxTextMargin: 5,
        noteMargin: 15,
        messageMargin: 45,
        mirrorActors: true,
        useMaxWidth: true,
        actorFontSize: 14,
        actorFontWeight: 600,
        noteFontSize: 13,
        messageFontSize: 13,
      },
      fontSize: 14,
      fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
    })

    // Generate unique ID for this diagram
    const uniqueId = `mermaid-pdf-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`

    // Render SVG from mermaid code
    const { svg } = await mermaid.render(uniqueId, code.trim())

    // Convert SVG to PNG using full content width for better readability
    // This ensures Mermaid diagrams are rendered at a larger, more readable size
    // regardless of whether they appear in user messages (bubble) or AI messages
    const { dataUrl, width, height } = await svgToPng(svg, MERMAID_RENDER_WIDTH_PX)

    // Calculate height in PDF units (mm)
    // jsPDF uses mm by default, and we need to convert pixel dimensions
    // Assuming 96 DPI for screen, 1 inch = 25.4mm
    const pxToMm = 25.4 / 96
    const pdfWidth = width * pxToMm
    const pdfHeight = height * pxToMm

    // Ensure the diagram doesn't exceed page content width
    // This is a safety check in case the SVG is wider than expected
    const maxPdfWidth = MERMAID_CONTENT_WIDTH_MM
    let finalPdfWidth = pdfWidth
    let finalPdfHeight = pdfHeight

    if (finalPdfWidth > maxPdfWidth) {
      const scale = maxPdfWidth / finalPdfWidth
      finalPdfWidth = maxPdfWidth
      finalPdfHeight = pdfHeight * scale
    }

    // Check if we need a new page for the diagram
    checkNewPage(ctx, finalPdfHeight + 5)

    // Add some spacing before the diagram
    ctx.yPosition += 2

    // Add the image to PDF at page margin (left-aligned for full width display)
    pdf.addImage(
      dataUrl,
      'PNG',
      margin,
      ctx.yPosition,
      finalPdfWidth,
      finalPdfHeight,
      undefined,
      'FAST'
    )

    // Update Y position after the diagram
    ctx.yPosition += finalPdfHeight + 4
  } catch (error) {
    // Log error for debugging
    console.warn('Failed to render Mermaid diagram in PDF:', error)

    // Re-throw to let caller handle fallback
    throw error
  }
}

/**
 * Check if a code block language is mermaid
 *
 * @param language - The language identifier from the code block
 * @returns true if the language is mermaid
 */
export function isMermaidLanguage(language: string): boolean {
  const normalizedLang = language.toLowerCase().trim()
  const isMermaid = normalizedLang === 'mermaid'

  return isMermaid
}
