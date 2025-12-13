// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'

/**
 * Global search shortcut hook (Cmd+K / Ctrl+K)
 */
export function useGlobalSearchShortcut() {
  const router = useRouter()

  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      // Cmd+K (Mac) or Ctrl+K (Windows/Linux)
      if ((event.metaKey || event.ctrlKey) && event.key === 'k') {
        event.preventDefault()

        // Navigate to search page
        router.push('/search')
      }
    },
    [router]
  )

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [handleKeyDown])
}
