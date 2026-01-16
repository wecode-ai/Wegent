// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useEffect, useCallback, useRef } from 'react'

interface TextSelectionState {
  /** The selected text */
  text: string
  /** Position for the tooltip (relative to viewport) */
  position: { top: number; left: number }
  /** Whether the selection is valid for quoting */
  isValid: boolean
}

interface UseTextSelectionOptions {
  /** CSS selector for the container to monitor for text selection */
  containerSelector?: string
  /** Minimum text length to trigger selection UI */
  minLength?: number
  /** Delay in ms before showing the tooltip after selection stabilizes */
  showDelay?: number
}

/**
 * Hook to detect and track text selection within a specific container.
 * Mimics ChatGPT behavior:
 * - Shows tooltip after selection stabilizes (with delay)
 * - Tooltip stays visible once shown, regardless of mouse movement
 * - Only hides when selection is cleared or user clicks elsewhere
 *
 * @param options Configuration options
 * @returns Text selection state and handlers
 */
export function useTextSelection(options: UseTextSelectionOptions = {}) {
  const {
    containerSelector = '[data-chat-container]',
    minLength = 1,
    showDelay = 300, // Delay before showing tooltip (like ChatGPT)
  } = options

  const [selection, setSelection] = useState<TextSelectionState | null>(null)
  const [isLocked, setIsLocked] = useState(false) // Lock state to prevent tooltip from disappearing

  // Refs for tracking state
  const showTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const lastSelectionTextRef = useRef<string>('')
  const isMouseDownRef = useRef(false)

  /**
   * Check if the selection is within the allowed container
   */
  const isSelectionInContainer = useCallback(
    (sel: Selection): boolean => {
      if (!sel.rangeCount) return false

      const range = sel.getRangeAt(0)
      const container = range.commonAncestorContainer

      // Get the element (handle text nodes)
      const element =
        container.nodeType === Node.TEXT_NODE ? container.parentElement : (container as Element)

      if (!element) return false

      // Check if the element is within a chat container
      const chatContainer = element.closest(containerSelector)
      if (!chatContainer) return false

      // Check if the selection is within a message bubble (AI or user message)
      const messageBubble = element.closest('[data-message-content]')
      return !!messageBubble
    },
    [containerSelector]
  )

  /**
   * Calculate tooltip position based on selection
   */
  const calculatePosition = useCallback((sel: Selection): { top: number; left: number } | null => {
    if (!sel.rangeCount) return null

    const range = sel.getRangeAt(0)
    const rect = range.getBoundingClientRect()

    // Ensure we have valid dimensions
    if (rect.width === 0 && rect.height === 0) return null

    // Position above the selection, centered horizontally
    return {
      top: rect.top - 8, // 8px above the selection
      left: rect.left + rect.width / 2, // Centered
    }
  }, [])

  /**
   * Get current valid selection info
   */
  const getValidSelection = useCallback((): {
    text: string
    position: { top: number; left: number }
  } | null => {
    const sel = window.getSelection()
    if (!sel || sel.isCollapsed) return null

    const selectedText = sel.toString().trim()
    if (selectedText.length < minLength) return null
    if (!isSelectionInContainer(sel)) return null

    const position = calculatePosition(sel)
    if (!position) return null

    return { text: selectedText, position }
  }, [minLength, isSelectionInContainer, calculatePosition])

  /**
   * Schedule showing the tooltip after delay
   * This mimics ChatGPT's behavior where tooltip appears after selection stabilizes
   */
  const scheduleShowTooltip = useCallback(() => {
    // Clear any pending show timeout
    if (showTimeoutRef.current) {
      clearTimeout(showTimeoutRef.current)
      showTimeoutRef.current = null
    }

    // Don't schedule if mouse is still down (user is still selecting)
    if (isMouseDownRef.current) return

    const validSelection = getValidSelection()
    if (!validSelection) return

    // Schedule showing the tooltip
    showTimeoutRef.current = setTimeout(() => {
      // Re-check selection is still valid when timeout fires
      const currentSelection = getValidSelection()
      if (currentSelection) {
        setSelection({
          text: currentSelection.text,
          position: currentSelection.position,
          isValid: true,
        })
        setIsLocked(true) // Lock the tooltip so it doesn't disappear on mouse move
        lastSelectionTextRef.current = currentSelection.text
      }
    }, showDelay)
  }, [getValidSelection, showDelay])

  /**
   * Check if selection has been cleared
   */
  const checkSelectionCleared = useCallback(() => {
    const sel = window.getSelection()
    const currentText = sel?.toString().trim() || ''

    // If selection is empty or collapsed, clear the tooltip
    if (!sel || sel.isCollapsed || currentText.length === 0) {
      // Clear any pending timeout
      if (showTimeoutRef.current) {
        clearTimeout(showTimeoutRef.current)
        showTimeoutRef.current = null
      }
      setSelection(null)
      setIsLocked(false)
      lastSelectionTextRef.current = ''
      return true
    }

    return false
  }, [])

  /**
   * Handle selection change events
   */
  const handleSelectionChange = useCallback(() => {
    // First check if selection was cleared
    if (checkSelectionCleared()) return

    // If tooltip is locked (already showing), don't update position
    // This prevents the tooltip from jumping around when user moves mouse
    if (isLocked) {
      // But still check if the selection text changed significantly
      const sel = window.getSelection()
      const currentText = sel?.toString().trim() || ''

      // If selection text changed, update it but keep position locked
      if (currentText && currentText !== lastSelectionTextRef.current) {
        // Check if still in valid container
        if (sel && isSelectionInContainer(sel)) {
          setSelection(prev =>
            prev
              ? {
                  ...prev,
                  text: currentText,
                }
              : null
          )
          lastSelectionTextRef.current = currentText
        }
      }
      return
    }

    // If mouse is down, don't show tooltip yet (user is still selecting)
    if (isMouseDownRef.current) return

    // Schedule showing the tooltip
    scheduleShowTooltip()
  }, [isLocked, checkSelectionCleared, scheduleShowTooltip, isSelectionInContainer])

  /**
   * Handle mouse down - track when user starts selecting
   */
  const handleMouseDown = useCallback(
    (e: MouseEvent) => {
      isMouseDownRef.current = true

      // Clear any pending show timeout
      if (showTimeoutRef.current) {
        clearTimeout(showTimeoutRef.current)
        showTimeoutRef.current = null
      }

      // If clicking outside the tooltip and selection area, clear selection
      const target = e.target as Element
      const isClickOnTooltip = target.closest('[data-selection-tooltip]')
      const isClickOnMessage = target.closest('[data-message-content]')

      if (!isClickOnTooltip && !isClickOnMessage && isLocked) {
        // User clicked outside, clear the selection
        setSelection(null)
        setIsLocked(false)
        lastSelectionTextRef.current = ''
      }
    },
    [isLocked]
  )

  /**
   * Handle mouse up - check for selection after user finishes selecting
   */
  const handleMouseUp = useCallback(() => {
    isMouseDownRef.current = false

    // Small delay to let browser finalize selection
    setTimeout(() => {
      // Check if there's a valid selection
      const validSelection = getValidSelection()
      if (validSelection) {
        // Schedule showing the tooltip
        scheduleShowTooltip()
      }
    }, 10)
  }, [getValidSelection, scheduleShowTooltip])

  /**
   * Clear the current selection
   */
  const clearSelection = useCallback(() => {
    if (showTimeoutRef.current) {
      clearTimeout(showTimeoutRef.current)
      showTimeoutRef.current = null
    }
    setSelection(null)
    setIsLocked(false)
    lastSelectionTextRef.current = ''
    window.getSelection()?.removeAllRanges()
  }, [])

  // Set up event listeners
  useEffect(() => {
    document.addEventListener('mousedown', handleMouseDown)
    document.addEventListener('mouseup', handleMouseUp)
    document.addEventListener('selectionchange', handleSelectionChange)

    return () => {
      document.removeEventListener('mousedown', handleMouseDown)
      document.removeEventListener('mouseup', handleMouseUp)
      document.removeEventListener('selectionchange', handleSelectionChange)

      if (showTimeoutRef.current) {
        clearTimeout(showTimeoutRef.current)
      }
    }
  }, [handleMouseDown, handleMouseUp, handleSelectionChange])

  return {
    selection,
    clearSelection,
    isLocked,
  }
}

export default useTextSelection
