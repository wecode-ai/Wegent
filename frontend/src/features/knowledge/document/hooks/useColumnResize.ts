// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useState, useEffect, useRef, useCallback } from 'react'

/**
 * Hook for resizable table column width via mouse drag.
 *
 * The column keeps its original CSS layout (e.g. flex-1) by default.
 * When the user drags the resize handle, the hook captures the
 * element's rendered width and switches to a fixed pixel value that
 * follows the mouse. The override resets on page reload.
 */
export function useColumnResize() {
  // null = use original CSS layout; number = fixed pixel override
  const [widthOverride, setWidthOverride] = useState<number | null>(null)
  const [isResizing, setIsResizing] = useState(false)
  const widthRef = useRef<number>(0)
  const startXRef = useRef(0)
  const startWidthRef = useRef(0)
  // Ref attached to the column header element so we can measure it
  const columnRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (widthOverride !== null) {
      widthRef.current = widthOverride
    }
  }, [widthOverride])

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    // Measure the current rendered width from the DOM
    const el = columnRef.current
    const currentWidth = el ? el.getBoundingClientRect().width : 200
    startXRef.current = e.clientX
    startWidthRef.current = currentWidth
    widthRef.current = currentWidth
    setWidthOverride(currentWidth)
    setIsResizing(true)
  }, [])

  useEffect(() => {
    if (!isResizing) return

    const MIN_WIDTH = 120
    const MAX_WIDTH = 1200

    const handleMouseMove = (e: MouseEvent) => {
      const delta = e.clientX - startXRef.current
      const newWidth = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, startWidthRef.current + delta))
      widthRef.current = newWidth
      setWidthOverride(newWidth)
    }

    const handleMouseUp = () => {
      setIsResizing(false)
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'col-resize'

    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
    }
  }, [isResizing])

  return { widthOverride, isResizing, handleMouseDown, columnRef }
}
