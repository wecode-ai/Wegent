// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

/**
 * Citation Link Component
 *
 * Renders a clickable citation marker [n] that shows a preview tooltip
 * and allows navigation to chunk details.
 */

import React, { useState, useRef, useCallback } from 'react'
import type { SourceReference } from '@/types/socket'
import { ChunkPreviewTooltip } from './ChunkPreviewTooltip'
import { SourceChunkDialog } from './SourceChunkDialog'

interface CitationLinkProps {
  /** The citation index number (1-based) */
  index: number
  /** All source references for this message */
  sources: SourceReference[]
}

export function CitationLink({ index, sources }: CitationLinkProps) {
  const [tooltipSource, setTooltipSource] = useState<SourceReference | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [selectedIndex, setSelectedIndex] = useState(index)
  const buttonRef = useRef<HTMLButtonElement>(null)

  // Find the source with matching index
  const source = sources.find(s => s.index === index)

  const handleClick = useCallback(() => {
    if (!source) {
      // If no source found, just open dialog at this index
      setSelectedIndex(index)
      setDialogOpen(true)
      return
    }

    // If content_preview is available, show tooltip first
    if (source.content_preview) {
      setTooltipSource(source)
    } else {
      // Otherwise, go directly to dialog
      setSelectedIndex(source.index)
      setDialogOpen(true)
    }
  }, [source, index])

  const handleViewDetail = useCallback(() => {
    if (tooltipSource) {
      setSelectedIndex(tooltipSource.index)
      setTooltipSource(null)
      setDialogOpen(true)
    }
  }, [tooltipSource])

  const handleCloseTooltip = useCallback(() => {
    setTooltipSource(null)
  }, [])

  return (
    <>
      <button
        ref={buttonRef}
        onClick={handleClick}
        className="inline-flex items-center justify-center font-mono text-xs text-primary hover:text-primary-dark hover:bg-primary/10 px-0.5 rounded cursor-pointer transition-colors"
        title={source?.title || `Reference ${index}`}
      >
        [{index}]
      </button>

      {/* Tooltip for quick preview */}
      {tooltipSource && (
        <ChunkPreviewTooltip
          source={tooltipSource}
          anchorRef={buttonRef}
          onClose={handleCloseTooltip}
          onViewDetail={handleViewDetail}
        />
      )}

      {/* Dialog for detailed view */}
      <SourceChunkDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        sources={sources}
        initialSourceIndex={selectedIndex}
      />
    </>
  )
}
