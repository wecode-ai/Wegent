// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { createContext, useContext, useState, useCallback, type ReactNode } from 'react'

/**
 * Maximum length for quoted text before truncation
 */
const MAX_QUOTE_LENGTH = 500

/**
 * Quote state interface
 */
export interface QuoteState {
  /** The quoted text content */
  text: string
  /** Source message ID (optional, for future features) */
  sourceMessageId?: string
}

/**
 * Quote context value interface
 */
interface QuoteContextValue {
  /** Current quote state, null if no quote */
  quote: QuoteState | null
  /** Set a new quote, replacing any existing quote */
  setQuote: (quote: QuoteState | null) => void
  /** Clear the current quote */
  clearQuote: () => void
  /** Format the quote for sending with a message */
  formatQuoteForMessage: (userMessage: string) => string
}

const QuoteContext = createContext<QuoteContextValue | null>(null)

/**
 * Hook to access quote context
 * @throws Error if used outside of QuoteProvider
 */
export function useQuote(): QuoteContextValue {
  const context = useContext(QuoteContext)
  if (!context) {
    throw new Error('useQuote must be used within a QuoteProvider')
  }
  return context
}

/**
 * Truncate text if it exceeds the maximum length
 */
function truncateText(text: string, maxLength: number = MAX_QUOTE_LENGTH): string {
  const trimmed = text.trim()
  if (trimmed.length <= maxLength) {
    return trimmed
  }
  return trimmed.substring(0, maxLength) + '...'
}

/**
 * Provider component for quote state management
 */
export function QuoteProvider({ children }: { children: ReactNode }) {
  const [quote, setQuoteState] = useState<QuoteState | null>(null)

  const setQuote = useCallback((newQuote: QuoteState | null) => {
    if (newQuote) {
      // Truncate text if too long and trim whitespace
      setQuoteState({
        ...newQuote,
        text: truncateText(newQuote.text),
      })
    } else {
      setQuoteState(null)
    }
  }, [])

  const clearQuote = useCallback(() => {
    setQuoteState(null)
  }, [])

  /**
   * Format the quote with user message for sending to AI
   * Uses blockquote markdown format
   */
  const formatQuoteForMessage = useCallback(
    (userMessage: string): string => {
      if (!quote || !quote.text) {
        return userMessage
      }

      // Format quote as markdown blockquote
      const quotedLines = quote.text
        .split('\n')
        .map(line => `> ${line}`)
        .join('\n')

      // Combine quote and user message
      return `${quotedLines}\n\n${userMessage}`
    },
    [quote]
  )

  const value: QuoteContextValue = {
    quote,
    setQuote,
    clearQuote,
    formatQuoteForMessage,
  }

  return <QuoteContext.Provider value={value}>{children}</QuoteContext.Provider>
}

export default QuoteContext
