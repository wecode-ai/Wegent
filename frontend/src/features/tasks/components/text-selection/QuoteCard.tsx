// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React from 'react'
import { X, Quote } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { useQuote } from './QuoteContext'

/**
 * Maximum characters to display in the quote preview before truncating
 */
const PREVIEW_MAX_LENGTH = 100

/**
 * QuoteCard component displays the quoted text above the chat input.
 * Shows a preview of the quoted text with a close button to remove.
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
    <div className="mx-4 mb-2 animate-in slide-in-from-bottom-2 duration-200">
      <div className="relative bg-surface border border-border rounded-xl p-3 shadow-sm">
        {/* Quote icon and label */}
        <div className="flex items-start gap-2">
          {/* Quote indicator */}
          <div className="flex-shrink-0 w-1 h-full min-h-[24px] bg-primary rounded-full" />

          {/* Quote content */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5 mb-1">
              <Quote className="h-3 w-3 text-primary" />
              <span className="text-xs font-medium text-text-muted">{t('quote.quoted_text')}</span>
            </div>
            <p className="text-sm text-text-secondary leading-relaxed break-words whitespace-pre-wrap">
              {previewText}
            </p>
          </div>

          {/* Close button */}
          <button
            onClick={clearQuote}
            className="flex-shrink-0 p-1 rounded-md
              text-text-muted hover:text-text-primary
              hover:bg-fill-tert transition-colors duration-150"
            title={t('quote.remove_quote')}
            aria-label={t('quote.remove_quote')}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  )
}

export default QuoteCard
