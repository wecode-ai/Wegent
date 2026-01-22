// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

/**
 * Citation Parser Component
 *
 * Parses text content and converts citation markers [n] into clickable CitationLink components.
 * Used to make knowledge base references interactive within message content.
 */

import React from 'react'
import type { SourceReference } from '@/types/socket'
import { CitationLink } from './CitationLink'

interface CitationParserProps {
  /** The text content that may contain citation markers like [1], [2], etc. */
  text: string
  /** All source references for this message */
  sources: SourceReference[]
}

/**
 * Parse text and replace citation markers [n] with clickable components
 */
export function CitationParser({ text, sources }: CitationParserProps) {
  // If no sources, just return plain text
  if (!sources || sources.length === 0) {
    return <>{text}</>
  }

  // Get all valid indices from sources
  const validIndices = new Set(sources.map(s => s.index))

  // Pattern to match citation markers like [1], [2], [12], etc.
  // Only match if the number is a valid source index
  const citationPattern = /\[(\d+)\]/g

  const parts: React.ReactNode[] = []
  let lastIndex = 0
  let match

  while ((match = citationPattern.exec(text)) !== null) {
    const citationIndex = parseInt(match[1], 10)

    // Only create a clickable link if this index exists in sources
    if (validIndices.has(citationIndex)) {
      // Add text before the citation
      if (match.index > lastIndex) {
        parts.push(text.slice(lastIndex, match.index))
      }

      // Add the clickable citation link
      parts.push(
        <CitationLink key={`citation-${match.index}`} index={citationIndex} sources={sources} />
      )

      lastIndex = match.index + match[0].length
    }
  }

  // Add remaining text after the last citation
  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex))
  }

  // If no citations were found, return plain text
  if (parts.length === 0) {
    return <>{text}</>
  }

  return <>{parts}</>
}
