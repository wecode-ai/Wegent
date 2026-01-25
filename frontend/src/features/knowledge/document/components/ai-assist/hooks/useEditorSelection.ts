// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import type { EditorSelection, _Position } from '../types'

interface UseEditorSelectionOptions {
  /** Container element or selector to monitor */
  containerRef: React.RefObject<HTMLElement>
  /** Minimum text length to trigger selection */
  minLength?: number
  /** Delay in ms before updating selection state */
  debounceMs?: number
  /** Callback when selection changes */
  onSelectionChange?: (selection: EditorSelection | null) => void
}

/**
 * Hook to track text selection within an editor container
 */
export function useEditorSelection(options: UseEditorSelectionOptions) {
  const {
    containerRef,
    minLength = 1,
    debounceMs = 100,
    onSelectionChange,
  } = options

  const [selection, setSelection] = useState<EditorSelection | null>(null)
  const debounceTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const onSelectionChangeRef = useRef(onSelectionChange)

  // Keep callback ref updated
  useEffect(() => {
    onSelectionChangeRef.current = onSelectionChange
  }, [onSelectionChange])

  /**
   * Check if selection is within the container
   */
  const isSelectionInContainer = useCallback(
    (sel: Selection): boolean => {
      if (!sel.rangeCount || !containerRef.current) return false

      const range = sel.getRangeAt(0)
      const container = range.commonAncestorContainer

      // Get the element (handle text nodes)
      const element =
        container.nodeType === Node.TEXT_NODE
          ? container.parentElement
          : (container as Element)

      if (!element) return false

      return containerRef.current.contains(element)
    },
    [containerRef]
  )

  /**
   * Calculate position for floating UI
   */
  const calculatePosition = useCallback((sel: Selection): _Position | null => {
    if (!sel.rangeCount) return null

    const range = sel.getRangeAt(0)
    const rect = range.getBoundingClientRect()

    if (rect.width === 0 && rect.height === 0) return null

    return {
      top: rect.top,
      left: rect.left + rect.width / 2,
    }
  }, [])

  /**
   * Get current selection state
   */
  const getCurrentSelection = useCallback((): EditorSelection | null => {
    const sel = window.getSelection()
    if (!sel || sel.isCollapsed) return null

    const selectedText = sel.toString()
    if (selectedText.length < minLength) return null
    if (!isSelectionInContainer(sel)) return null

    const position = calculatePosition(sel)
    if (!position) return null

    // Get character offsets
    const range = sel.getRangeAt(0)
    const preCaretRange = range.cloneRange()
    preCaretRange.selectNodeContents(containerRef.current!)
    preCaretRange.setEnd(range.startContainer, range.startOffset)
    const from = preCaretRange.toString().length

    const to = from + selectedText.length

    return {
      text: selectedText,
      from,
      to,
      position,
    }
  }, [minLength, isSelectionInContainer, calculatePosition, containerRef])

  /**
   * Handle selection change
   */
  const handleSelectionChange = useCallback(() => {
    if (debounceTimeoutRef.current) {
      clearTimeout(debounceTimeoutRef.current)
    }

    debounceTimeoutRef.current = setTimeout(() => {
      const newSelection = getCurrentSelection()
      setSelection(newSelection)
      onSelectionChangeRef.current?.(newSelection)
    }, debounceMs)
  }, [getCurrentSelection, debounceMs])

  /**
   * Clear selection
   */
  const clearSelection = useCallback(() => {
    setSelection(null)
    onSelectionChangeRef.current?.(null)
    window.getSelection()?.removeAllRanges()
  }, [])

  // Set up event listeners
  useEffect(() => {
    document.addEventListener('selectionchange', handleSelectionChange)

    return () => {
      document.removeEventListener('selectionchange', handleSelectionChange)
      if (debounceTimeoutRef.current) {
        clearTimeout(debounceTimeoutRef.current)
      }
    }
  }, [handleSelectionChange])

  return {
    selection,
    clearSelection,
    getCurrentSelection,
  }
}

export default useEditorSelection
