// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

/**
 * Source References Component
 *
 * Displays knowledge base source references for RAG-enhanced responses.
 * Shows document titles with index numbers (e.g., [1], [2], [3]).
 * Supports clicking to view chunk details in a dialog.
 */

import React, { useState, useRef } from 'react'
import { FileText } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import type { SourceReference } from '@/types/socket'
import { ChunkPreviewTooltip } from './ChunkPreviewTooltip'
import { SourceChunkDialog } from './SourceChunkDialog'

interface SourceReferencesProps {
  sources: SourceReference[]
  className?: string
}

export function SourceReferences({ sources, className = '' }: SourceReferencesProps) {
  const { t } = useTranslation('chat')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [selectedIndex, setSelectedIndex] = useState(1)
  const [tooltipSource, setTooltipSource] = useState<SourceReference | null>(null)
  const anchorRefs = useRef<Map<number, HTMLButtonElement>>(new Map())

  if (!sources || sources.length === 0) {
    return null
  }

  const handleSourceClick = (source: SourceReference, element: HTMLButtonElement) => {
    anchorRefs.current.set(source.index, element)
    // If content_preview is available, show tooltip first
    if (source.content_preview) {
      setTooltipSource(source)
    } else {
      // Otherwise, go directly to dialog
      setSelectedIndex(source.index)
      setDialogOpen(true)
    }
  }

  const handleViewDetail = () => {
    if (tooltipSource) {
      setSelectedIndex(tooltipSource.index)
      setTooltipSource(null)
      setDialogOpen(true)
    }
  }

  return (
    <>
      <div className={`mt-3 pt-3 border-t border-border ${className}`}>
        <div className="flex items-start gap-2 text-xs text-text-muted">
          <FileText className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
          <div className="flex-1">
            <div className="font-medium mb-1.5">{t('sourceReferences', '资料来源')}:</div>
            <div className="flex flex-wrap gap-x-3 gap-y-1">
              {sources.map(source => (
                <button
                  key={source.index}
                  className="flex items-baseline gap-1 hover:bg-surface px-1.5 py-0.5 rounded cursor-pointer transition-colors"
                  onClick={e => handleSourceClick(source, e.currentTarget)}
                >
                  <span className="font-mono text-primary">[{source.index}]</span>
                  <span className="text-text-secondary hover:text-text-primary">
                    {source.title}
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Tooltip for quick preview */}
      {tooltipSource && (
        <ChunkPreviewTooltip
          source={tooltipSource}
          anchorRef={{
            current: anchorRefs.current.get(tooltipSource.index) || null,
          }}
          onClose={() => setTooltipSource(null)}
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
