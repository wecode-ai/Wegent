// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useRef, useState, useCallback, useMemo } from 'react'
import { createPortal } from 'react-dom'
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
  const [portalRoot, setPortalRoot] = useState<HTMLElement | null>(null)

  // Generate unique ID for this diagram instance
  const diagramId = useMemo(() => `mermaid-${Math.random().toString(36).substr(2, 9)}`, [])

  // Mermaid theme configuration based on current theme
  const getMermaidConfig = useCallback(() => {
    const isDark = theme === 'dark'

    return {
      startOnLoad: false,
      suppressErrorRendering: true,
      look: 'neo' as const,
      theme: 'base' as const,
      themeVariables: isDark
        ? {
            // Dark theme variables
            background: '#0b1120',
            primaryColor: '#132033',
            primaryTextColor: '#f8fafc',
            primaryBorderColor: '#2dd4bf',
            lineColor: '#7dd3fc',
            secondaryColor: '#18243a',
            tertiaryColor: '#0f172a',
            mainBkg: '#132033',
            secondBkg: '#18243a',
            mainContrastColor: '#f8fafc',
            darkTextColor: '#f8fafc',
            textColor: '#f8fafc',
            labelTextColor: '#f8fafc',
            signalTextColor: '#f8fafc',
            nodeTextColor: '#f8fafc',
            actorBkg: '#132033',
            actorBorder: '#2dd4bf',
            actorTextColor: '#f8fafc',
            actorLineColor: '#334155',
            noteBkgColor: '#422006',
            noteBorderColor: '#f59e0b',
            noteTextColor: '#fffbeb',
            activationBkgColor: '#082f49',
            activationBorderColor: '#38bdf8',
            sequenceNumberColor: '#ffffff',
            edgeLabelBackground: '#0b1120',
            clusterBkg: '#111827',
            clusterBorder: '#334155',
            fontFamily:
              'Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
          }
        : {
            // Light theme variables
            background: '#ffffff',
            primaryColor: '#ffffff',
            primaryTextColor: '#111827',
            primaryBorderColor: '#14b8a6',
            lineColor: '#0f766e',
            secondaryColor: '#f8fafc',
            tertiaryColor: '#eef2f7',
            mainBkg: '#ffffff',
            secondBkg: '#f8fafc',
            mainContrastColor: '#111827',
            darkTextColor: '#111827',
            textColor: '#111827',
            labelTextColor: '#111827',
            signalTextColor: '#111827',
            nodeTextColor: '#111827',
            actorBkg: '#ffffff',
            actorBorder: '#14b8a6',
            actorTextColor: '#111827',
            actorLineColor: '#cbd5e1',
            noteBkgColor: '#fff7ed',
            noteBorderColor: '#fb923c',
            noteTextColor: '#7c2d12',
            activationBkgColor: '#ecfeff',
            activationBorderColor: '#06b6d4',
            sequenceNumberColor: '#ffffff',
            edgeLabelBackground: '#ffffff',
            clusterBkg: '#f8fafc',
            clusterBorder: '#cbd5e1',
            fontFamily:
              'Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
          },
      securityLevel: 'strict' as const,
      htmlLabels: false,
      flowchart: {
        useMaxWidth: true,
        curve: 'basis' as const,
        padding: 15,
        nodeSpacing: 52,
        rankSpacing: 58,
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
      fontFamily: 'Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      themeCSS: `
        .node rect,
        .node circle,
        .node ellipse,
        .node polygon,
        .node path {
          filter: drop-shadow(0 8px 20px rgba(15, 23, 42, 0.08));
          stroke-width: 1.5px !important;
        }

        .edgePath .path,
        .flowchart-link {
          stroke-width: 1.7px !important;
        }

        .edgeLabel,
        .labelBkg {
          border-radius: 6px;
        }

        text,
        .nodeLabel,
        .edgeLabel,
        .messageText,
        .actor {
          font-family: Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif !important;
          paint-order: stroke fill;
          stroke: transparent;
        }
      `,
    }
  }, [theme])

  // Sanitize SVG content to prevent XSS attacks
  const sanitizeSvg = useCallback((svg: string): string => {
    // Configure DOMPurify to allow SVG elements and attributes
    // Include HTML elements that Mermaid uses inside foreignObject for text rendering
    return DOMPurify.sanitize(svg, {
      USE_PROFILES: { svg: true, svgFilters: true, html: true },
      ADD_TAGS: [
        'style',
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
      FORBID_TAGS: ['script'],
      FORBID_ATTR: ['onerror', 'onload', 'onclick', 'onmouseover'],
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

      // Convert SVG to base64 data URL to avoid cross-origin/tainted canvas issues
      const svgData = new XMLSerializer().serializeToString(svgElement)
      const base64Svg = btoa(unescape(encodeURIComponent(svgData)))
      const svgDataUrl = `data:image/svg+xml;base64,${base64Svg}`

      // Load image and draw to canvas
      const img = new Image()
      img.crossOrigin = 'anonymous'

      img.onload = async () => {
        ctx.drawImage(img, 20, 20, width - 40, height - 40)

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

      img.onerror = () => {
        console.error('Failed to load SVG image for clipboard copy')
      }

      img.src = svgDataUrl
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

      // Convert SVG to base64 data URL to avoid cross-origin/tainted canvas issues
      const svgData = new XMLSerializer().serializeToString(svgElement)
      const base64Svg = btoa(unescape(encodeURIComponent(svgData)))
      const svgDataUrl = `data:image/svg+xml;base64,${base64Svg}`

      // Load image and draw to canvas
      const img = new Image()
      img.crossOrigin = 'anonymous'

      img.onload = () => {
        ctx.drawImage(img, 20, 20, width - 40, height - 40)

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

      img.onerror = () => {
        console.error('Failed to load SVG image for PNG export')
      }

      img.src = svgDataUrl
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

  useEffect(() => {
    setPortalRoot(document.body)
  }, [])

  useEffect(() => {
    if (!isFullscreen) return

    const originalOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    return () => {
      document.body.style.overflow = originalOverflow
    }
  }, [isFullscreen])

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
      <div
        className={`my-4 overflow-hidden rounded-lg border border-red-200 bg-white shadow-sm dark:border-red-900/70 dark:bg-slate-950 ${className}`}
      >
        {/* Error banner */}
        <div className="flex items-center gap-2 border-b border-red-100 bg-red-50 px-4 py-2 dark:border-red-900/70 dark:bg-red-950/30">
          <AlertCircle className="w-4 h-4 text-red-600 dark:text-red-400" />
          <span className="text-sm font-medium text-red-700 dark:text-red-300">
            {t('chat:mermaid.renderError') || 'Mermaid render failed'}: {error}
          </span>
        </div>
        {/* Raw code display */}
        <div className="max-h-[420px] overflow-auto bg-slate-50 p-4 dark:bg-slate-950">
          <pre className="text-sm font-mono text-text-primary whitespace-pre-wrap">{code}</pre>
        </div>
        {/* Copy button for error state */}
        <div className="flex justify-end border-t border-red-100 px-4 py-2 dark:border-red-900/70">
          <Button
            variant="ghost"
            size="sm"
            onClick={copyCode}
            className="text-text-secondary"
            data-testid="mermaid-copy-error-code-button"
          >
            {codeCopied ? <Check className="w-4 h-4 mr-1" /> : <Copy className="w-4 h-4 mr-1" />}
            {codeCopied
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
        className={`my-4 flex items-center justify-center rounded-lg border border-border/70 bg-white p-8 shadow-sm dark:bg-slate-950 ${className}`}
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
    <div className={`flex items-center gap-1 ${inModal ? 'rounded-lg bg-white/10 px-2 py-1' : ''}`}>
      {/* Zoom controls */}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            onClick={zoomOut}
            className={`h-8 w-8 rounded-md ${inModal ? 'text-white hover:bg-white/10' : 'text-text-secondary hover:bg-surface-hover hover:text-text-primary'}`}
            data-testid="mermaid-zoom-out-button"
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
            className={`h-8 w-8 rounded-md ${inModal ? 'text-white hover:bg-white/10' : 'text-text-secondary hover:bg-surface-hover hover:text-text-primary'}`}
            data-testid="mermaid-zoom-in-button"
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
            className={`h-8 w-8 rounded-md ${inModal ? 'text-white hover:bg-white/10' : 'text-text-secondary hover:bg-surface-hover hover:text-text-primary'}`}
            data-testid="mermaid-reset-zoom-button"
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
            className={`h-8 w-8 rounded-md ${inModal ? 'text-white hover:bg-white/10' : 'text-text-secondary hover:bg-surface-hover hover:text-text-primary'}`}
            data-testid="mermaid-export-png-button"
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
            className={`h-8 w-8 rounded-md ${inModal ? 'text-white hover:bg-white/10' : 'text-text-secondary hover:bg-surface-hover hover:text-text-primary'}`}
            data-testid="mermaid-export-svg-button"
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
            className={`h-8 w-8 rounded-md ${inModal ? 'text-white hover:bg-white/10' : 'text-text-secondary hover:bg-surface-hover hover:text-text-primary'}`}
            data-testid="mermaid-copy-image-button"
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
            className={`h-8 w-8 rounded-md ${inModal ? 'text-white hover:bg-white/10' : 'text-text-secondary hover:bg-surface-hover hover:text-text-primary'}`}
            data-testid="mermaid-view-code-button"
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
              className="h-8 w-8 rounded-md text-text-secondary hover:bg-surface-hover hover:text-text-primary"
              data-testid="mermaid-fullscreen-button"
            >
              <Maximize2 className="w-4 h-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Fullscreen</TooltipContent>
        </Tooltip>
      )}
    </div>
  )

  const fullscreenModal =
    isFullscreen && portalRoot
      ? createPortal(
          <div
            className="fixed inset-0 z-[1000] flex h-screen w-screen flex-col bg-black/80 backdrop-blur-sm"
            data-testid="mermaid-fullscreen-modal"
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
                  data-testid="mermaid-fullscreen-close-button"
                >
                  <X className="w-5 h-5" />
                </Button>
              </div>
            </div>

            {/* Diagram container - click on empty area closes modal */}
            <div
              className="flex flex-1 items-center justify-center overflow-auto p-8"
              onWheel={handleWheel}
              onClick={e => {
                // Close when clicking on the container background (not on the diagram)
                if (e.target === e.currentTarget) {
                  toggleFullscreen()
                }
              }}
            >
              <div
                className="max-h-[calc(100vh-8rem)] max-w-[calc(100vw-4rem)] overflow-auto rounded-2xl bg-white p-8 shadow-2xl transition-all duration-100 ease-out dark:bg-slate-900"
                onClick={e => e.stopPropagation()}
                dangerouslySetInnerHTML={{ __html: svgContent }}
              />
            </div>

            {/* Footer hint */}
            <div className="pointer-events-none absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full bg-black/50 px-4 py-2">
              <span className="text-xs text-white/70">
                ESC or click backdrop to close • Ctrl/Cmd + Scroll to zoom
              </span>
            </div>
          </div>,
          portalRoot
        )
      : null

  return (
    <>
      {/* Main diagram container */}
      <div
        ref={containerRef}
        className={`group/mermaid my-4 overflow-hidden rounded-lg border border-border/80 bg-white shadow-sm dark:bg-slate-950 ${className}`}
        data-testid="mermaid-diagram"
      >
        {/* Header with toolbar */}
        <div className="flex items-center justify-between gap-3 border-b border-border/70 bg-slate-50/80 px-3 py-2 dark:bg-slate-900/70 sm:px-4">
          <div className="flex items-center gap-2">
            <div className="h-2 w-2 rounded-full bg-primary shadow-[0_0_0_4px_rgba(20,184,166,0.12)]" />
            <span className="text-xs font-medium text-text-secondary">
              {t('knowledge:diagram') || 'Diagram'}
            </span>
          </div>
          <div className="shrink-0 overflow-x-auto">
            <Toolbar />
          </div>
        </div>

        {/* Diagram content */}
        <div
          ref={diagramRef}
          className="max-h-[620px] min-h-[220px] overflow-auto bg-[radial-gradient(circle_at_1px_1px,rgba(148,163,184,0.20)_1px,transparent_0)] bg-[length:20px_20px] p-4 dark:bg-[radial-gradient(circle_at_1px_1px,rgba(71,85,105,0.35)_1px,transparent_0)] sm:p-6"
          onWheel={handleWheel}
        >
          <div className="flex min-w-fit justify-center">
            <div
              className="rounded-md bg-white/90 p-4 transition-all duration-100 ease-out dark:bg-slate-950/80"
              dangerouslySetInnerHTML={{ __html: svgContent }}
            />
          </div>
        </div>
      </div>

      {fullscreenModal}

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
