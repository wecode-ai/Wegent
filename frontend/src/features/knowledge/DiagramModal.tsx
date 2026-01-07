// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useCallback, useState, useRef } from 'react'
import {
  XMarkIcon,
  MagnifyingGlassPlusIcon,
  MagnifyingGlassMinusIcon,
  ArrowsPointingOutIcon,
} from '@heroicons/react/24/outline'

interface DiagramModalProps {
  isOpen: boolean
  onClose: () => void
  diagramContent: string
  title?: string
}

/**
 * Fullscreen modal for viewing Mermaid diagrams
 * Features:
 * - Zoom in/out controls
 * - Pan support with drag
 * - Keyboard shortcuts (Esc to close, +/- to zoom)
 * - Reset zoom button
 */
export function DiagramModal({
  isOpen,
  onClose,
  diagramContent,
  title = 'Diagram',
}: DiagramModalProps) {
  const [scale, setScale] = useState(1)
  const [position, setPosition] = useState({ x: 0, y: 0 })
  const [isDragging, setIsDragging] = useState(false)
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 })
  const containerRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)

  // Reset state when modal opens
  useEffect(() => {
    if (isOpen) {
      setScale(1)
      setPosition({ x: 0, y: 0 })
    }
  }, [isOpen])

  // Handle keyboard shortcuts
  useEffect(() => {
    if (!isOpen) return

    const handleKeyDown = (e: KeyboardEvent) => {
      switch (e.key) {
        case 'Escape':
          onClose()
          break
        case '+':
        case '=':
          setScale(prev => Math.min(prev + 0.25, 3))
          break
        case '-':
          setScale(prev => Math.max(prev - 0.25, 0.5))
          break
        case '0':
          setScale(1)
          setPosition({ x: 0, y: 0 })
          break
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, onClose])

  // Handle wheel zoom
  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault()
    const delta = e.deltaY > 0 ? -0.1 : 0.1
    setScale(prev => Math.max(0.5, Math.min(3, prev + delta)))
  }, [])

  // Handle drag start
  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0) return // Only left mouse button
      setIsDragging(true)
      setDragStart({ x: e.clientX - position.x, y: e.clientY - position.y })
    },
    [position]
  )

  // Handle drag move
  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (!isDragging) return
      setPosition({
        x: e.clientX - dragStart.x,
        y: e.clientY - dragStart.y,
      })
    },
    [isDragging, dragStart]
  )

  // Handle drag end
  const handleMouseUp = useCallback(() => {
    setIsDragging(false)
  }, [])

  // Zoom controls
  const zoomIn = useCallback(() => {
    setScale(prev => Math.min(prev + 0.25, 3))
  }, [])

  const zoomOut = useCallback(() => {
    setScale(prev => Math.max(prev - 0.25, 0.5))
  }, [])

  const resetZoom = useCallback(() => {
    setScale(1)
    setPosition({ x: 0, y: 0 })
  }, [])

  if (!isOpen) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/80 backdrop-blur-sm" onClick={onClose} />

      {/* Modal content */}
      <div className="relative w-full h-full flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 bg-gradient-to-b from-black/50 to-transparent">
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
              <span className="text-sm font-medium text-white">{title}</span>
            </div>
            <span className="text-xs text-white/50">{Math.round(scale * 100)}%</span>
          </div>

          {/* Controls */}
          <div className="flex items-center gap-2">
            {/* Zoom controls */}
            <div className="flex items-center gap-1 px-2 py-1 bg-white/10 rounded-lg">
              <button
                onClick={zoomOut}
                className="p-1.5 hover:bg-white/10 rounded transition-colors"
                title="Zoom out (-)"
              >
                <MagnifyingGlassMinusIcon className="w-4 h-4 text-white" />
              </button>
              <button
                onClick={resetZoom}
                className="px-2 py-1 text-xs text-white hover:bg-white/10 rounded transition-colors"
                title="Reset zoom (0)"
              >
                Reset
              </button>
              <button
                onClick={zoomIn}
                className="p-1.5 hover:bg-white/10 rounded transition-colors"
                title="Zoom in (+)"
              >
                <MagnifyingGlassPlusIcon className="w-4 h-4 text-white" />
              </button>
            </div>

            {/* Fit to screen */}
            <button
              onClick={resetZoom}
              className="p-2 hover:bg-white/10 rounded-lg transition-colors"
              title="Fit to screen"
            >
              <ArrowsPointingOutIcon className="w-5 h-5 text-white" />
            </button>

            {/* Close button */}
            <button
              onClick={onClose}
              className="p-2 hover:bg-white/10 rounded-lg transition-colors"
              title="Close (Esc)"
            >
              <XMarkIcon className="w-5 h-5 text-white" />
            </button>
          </div>
        </div>

        {/* Diagram container */}
        <div
          ref={containerRef}
          className="flex-1 overflow-hidden cursor-grab active:cursor-grabbing"
          onWheel={handleWheel}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
        >
          <div
            ref={contentRef}
            className="w-full h-full flex items-center justify-center"
            style={{
              transform: `translate(${position.x}px, ${position.y}px) scale(${scale})`,
              transition: isDragging ? 'none' : 'transform 0.1s ease-out',
            }}
          >
            {/* Diagram wrapper with white background */}
            <div className="bg-white rounded-2xl shadow-2xl p-8 max-w-[90vw] max-h-[80vh] overflow-auto">
              <div
                className="mermaid-fullscreen"
                dangerouslySetInnerHTML={{ __html: diagramContent }}
              />
            </div>
          </div>
        </div>

        {/* Footer hint */}
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 px-4 py-2 bg-black/50 rounded-full">
          <span className="text-xs text-white/70">
            Scroll to zoom • Drag to pan • Press Esc to close
          </span>
        </div>
      </div>
    </div>
  )
}
