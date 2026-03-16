// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useCallback } from 'react'

/**
 * Cleans up selected text by:
 * - Replacing 2+ consecutive newlines with a single newline
 * - Trimming leading/trailing whitespace
 */
export function cleanCopyText(text: string): string {
  return text.replace(/\n{2,}/g, '\n').trim()
}

/**
 * Hook to handle copy events with text cleanup.
 * Fixes the issue where block-level elements create extra newlines when copying.
 */
export function useCopyCleanup() {
  const handleCopy = useCallback((e: React.ClipboardEvent) => {
    const selection = window.getSelection()
    if (!selection || selection.rangeCount === 0) return

    const text = cleanCopyText(selection.toString())
    e.clipboardData.setData('text/plain', text)
    e.preventDefault()
  }, [])

  return handleCopy
}
