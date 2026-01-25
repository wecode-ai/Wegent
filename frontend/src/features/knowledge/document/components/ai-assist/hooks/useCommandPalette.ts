// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useCallback, useEffect, useRef } from 'react'
import type { _Position } from '../types'

interface UseCommandPaletteOptions {
  /** Container element to listen for shortcuts */
  containerRef?: React.RefObject<HTMLElement | null>
  /** Editor ref to get cursor position */
  editorRef?: React.RefObject<{
    getCursorPosition?: () => _Position | null
    focus?: () => void
  } | null>
  /** Callback when palette opens */
  onOpen?: () => void
  /** Callback when palette closes */
  onClose?: () => void
}

/**
 * Hook to manage command palette state and keyboard shortcuts
 */
export function useCommandPalette(options: UseCommandPaletteOptions = {}) {
  const { containerRef, editorRef, onOpen, onClose } = options

  const [isOpen, setIsOpen] = useState(false)
  const [position, setPosition] = useState<_Position | null>(null)

  const onOpenRef = useRef(onOpen)
  const onCloseRef = useRef(onClose)

  // Keep refs updated
  useEffect(() => {
    onOpenRef.current = onOpen
    onCloseRef.current = onClose
  }, [onOpen, onClose])

  /**
   * Open the command palette
   */
  const openPalette = useCallback((pos?: _Position) => {
    setPosition(pos || null)
    setIsOpen(true)
    onOpenRef.current?.()
  }, [])

  /**
   * Close the command palette
   */
  const closePalette = useCallback(() => {
    setIsOpen(false)
    setPosition(null)
    onCloseRef.current?.()

    // Return focus to editor
    if (editorRef?.current?.focus) {
      editorRef.current.focus()
    }
  }, [editorRef])

  /**
   * Toggle the command palette
   */
  const togglePalette = useCallback(() => {
    if (isOpen) {
      closePalette()
    } else {
      // Get cursor position from editor if available
      let pos: _Position | null = null
      if (editorRef?.current?.getCursorPosition) {
        pos = editorRef.current.getCursorPosition()
      }
      openPalette(pos || undefined)
    }
  }, [isOpen, openPalette, closePalette, editorRef])

  /**
   * Handle keyboard shortcut
   */
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      // Check for Ctrl+K (Windows/Linux) or Cmd+K (macOS)
      const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0
      const modifierKey = isMac ? e.metaKey : e.ctrlKey

      if (modifierKey && e.key === 'k') {
        e.preventDefault()
        e.stopPropagation()
        togglePalette()
      }
    },
    [togglePalette]
  )

  // Set up global keyboard listener
  useEffect(() => {
    const target = containerRef?.current || document

    target.addEventListener('keydown', handleKeyDown as EventListener)

    return () => {
      target.removeEventListener('keydown', handleKeyDown as EventListener)
    }
  }, [containerRef, handleKeyDown])

  // Get shortcut display text
  const shortcutDisplayText = useCallback(() => {
    const isMac =
      typeof navigator !== 'undefined' &&
      navigator.platform.toUpperCase().indexOf('MAC') >= 0
    return isMac ? '⌘K' : 'Ctrl+K'
  }, [])

  return {
    isOpen,
    position,
    openPalette,
    closePalette,
    togglePalette,
    shortcutDisplayText: shortcutDisplayText(),
  }
}

export default useCommandPalette
