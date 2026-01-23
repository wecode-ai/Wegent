// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Citation Marker Component
 *
 * Renders a clickable/hoverable citation marker [N] that shows a tooltip
 * with the source chunk content on hover.
 */

'use client'

import React from 'react'
import { CitationTooltip } from './CitationTooltip'
import type { CitationSource } from '@/types/knowledge'

interface CitationMarkerProps {
  /** Citation index (1-based) displayed in the marker */
  index: number
  /** Source information for this citation */
  source: CitationSource
}

export function CitationMarker({ index, source }: CitationMarkerProps) {
  return (
    <CitationTooltip source={source}>
      <span
        className="inline-flex items-center justify-center font-mono text-xs text-primary bg-primary/10 px-1 py-0.5 rounded cursor-pointer hover:bg-primary/20 transition-colors"
        data-citation-index={index}
      >
        [{index}]
      </span>
    </CitationTooltip>
  )
}

/**
 * Parse text and replace [N] markers with CitationMarker components.
 *
 * @param text The text content to parse
 * @param sources Array of citation sources
 * @returns Array of React nodes with citations replaced by CitationMarker components
 */
export function parseCitations(text: string, sources: CitationSource[]): React.ReactNode[] {
  if (!sources || sources.length === 0) {
    return [text]
  }

  // Build a map from index to source for quick lookup
  const sourceMap = new Map<number, CitationSource>()
  sources.forEach(source => {
    sourceMap.set(source.index, source)
  })

  // Split by citation pattern [N]
  const parts: React.ReactNode[] = []
  const regex = /\[(\d+)\]/g
  let lastIndex = 0
  let match

  while ((match = regex.exec(text)) !== null) {
    // Add text before the match
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index))
    }

    // Get the citation index
    const citationIndex = parseInt(match[1], 10)
    const source = sourceMap.get(citationIndex)

    if (source) {
      // Add the citation marker component
      parts.push(
        <CitationMarker
          key={`citation-${match.index}-${citationIndex}`}
          index={citationIndex}
          source={source}
        />
      )
    } else {
      // Keep the original text if source not found
      parts.push(match[0])
    }

    lastIndex = regex.lastIndex
  }

  // Add remaining text
  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex))
  }

  return parts
}
