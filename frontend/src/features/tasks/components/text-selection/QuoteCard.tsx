// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React from 'react'
import { X, CornerDownRight } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { useQuote } from './QuoteContext'

/**
 * Maximum characters to display in the quote preview before truncating
 */
const PREVIEW_MAX_LENGTH = 150

/**
 * QuoteCard component displays the quoted text above the chat input.
 * Uses a compact single-line style similar to ChatGPT's quote design:
 * - Left quote icon (corner arrow)
 * - Quoted text with ellipsis for overflow
 * - Right close button
 */
export function QuoteCard() {
  const { t } = useTranslation('chat')
  const { quote, clearQuote } = useQuote()

  // Don't render if no quote
  if (!quote || !quote.text) {
    return null
  }

  // Truncate preview text if too long
  const previewText =
    quote.text.length > PREVIEW_MAX_LENGTH
      ? quote.text.substring(0, PREVIEW_MAX_LENGTH) + '...'
      : quote.text

  return (
    <div className="mx-4 mt-2 mb-2 animate-in slide-in-from-bottom-2 duration-200">
      <div className="flex items-start gap-2 py-2 px-3 bg-surface rounded-xl border border-border/60">
        {/* Quote icon */}
        <CornerDownRight className="flex-shrink-0 h-4 w-4 mt-0.5 text-text-muted" />

        {/* Quote content - single line with ellipsis or multiline preview */}
        <p className="flex-1 min-w-0 text-sm text-text-secondary leading-relaxed line-clamp-3 break-words">
          {previewText}
        </p>

        {/* Close button */}
        <button
          onClick={clearQuote}
          className="flex-shrink-0 p-0.5 rounded-md text-text-muted hover:text-text-primary transition-colors duration-150"
          title={t('quote.remove_quote')}
          aria-label={t('quote.remove_quote')}
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  )
}

export default QuoteCard
