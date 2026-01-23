// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Citation Tooltip Component
 *
 * Displays a floating tooltip with chunk content when hovering over a citation marker.
 * Uses lazy loading to fetch chunk content only when needed.
 */

'use client'

import React, { useState, useEffect } from 'react'
import { FileText, Loader2 } from 'lucide-react'
import { useCitationContent } from '@/hooks/useCitationContent'
import type { CitationSource } from '@/types/knowledge'

interface CitationTooltipProps {
  source: CitationSource
  children: React.ReactNode
}

export function CitationTooltip({ source, children }: CitationTooltipProps) {
  const [isHovered, setIsHovered] = useState(false)
  const [showTooltip, setShowTooltip] = useState(false)
  const [content, setContent] = useState<string | null>(null)
  const { fetchChunkContent, isLoading, getError, getCachedContent } = useCitationContent()

  // Delay showing tooltip to prevent flicker on quick mouse movements
  useEffect(() => {
    let timer: NodeJS.Timeout | undefined

    if (isHovered) {
      timer = setTimeout(() => setShowTooltip(true), 200)
    } else {
      setShowTooltip(false)
    }

    return () => {
      if (timer) clearTimeout(timer)
    }
  }, [isHovered])

  // Fetch content when tooltip is shown
  useEffect(() => {
    if (showTooltip && !content) {
      // Check cache first
      const cached = getCachedContent(source.document_id, source.chunk_index)
      if (cached) {
        setContent(cached.content)
      } else {
        // Fetch from API
        fetchChunkContent(source.document_id, source.chunk_index).then(result => {
          if (result) {
            setContent(result.content)
          }
        })
      }
    }
  }, [showTooltip, content, source, fetchChunkContent, getCachedContent])

  const loading = isLoading(source.document_id, source.chunk_index)
  const error = getError(source.document_id, source.chunk_index)

  return (
    <span
      className="relative inline-block"
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      {children}

      {showTooltip && (
        <div
          className="absolute z-50 w-[400px] max-h-[300px] overflow-y-auto bg-surface border border-border rounded-lg shadow-lg"
          style={{
            bottom: '100%',
            left: '50%',
            transform: 'translateX(-50%)',
            marginBottom: '8px',
          }}
        >
          {/* Header */}
          <div className="sticky top-0 flex items-center gap-2 px-3 py-2 bg-surface-hover/50 border-b border-border">
            <FileText className="w-4 h-4 text-text-secondary flex-shrink-0" />
            <span className="text-sm font-medium text-text-primary truncate">
              {source.document_name}
            </span>
          </div>

          {/* Content */}
          <div className="p-3">
            {loading && (
              <div className="flex items-center justify-center py-4">
                <Loader2 className="w-5 h-5 animate-spin text-primary" />
                <span className="ml-2 text-sm text-text-secondary">Loading...</span>
              </div>
            )}

            {error && (
              <div className="text-sm text-red-500 py-2">Failed to load chunk content: {error}</div>
            )}

            {!loading && !error && content && (
              <div className="text-sm text-text-primary whitespace-pre-wrap break-words">
                {content}
              </div>
            )}
          </div>
        </div>
      )}
    </span>
  )
}
