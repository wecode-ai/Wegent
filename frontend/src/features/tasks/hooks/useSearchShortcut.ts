// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useMemo, useCallback } from 'react'
import { useUser } from '@/features/common/UserContext'

interface UseSearchShortcutOptions {
  onToggle: () => void
  enabled?: boolean
}

/**
 * Custom hook for global search shortcut (Cmd+K / Ctrl+K or Cmd+F / Ctrl+F)
 * This hook should be used at the page level to ensure the shortcut works
 * regardless of sidebar collapse state.
 */
export function useSearchShortcut({ onToggle, enabled = true }: UseSearchShortcutOptions) {
  const { user } = useUser()

  // Get user's search key preference (default to 'cmd_k')
  const searchKey = user?.preferences?.search_key || 'cmd_k'

  // Detect if Mac or Windows
  const isMac = useMemo(() => {
    if (typeof navigator === 'undefined') return false
    return /Mac|iPod|iPhone|iPad/.test(navigator.platform)
  }, [])

  // Get shortcut display text based on platform and preference
  const shortcutDisplayText = useMemo(() => {
    if (searchKey === 'disabled') return ''
    const key = searchKey === 'cmd_k' ? 'K' : 'F'
    return isMac ? `⌘${key}` : `Ctrl+${key}`
  }, [searchKey, isMac])

  // Stable callback
  const handleToggle = useCallback(() => {
    onToggle()
  }, [onToggle])

  // Global keyboard shortcut listener
  useEffect(() => {
    if (!enabled || searchKey === 'disabled') return

    const handleKeyDown = (e: KeyboardEvent) => {
      const targetKey = searchKey === 'cmd_k' ? 'k' : 'f'
      const isModifierPressed = isMac ? e.metaKey : e.ctrlKey

      if (isModifierPressed && e.key.toLowerCase() === targetKey) {
        e.preventDefault()
        handleToggle()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [enabled, searchKey, isMac, handleToggle])

  return {
    searchKey,
    shortcutDisplayText,
    isMac,
  }
}
