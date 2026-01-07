// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useRef, useState, useCallback, useMemo } from 'react'
import DOMPurify from 'dompurify'
import {
  ZoomIn,
  ZoomOut,
  RotateCcw,
  Download,
  Copy,
  Check,
  AlertCircle,
  Maximize2,
  X,
  FileImage,
  Code,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslation } from '@/hooks/useTranslation'
import { useTheme } from '@/features/theme/ThemeProvider'

export interface MermaidDiagramProps {
  code: string
  className?: string
}

/**
 * MermaidDiagram Component
 *
 * Renders Mermaid diagram code as interactive SVG with:
 * - Theme adaptation (light/dark)
 * - Zoom in/out controls
 * - Export to PNG/SVG
 * - Copy image to clipboard
 * - Fullscreen modal view
 * - Error handling with fallback to raw code
 */
export function MermaidDiagram({ code, className = '' }: MermaidDiagramProps) {
  const { t } = useTranslation()
  const { theme } = useTheme()
  const containerRef = useRef<HTMLDivElement>(null)
  const diagramRef = useRef<HTMLDivElement>(null)

  const [svgContent, setSvgContent] = useState<string>('')
  const [originalSvgContent, setOriginalSvgContent] = useState<string>('')
  const [error, setError] = useState<string>('')
  const [isLoading, setIsLoading] = useState(true)
  const [scale, setScale] = useState(1)
  const [initialScale, setInitialScale] = useState(1)
  const [baseDimensions, setBaseDimensions] = useState<{ width: number; height: number } | null>(
    null
  )
  const [copied, setCopied] = useState(false)
  const [exportedPng, setExportedPng] = useState(false)
  const [exportedSvg, setExportedSvg] = useState(false)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [showCode, setShowCode] = useState(false)
  const [codeCopied, setCodeCopied] = useState(false)

  // Generate unique ID for this diagram instance
  const diagramId = useMemo(() => `mermaid-${Math.random().toString(36).substr(2, 9)}`, [])

  // Mermaid theme configuration based on current theme
  const getMermaidConfig = useCallback(() => {
    const isDark = theme === 'dark'

    return {
      startOnLoad: false,
      suppressErrorRendering: true,
      theme: 'base' as const,
      themeVariables: isDark
        ? {
            // Dark theme variables
            primaryColor: '#1e293b',
            primaryTextColor: '#e2e8f0',
            primaryBorderColor: '#475569',
            lineColor: '#64748b',
            secondaryColor: '#334155',
            tertiaryColor: '#1e293b',
            background: '#0f172a',
            mainBkg: '#1e293b',
            secondBkg: '#334155',
            mainContrastColor: '#e2e8f0',
            darkTextColor: '#e2e8f0',
            textColor: '#e2e8f0',
            labelTextColor: '#e2e8f0',
            signalTextColor: '#e2e8f0',
            actorBkg: '#1e293b',
            actorBorder: '#14b8a6',
            actorTextColor: '#e2e8f0',
            actorLineColor: '#475569',
            noteBkgColor: '#854d0e',
            noteBorderColor: '#fbbf24',
            noteTextColor: '#fef3c7',
            activationBkgColor: '#0c4a6e',
            activationBorderColor: '#0ea5e9',
            sequenceNumberColor: '#ffffff',
          }
        : {
            // Light theme variables
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
    }
  }, [theme])

  // Sanitize SVG content to prevent XSS attacks
  const sanitizeSvg = useCallback((svg: string): string => {
    // Configure DOMPurify to allow SVG elements and attributes
    // Include HTML elements that Mermaid uses inside foreignObject for text rendering
    return DOMPurify.sanitize(svg, {
      USE_PROFILES: { svg: true, svgFilters: true, html: true },
      ADD_TAGS: [
        'foreignObject',
        // HTML elements used by Mermaid inside foreignObject
        'div',
        'span',
        'p',
        'br',
        'b',
        'i',
        'strong',
        'em',
        'code',
        'pre',
      ],
      ADD_ATTR: [
        'target',
        'xlink:href',
        'marker-end',
        'marker-start',
        // Attributes for foreignObject
        'requiredExtensions',
        'requiredFeatures',
        // Style and class attributes for HTML elements inside foreignObject
        'style',
        'class',
        'xmlns',
        // Data attributes used by Mermaid
        'data-id',
        'data-node',
        'data-label',
      ],
      // Allow style elements for Mermaid's inline styles
      ALLOW_DATA_ATTR: true,
      // Keep the structure intact
      WHOLE_DOCUMENT: false,
      RETURN_DOM: false,
      RETURN_DOM_FRAGMENT: false,
    })
  }, [])

  // Get SVG dimensions from SVG string
  const getSvgDimensions = useCallback((svg: string): { width: number; height: number } | null => {
    const tempDiv = document.createElement('div')
    tempDiv.innerHTML = svg
    const svgElement = tempDiv.querySelector('svg')

    if (!svgElement) return null

    // Get SVG dimensions from attributes or viewBox
    const widthAttr = svgElement.getAttribute('width')
    const heightAttr = svgElement.getAttribute('height')
    const viewBox = svgElement.getAttribute('viewBox')

    let svgWidth = 0
    let svgHeight = 0

    if (widthAttr && heightAttr) {
      // Remove 'px' suffix if present
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

    // If still no dimensions, use default
    if (!svgWidth || !svgHeight) {
      return { width: 800, height: 600 }
    }

    return { width: svgWidth, height: svgHeight }
  }, [])

  // Calculate optimal initial scale based on SVG dimensions
  // Default to 100% to ensure diagram fits within container
  const calculateInitialScale = useCallback(
    (_dimensions: { width: number; height: number } | null): number => {
      // Always use 100% as default to avoid overflow
      return 1
    },
    []
  )

  // Scale SVG by modifying its width/height attributes (lossless scaling)
  const scaleSvg = useCallback(
    (
      svg: string,
      dimensions: { width: number; height: number } | null,
      scaleValue: number
    ): string => {
      if (!dimensions) return svg

      const tempDiv = document.createElement('div')
      tempDiv.innerHTML = svg
      const svgElement = tempDiv.querySelector('svg')

      if (!svgElement) return svg

      const newWidth = Math.round(dimensions.width * scaleValue)
      const newHeight = Math.round(dimensions.height * scaleValue)

      // Set new dimensions with px suffix for consistency
      svgElement.setAttribute('width', `${newWidth}px`)
      svgElement.setAttribute('height', `${newHeight}px`)

      // Also set style to ensure dimensions are applied
      svgElement.style.width = `${newWidth}px`
      svgElement.style.height = `${newHeight}px`
      svgElement.style.minWidth = `${newWidth}px`
      svgElement.style.minHeight = `${newHeight}px`

      // Ensure viewBox is set for proper scaling
      if (!svgElement.getAttribute('viewBox')) {
        svgElement.setAttribute('viewBox', `0 0 ${dimensions.width} ${dimensions.height}`)
      }

      return tempDiv.innerHTML
    },
    []
  )

  // Render Mermaid diagram
  useEffect(() => {
    let isMounted = true

    const renderDiagram = async () => {
      if (!code.trim()) {
        setError('Empty diagram code')
        setIsLoading(false)
        return
      }

      try {
        setIsLoading(true)
        setError('')

        // Dynamically import mermaid to avoid SSR issues
        const mermaid = (await import('mermaid')).default

        // Initialize with current theme config
        mermaid.initialize(getMermaidConfig())

        // Render the diagram
        const { svg } = await mermaid.render(diagramId, code.trim())

        if (isMounted) {
          // Get original dimensions
          const dimensions = getSvgDimensions(svg)
          setBaseDimensions(dimensions)

          // Calculate optimal initial scale for this diagram
          const optimalScale = calculateInitialScale(dimensions)
          setInitialScale(optimalScale)
          setScale(optimalScale)

          // Store original SVG and sanitize
          const sanitizedSvg = sanitizeSvg(svg)
          setOriginalSvgContent(sanitizedSvg)

          // Apply initial scale to SVG
          const scaledSvg = scaleSvg(sanitizedSvg, dimensions, optimalScale)
          setSvgContent(scaledSvg)
          setIsLoading(false)
        }
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : 'Unknown error'

        if (isMounted) {
          console.error('Mermaid render error:', errorMessage)
          setError(errorMessage)
          setIsLoading(false)
        }
      }
    }

    renderDiagram()

    return () => {
      isMounted = false
    }
  }, [
    code,
    theme,
    diagramId,
    getMermaidConfig,
    sanitizeSvg,
    getSvgDimensions,
    calculateInitialScale,
    scaleSvg,
  ])

  // Update SVG when scale changes
  useEffect(() => {
    if (originalSvgContent && baseDimensions) {
      const scaledSvg = scaleSvg(originalSvgContent, baseDimensions, scale)
      setSvgContent(scaledSvg)
    }
  }, [scale, originalSvgContent, baseDimensions, scaleSvg])

  // Zoom controls
  const zoomIn = useCallback(() => {
    setScale(prev => Math.min(prev + 0.25, 3))
  }, [])

  const zoomOut = useCallback(() => {
    setScale(prev => Math.max(prev - 0.25, 0.5))
  }, [])

  const resetZoom = useCallback(() => {
    setScale(initialScale)
  }, [initialScale])

  // Copy image to clipboard
  const copyImage = useCallback(async () => {
    if (!svgContent) return

    try {
      // Create a temporary container to get the SVG element
      const tempDiv = document.createElement('div')
      tempDiv.innerHTML = svgContent
      const svgElement = tempDiv.querySelector('svg')

      if (!svgElement) {
        console.error('SVG element not found')
        return
      }

      // Get SVG dimensions
      const bbox = svgElement.getBBox?.() || { width: 800, height: 600 }
      const width = Math.max(bbox.width + 40, parseInt(svgElement.getAttribute('width') || '800'))
      const height = Math.max(
        bbox.height + 40,
        parseInt(svgElement.getAttribute('height') || '600')
      )

      // Set explicit dimensions on SVG
      svgElement.setAttribute('width', String(width))
      svgElement.setAttribute('height', String(height))

      // Create canvas
      const canvas = document.createElement('canvas')
      const ctx = canvas.getContext('2d')
      if (!ctx) return

      // Set canvas size with device pixel ratio for better quality
      const dpr = window.devicePixelRatio || 1
      canvas.width = width * dpr
      canvas.height = height * dpr
      ctx.scale(dpr, dpr)

      // Fill background
      ctx.fillStyle = theme === 'dark' ? '#0f172a' : '#ffffff'
      ctx.fillRect(0, 0, width, height)

      // Convert SVG to data URL
      const svgData = new XMLSerializer().serializeToString(svgElement)
      const svgBlob = new Blob([svgData], { type: 'image/svg+xml;charset=utf-8' })
      const svgUrl = URL.createObjectURL(svgBlob)

      // Load image and draw to canvas
      const img = new Image()
      img.onload = async () => {
        ctx.drawImage(img, 20, 20, width - 40, height - 40)
        URL.revokeObjectURL(svgUrl)

        // Copy to clipboard as PNG
        canvas.toBlob(async blob => {
          if (blob) {
            try {
              await navigator.clipboard.write([
                new ClipboardItem({
                  'image/png': blob,
                }),
              ])
              setCopied(true)
              setTimeout(() => setCopied(false), 2000)
            } catch (clipboardErr) {
              console.error('Failed to copy to clipboard:', clipboardErr)
            }
          }
        }, 'image/png')
      }
      img.src = svgUrl
    } catch (err) {
      console.error('Failed to copy image:', err)
    }
  }, [svgContent, theme])

  // Copy source code to clipboard (for error state and code modal)
  const copyCode = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(code)
      setCodeCopied(true)
      setTimeout(() => setCodeCopied(false), 2000)
    } catch (err) {
      console.error('Failed to copy:', err)
    }
  }, [code])

  // Toggle code view modal
  const toggleCodeView = useCallback(() => {
    setShowCode(prev => !prev)
  }, [])

  // Export to PNG
  const exportPng = useCallback(async () => {
    if (!svgContent) return

    try {
      // Create a temporary container to get the SVG element
      const tempDiv = document.createElement('div')
      tempDiv.innerHTML = svgContent
      const svgElement = tempDiv.querySelector('svg')

      if (!svgElement) {
        console.error('SVG element not found')
        return
      }

      // Get SVG dimensions
      const bbox = svgElement.getBBox?.() || { width: 800, height: 600 }
      const width = Math.max(bbox.width + 40, parseInt(svgElement.getAttribute('width') || '800'))
      const height = Math.max(
        bbox.height + 40,
        parseInt(svgElement.getAttribute('height') || '600')
      )

      // Set explicit dimensions on SVG
      svgElement.setAttribute('width', String(width))
      svgElement.setAttribute('height', String(height))

      // Create canvas
      const canvas = document.createElement('canvas')
      const ctx = canvas.getContext('2d')
      if (!ctx) return

      // Set canvas size with device pixel ratio for better quality
      const dpr = window.devicePixelRatio || 1
      canvas.width = width * dpr
      canvas.height = height * dpr
      ctx.scale(dpr, dpr)

      // Fill background
      ctx.fillStyle = theme === 'dark' ? '#0f172a' : '#ffffff'
      ctx.fillRect(0, 0, width, height)

      // Convert SVG to data URL
      const svgData = new XMLSerializer().serializeToString(svgElement)
      const svgBlob = new Blob([svgData], { type: 'image/svg+xml;charset=utf-8' })
      const svgUrl = URL.createObjectURL(svgBlob)

      // Load image and draw to canvas
      const img = new Image()
      img.onload = () => {
        ctx.drawImage(img, 20, 20, width - 40, height - 40)
        URL.revokeObjectURL(svgUrl)

        // Download as PNG
        canvas.toBlob(blob => {
          if (blob) {
            const url = URL.createObjectURL(blob)
            const a = document.createElement('a')
            a.href = url
            a.download = `mermaid-diagram-${Date.now()}.png`
            a.click()
            URL.revokeObjectURL(url)
            setExportedPng(true)
            setTimeout(() => setExportedPng(false), 2000)
          }
        }, 'image/png')
      }
      img.src = svgUrl
    } catch (err) {
      console.error('Failed to export PNG:', err)
    }
  }, [svgContent, theme])

  // Export to SVG
  const exportSvg = useCallback(() => {
    if (!svgContent) return

    try {
      // Create a temporary container to get the SVG element
      const tempDiv = document.createElement('div')
      tempDiv.innerHTML = svgContent
      const svgElement = tempDiv.querySelector('svg')

      if (!svgElement) {
        console.error('SVG element not found')
        return
      }

      // Add XML declaration and namespace if not present
      if (!svgElement.getAttribute('xmlns')) {
        svgElement.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
      }

      // Serialize SVG to string
      const svgData = new XMLSerializer().serializeToString(svgElement)
      const svgBlob = new Blob([svgData], { type: 'image/svg+xml;charset=utf-8' })
      const url = URL.createObjectURL(svgBlob)

      // Download as SVG
      const a = document.createElement('a')
      a.href = url
      a.download = `mermaid-diagram-${Date.now()}.svg`
      a.click()
      URL.revokeObjectURL(url)

      setExportedSvg(true)
      setTimeout(() => setExportedSvg(false), 2000)
    } catch (err) {
      console.error('Failed to export SVG:', err)
    }
  }, [svgContent])

  // Toggle fullscreen modal
  const toggleFullscreen = useCallback(() => {
    setIsFullscreen(prev => !prev)
  }, [])

  // Handle ESC key to close fullscreen or code modal
  useEffect(() => {
    if (!isFullscreen && !showCode) return

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (showCode) {
          setShowCode(false)
        } else if (isFullscreen) {
          setIsFullscreen(false)
        }
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [isFullscreen, showCode])

  // Handle wheel zoom
  const handleWheel = useCallback((e: React.WheelEvent) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault()
      const delta = e.deltaY > 0 ? -0.1 : 0.1
      setScale(prev => Math.max(0.5, Math.min(3, prev + delta)))
    }
  }, [])

  // Render error state with raw code
  if (error) {
    return (
      <div className={`my-4 rounded-lg border border-red-300 dark:border-red-800 ${className}`}>
        {/* Error banner */}
        <div className="flex items-center gap-2 px-4 py-2 bg-red-50 dark:bg-red-950/30 border-b border-red-200 dark:border-red-800 rounded-t-lg">
          <AlertCircle className="w-4 h-4 text-red-600 dark:text-red-400" />
          <span className="text-sm font-medium text-red-700 dark:text-red-300">
            {t('chat:mermaid.renderError') || 'Mermaid render failed'}: {error}
          </span>
        </div>
        {/* Raw code display */}
        <div className="p-4 bg-surface overflow-auto">
          <pre className="text-sm font-mono text-text-primary whitespace-pre-wrap">{code}</pre>
        </div>
        {/* Copy button for error state */}
        <div className="flex justify-end px-4 py-2 border-t border-red-200 dark:border-red-800">
          <Button variant="ghost" size="sm" onClick={copyCode} className="text-text-secondary">
            {copied ? <Check className="w-4 h-4 mr-1" /> : <Copy className="w-4 h-4 mr-1" />}
            {copied
              ? t('chat:mermaid.copied') || 'Copied'
              : t('chat:mermaid.copyCode') || 'Copy Code'}
          </Button>
        </div>
      </div>
    )
  }

  // Render loading state
  if (isLoading) {
    return (
      <div
        className={`my-4 p-8 rounded-lg border border-border bg-surface flex items-center justify-center ${className}`}
      >
        <div className="flex items-center gap-3 text-text-secondary">
          <div className="animate-spin rounded-full h-5 w-5 border-2 border-primary border-t-transparent" />
          <span className="text-sm">Loading diagram...</span>
        </div>
      </div>
    )
  }

  // Diagram toolbar
  const Toolbar = ({ inModal = false }: { inModal?: boolean }) => (
    <div className={`flex items-center gap-1 ${inModal ? 'bg-white/10 rounded-lg px-2 py-1' : ''}`}>
      {/* Zoom controls */}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            onClick={zoomOut}
            className={`h-7 w-7 ${inModal ? 'text-white hover:bg-white/10' : 'text-text-secondary hover:text-text-primary'}`}
          >
            <ZoomOut className="w-4 h-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{t('chat:mermaid.zoomOut') || 'Zoom Out'}</TooltipContent>
      </Tooltip>

      <span
        className={`text-xs px-2 min-w-[48px] text-center ${inModal ? 'text-white/70' : 'text-text-muted'}`}
      >
        {Math.round(scale * 100)}%
      </span>

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            onClick={zoomIn}
            className={`h-7 w-7 ${inModal ? 'text-white hover:bg-white/10' : 'text-text-secondary hover:text-text-primary'}`}
          >
            <ZoomIn className="w-4 h-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{t('chat:mermaid.zoomIn') || 'Zoom In'}</TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            onClick={resetZoom}
            className={`h-7 w-7 ${inModal ? 'text-white hover:bg-white/10' : 'text-text-secondary hover:text-text-primary'}`}
          >
            <RotateCcw className="w-4 h-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{t('chat:mermaid.resetZoom') || 'Reset Zoom'}</TooltipContent>
      </Tooltip>

      <div className={`w-px h-4 mx-1 ${inModal ? 'bg-white/20' : 'bg-border'}`} />

      {/* Export PNG */}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            onClick={exportPng}
            className={`h-7 w-7 ${inModal ? 'text-white hover:bg-white/10' : 'text-text-secondary hover:text-text-primary'}`}
          >
            {exportedPng ? (
              <Check className="w-4 h-4 text-green-500" />
            ) : (
              <Download className="w-4 h-4" />
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          {exportedPng
            ? t('chat:mermaid.exportSuccess') || 'Exported'
            : t('chat:mermaid.exportPng') || 'Export PNG'}
        </TooltipContent>
      </Tooltip>

      {/* Export SVG */}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            onClick={exportSvg}
            className={`h-7 w-7 ${inModal ? 'text-white hover:bg-white/10' : 'text-text-secondary hover:text-text-primary'}`}
          >
            {exportedSvg ? (
              <Check className="w-4 h-4 text-green-500" />
            ) : (
              <FileImage className="w-4 h-4" />
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          {exportedSvg
            ? t('chat:mermaid.exportSuccess') || 'Exported'
            : t('chat:mermaid.exportSvg') || 'Export SVG'}
        </TooltipContent>
      </Tooltip>

      {/* Copy image */}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            onClick={copyImage}
            className={`h-7 w-7 ${inModal ? 'text-white hover:bg-white/10' : 'text-text-secondary hover:text-text-primary'}`}
          >
            {copied ? <Check className="w-4 h-4 text-green-500" /> : <Copy className="w-4 h-4" />}
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          {copied
            ? t('chat:mermaid.copied') || 'Copied'
            : t('chat:mermaid.copyImage') || 'Copy Image'}
        </TooltipContent>
      </Tooltip>

      {/* View code button */}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            onClick={toggleCodeView}
            className={`h-7 w-7 ${inModal ? 'text-white hover:bg-white/10' : 'text-text-secondary hover:text-text-primary'}`}
          >
            <Code className="w-4 h-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{t('chat:mermaid.viewCode') || 'View Code'}</TooltipContent>
      </Tooltip>

      {/* Fullscreen toggle (only in non-modal view) */}
      {!inModal && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              onClick={toggleFullscreen}
              className="h-7 w-7 text-text-secondary hover:text-text-primary"
            >
              <Maximize2 className="w-4 h-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Fullscreen</TooltipContent>
        </Tooltip>
      )}
    </div>
  )

  return (
    <>
      {/* Main diagram container */}
      <div
        ref={containerRef}
        className={`my-4 rounded-lg border border-border bg-surface overflow-hidden ${className}`}
      >
        {/* Header with toolbar */}
        <div className="flex items-center justify-between px-4 py-2 border-b border-border bg-surface/50">
          <div className="flex items-center gap-2">
            <svg
              className="w-4 h-4 text-primary"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
              />
            </svg>
            <span className="text-xs font-medium text-text-secondary">
              {t('knowledge:diagram') || 'Diagram'}
            </span>
          </div>
          <Toolbar />
        </div>

        {/* Diagram content */}
        <div
          ref={diagramRef}
          className="p-4 overflow-auto min-h-[200px] max-h-[600px]"
          onWheel={handleWheel}
        >
          <div className="inline-block" style={{ minWidth: 'fit-content' }}>
            <div
              className="transition-all duration-100 ease-out"
              dangerouslySetInnerHTML={{ __html: svgContent }}
            />
          </div>
        </div>
      </div>

      {/* Fullscreen modal */}
      {isFullscreen && (
        <div
          className="fixed inset-0 z-[60] flex flex-col bg-black/80 backdrop-blur-sm"
          onClick={e => {
            // Close when clicking on the backdrop (not on child elements)
            if (e.target === e.currentTarget) {
              toggleFullscreen()
            }
          }}
        >
          {/* Header */}
          <div
            className="flex items-center justify-between px-6 py-4 bg-gradient-to-b from-black/50 to-transparent"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-2 px-3 py-1.5 bg-white/10 rounded-full">
                <svg
                  className="w-4 h-4 text-primary"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                  />
                </svg>
                <span className="text-sm font-medium text-white">
                  {t('knowledge:diagram') || 'Diagram'}
                </span>
              </div>
            </div>

            {/* Controls */}
            <div className="flex items-center gap-2">
              <Toolbar inModal />
              <Button
                variant="ghost"
                size="icon"
                onClick={toggleFullscreen}
                className="h-9 w-9 text-white hover:bg-white/10"
              >
                <X className="w-5 h-5" />
              </Button>
            </div>
          </div>

          {/* Diagram container - click on empty area closes modal */}
          <div
            className="flex-1 overflow-auto flex items-center justify-center p-8"
            onWheel={handleWheel}
            onClick={e => {
              // Close when clicking on the container background (not on the diagram)
              if (e.target === e.currentTarget) {
                toggleFullscreen()
              }
            }}
          >
            <div
              className="bg-white dark:bg-slate-900 rounded-2xl shadow-2xl p-8 max-w-[90vw] max-h-[80vh] overflow-auto transition-all duration-100 ease-out"
              onClick={e => e.stopPropagation()}
              dangerouslySetInnerHTML={{ __html: svgContent }}
            />
          </div>

          {/* Footer hint */}
          <div className="absolute bottom-4 left-1/2 -translate-x-1/2 px-4 py-2 bg-black/50 rounded-full pointer-events-none">
            <span className="text-xs text-white/70">
              ESC or click backdrop to close • Ctrl/Cmd + Scroll to zoom
            </span>
          </div>
        </div>
      )}

      {/* Code view modal */}
      {showCode && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 backdrop-blur-sm"
          onClick={e => {
            if (e.target === e.currentTarget) {
              toggleCodeView()
            }
          }}
        >
          <div
            className="bg-surface rounded-lg border border-border shadow-2xl w-full max-w-2xl max-h-[80vh] flex flex-col m-4"
            onClick={e => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-border">
              <div className="flex items-center gap-2">
                <Code className="w-4 h-4 text-primary" />
                <span className="text-sm font-medium text-text-primary">
                  {t('chat:mermaid.sourceCode') || 'Mermaid Source Code'}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={copyCode}
                  className="text-text-secondary hover:text-text-primary"
                >
                  {codeCopied ? (
                    <>
                      <Check className="w-4 h-4 mr-1 text-green-500" />
                      {t('chat:mermaid.copied') || 'Copied'}
                    </>
                  ) : (
                    <>
                      <Copy className="w-4 h-4 mr-1" />
                      {t('chat:mermaid.copyCode') || 'Copy Code'}
                    </>
                  )}
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={toggleCodeView}
                  className="h-8 w-8 text-text-secondary hover:text-text-primary"
                >
                  <X className="w-4 h-4" />
                </Button>
              </div>
            </div>

            {/* Code content */}
            <div className="flex-1 overflow-auto p-4 bg-slate-50 dark:bg-slate-900/50">
              <pre className="text-sm font-mono text-text-primary whitespace-pre-wrap break-words">
                {code}
              </pre>
            </div>

            {/* Footer hint */}
            <div className="px-4 py-2 border-t border-border text-center">
              <span className="text-xs text-text-muted">
                {t('chat:mermaid.escToClose') || 'Press ESC to close'}
              </span>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

export default MermaidDiagram
