// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

/**
 * Chunk Preview Tooltip Component
 *
 * Displays a preview of a knowledge base chunk when hovering over a citation reference.
 * Shows chunk content preview with options to view full details or original document.
 */

import React, { useEffect, useRef } from 'react'
import { FileText, ExternalLink, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import type { SourceReference } from '@/types/socket'

interface ChunkPreviewTooltipProps {
  source: SourceReference
  anchorRef: React.RefObject<HTMLElement | null>
  onClose: () => void
  onViewDetail: () => void
}

export function ChunkPreviewTooltip({
  source,
  anchorRef,
  onClose,
  onViewDetail,
}: ChunkPreviewTooltipProps) {
  const { t } = useTranslation('chat')
  const tooltipRef = useRef<HTMLDivElement>(null)

  // Click outside to close
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (
        tooltipRef.current &&
        !tooltipRef.current.contains(e.target as Node) &&
        anchorRef.current &&
        !anchorRef.current.contains(e.target as Node)
      ) {
        onClose()
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [onClose, anchorRef])

  // ESC to close
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  // Position tooltip relative to anchor
  const [position, setPosition] = React.useState({ top: 0, left: 0 })
  useEffect(() => {
    if (anchorRef.current) {
      const rect = anchorRef.current.getBoundingClientRect()
      const tooltipWidth = 320
      const viewportWidth = window.innerWidth

      // Calculate left position, ensuring tooltip stays within viewport
      let left = rect.left
      if (left + tooltipWidth > viewportWidth - 16) {
        left = viewportWidth - tooltipWidth - 16
      }
      if (left < 16) {
        left = 16
      }

      setPosition({
        top: rect.bottom + 4,
        left,
      })
    }
  }, [anchorRef])

  return (
    <div
      ref={tooltipRef}
      className="fixed z-50 w-80 bg-surface border border-border rounded-lg shadow-sm p-3"
      style={{ top: position.top, left: position.left }}
      role="dialog"
      aria-label={`Source ${source.index} preview`}
    >
      {/* Header */}
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2 text-sm font-medium">
          <FileText className="w-4 h-4 text-primary" />
          <span className="text-primary font-mono">[{source.index}]</span>
          <span className="text-text-primary truncate max-w-[180px]">{source.title}</span>
        </div>
        <button
          onClick={onClose}
          className="text-text-muted hover:text-text-primary p-1 rounded transition-colors"
          aria-label={t('citation.close', 'Close')}
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Chunk preview with highlight style */}
      <div className="text-sm text-text-secondary bg-primary/5 border-l-2 border-primary p-2 rounded-r mb-3 max-h-32 overflow-y-auto">
        {source.content_preview || t('citation.noPreview', 'No preview available')}
      </div>

      {/* Action buttons */}
      <div className="flex gap-2">
        <Button variant="outline" size="sm" className="flex-1 h-9" onClick={onViewDetail}>
          {t('citation.viewDetail', 'View Details')}
        </Button>
        {source.document_id !== undefined && source.chunk_index !== undefined && (
          <Button
            variant="ghost"
            size="sm"
            className="h-9 px-3"
            onClick={() => {
              window.open(
                `/knowledge/document/${source.kb_id}?doc=${source.document_id}&chunk=${source.chunk_index}`,
                '_blank'
              )
            }}
            aria-label={t('citation.viewOriginal', 'View Original Document')}
          >
            <ExternalLink className="w-4 h-4" />
          </Button>
        )}
      </div>
    </div>
  )
}
