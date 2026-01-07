// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useState, useEffect, useRef, ReactNode } from 'react'

// Helper function to get initial width from localStorage
const getInitialWidth = (
  storageKey: string,
  defaultWidth: number,
  minWidth: number,
  maxWidth: number
): number => {
  if (typeof window === 'undefined') return defaultWidth
  const savedWidth = localStorage.getItem(storageKey)
  if (savedWidth) {
    const width = parseInt(savedWidth, 10)
    if (width >= minWidth && width <= maxWidth) {
      return width
    }
  }
  return defaultWidth
}

interface ResizableSidebarProps {
  children: ReactNode
  minWidth?: number
  maxWidth?: number
  defaultWidth?: number
  storageKey?: string
  isCollapsed?: boolean
  onToggleCollapsed?: () => void
}

export default function ResizableSidebar({
  children,
  minWidth = 200,
  maxWidth = 500,
  defaultWidth = 244, // 增加 20px，原来是 224px
  storageKey = 'task-sidebar-width',
  isCollapsed = false,
  onToggleCollapsed,
}: ResizableSidebarProps) {
  const COLLAPSED_WIDTH = 0
  const AUTO_COLLAPSE_THRESHOLD = 80

  // Use lazy initialization to get width from localStorage immediately
  const [sidebarWidth, setSidebarWidth] = useState(() =>
    getInitialWidth(storageKey, defaultWidth, minWidth, maxWidth)
  )
  const [isResizing, setIsResizing] = useState(false)
  // Track if initial render is complete to enable transitions
  const [isInitialized, setIsInitialized] = useState(false)
  const sidebarRef = useRef<HTMLDivElement>(null)
  const widthRef = useRef(sidebarWidth)
  const lastExpandedWidthRef = useRef(sidebarWidth)

  // Mark as initialized after first render
  useEffect(() => {
    setIsInitialized(true)
  }, [])

  // Keep widthRef in sync with sidebarWidth
  useEffect(() => {
    widthRef.current = sidebarWidth
    if (!isCollapsed && sidebarWidth > AUTO_COLLAPSE_THRESHOLD) {
      lastExpandedWidthRef.current = sidebarWidth
    }
  }, [sidebarWidth, isCollapsed])

  // Update sidebar width when collapsed state changes
  useEffect(() => {
    if (isCollapsed) {
      setSidebarWidth(COLLAPSED_WIDTH)
    } else {
      setSidebarWidth(lastExpandedWidthRef.current)
    }
  }, [isCollapsed])

  // Save width to localStorage
  const saveWidth = React.useCallback(
    (width: number) => {
      localStorage.setItem(storageKey, width.toString())
    },
    [storageKey]
  )

  // Handle mouse down on resizer
  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault()
    setIsResizing(true)
  }

  // Handle mouse move and mouse up
  useEffect(() => {
    if (!isResizing) return

    const handleMouseMove = (e: MouseEvent) => {
      if (!sidebarRef.current) return

      // Calculate width based on mouse position relative to sidebar's left edge
      const sidebarLeft = sidebarRef.current.getBoundingClientRect().left
      const newWidth = e.clientX - sidebarLeft

      if (newWidth >= minWidth && newWidth <= maxWidth) {
        setSidebarWidth(newWidth)
        // Auto-expand if dragged beyond threshold
        if (newWidth > AUTO_COLLAPSE_THRESHOLD && isCollapsed && onToggleCollapsed) {
          onToggleCollapsed()
        }
      } else if (newWidth <= AUTO_COLLAPSE_THRESHOLD && !isCollapsed && onToggleCollapsed) {
        // Auto-collapse if dragged below threshold
        onToggleCollapsed()
      }
    }

    const handleMouseUp = () => {
      setIsResizing(false)
      saveWidth(widthRef.current)
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
    // Prevent text selection while resizing
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'col-resize'

    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
    }
  }, [isResizing, minWidth, maxWidth, saveWidth, isCollapsed, onToggleCollapsed])

  return (
    <div
      className={`hidden lg:flex relative ${isInitialized ? 'transition-all duration-200' : ''} ${isCollapsed ? '' : 'border-r border-border'}`}
      style={{ width: `${sidebarWidth}px`, overflow: isCollapsed ? 'hidden' : 'visible' }}
    >
      {/* Sidebar content container - hidden when collapsed */}
      {!isCollapsed && (
        <div ref={sidebarRef} className="flex flex-col w-full h-full">
          {children}
        </div>
      )}

      {/* Resizer handle - disabled when collapsed */}
      {!isCollapsed && (
        <div
          className="absolute top-0 right-0 bottom-0 w-1 cursor-col-resize hover:bg-primary/30 transition-colors group"
          onMouseDown={handleMouseDown}
          style={{
            zIndex: 10,
          }}
        >
          {/* Visual indicator on hover */}
          <div className="absolute inset-y-0 -left-1 -right-1 opacity-0 group-hover:opacity-100 transition-opacity" />
        </div>
      )}

      {/* Overlay while resizing to prevent interference */}
      {isResizing && (
        <div
          className="fixed inset-0 z-50"
          style={{
            cursor: 'col-resize',
            userSelect: 'none',
          }}
        />
      )}
    </div>
  )
}
