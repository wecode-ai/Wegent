// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

/**
 * Source Chunk Dialog Component
 *
 * Displays detailed chunk context with previous and next chunks for better understanding.
 * Allows users to navigate between different sources and view original documents.
 */

import React, { useState, useEffect } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { FileText, ExternalLink } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import type { SourceReference } from '@/types/socket'
import type { ChunkContextResponse, ChunkItem } from '@/types/knowledge'
import { getChunkContext } from '@/apis/knowledge'

interface SourceChunkDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  sources: SourceReference[]
  initialSourceIndex?: number
}

export function SourceChunkDialog({
  open,
  onOpenChange,
  sources,
  initialSourceIndex = 1,
}: SourceChunkDialogProps) {
  const { t } = useTranslation('chat')
  const [selectedIndex, setSelectedIndex] = useState(initialSourceIndex)
  const [context, setContext] = useState<ChunkContextResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const currentSource = sources.find(s => s.index === selectedIndex)

  // Reset selected state when dialog opens
  useEffect(() => {
    if (open) {
      setSelectedIndex(initialSourceIndex)
    }
  }, [open, initialSourceIndex])

  // Load chunk context
  useEffect(() => {
    if (
      open &&
      currentSource &&
      currentSource.document_id !== undefined &&
      currentSource.chunk_index !== undefined
    ) {
      setLoading(true)
      setError(null)

      getChunkContext(currentSource.document_id, currentSource.chunk_index, 1)
        .then(setContext)
        .catch(err => {
          console.error('Failed to load chunk context:', err)
          setError(err.message || 'Failed to load context')
        })
        .finally(() => setLoading(false))
    }
  }, [open, currentSource])

  // Render chunk block
  const renderChunk = (chunk: ChunkItem, type: 'previous' | 'current' | 'next') => {
    const isHighlighted = type === 'current'

    return (
      <div
        className={`p-3 rounded-lg ${
          isHighlighted
            ? 'bg-primary/10 border-l-2 border-primary'
            : 'bg-surface/50 border border-border/50'
        }`}
      >
        <div
          className={`text-xs mb-1 ${isHighlighted ? 'text-primary font-medium' : 'text-text-muted'}`}
        >
          {type === 'previous' && t('citation.previousChunk', 'Previous')}
          {type === 'current' && t('citation.currentChunk', 'Current Reference')}
          {type === 'next' && t('citation.nextChunk', 'Next')}
          {' '}#{chunk.chunk_index + 1}
          <span className="ml-2 text-text-muted">({chunk.token_count} tokens)</span>
        </div>
        <div
          className={`text-sm whitespace-pre-wrap ${isHighlighted ? 'text-text-primary' : 'text-text-secondary'}`}
        >
          {chunk.content}
        </div>
      </div>
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[80vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileText className="w-5 h-5" />
            {t('citation.sourceList', 'Source References')}
          </DialogTitle>
        </DialogHeader>

        <div className="flex flex-1 gap-4 overflow-hidden min-h-0">
          {/* Left: Source list */}
          <div className="w-56 flex-shrink-0 border-r border-border pr-4 overflow-y-auto">
            <div className="space-y-1">
              {sources.map(source => (
                <button
                  key={source.index}
                  className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-colors ${
                    selectedIndex === source.index
                      ? 'bg-primary/10 text-primary border-l-2 border-primary'
                      : 'hover:bg-surface text-text-secondary'
                  }`}
                  onClick={() => setSelectedIndex(source.index)}
                >
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-xs">[{source.index}]</span>
                    <span className="truncate">{source.title}</span>
                  </div>
                </button>
              ))}
            </div>
          </div>

          {/* Right: Chunk details */}
          <div className="flex-1 overflow-y-auto pr-2">
            {loading ? (
              <div className="flex items-center justify-center h-full">
                <Spinner />
              </div>
            ) : error ? (
              <div className="text-center text-destructive py-8">{error}</div>
            ) : context ? (
              <div className="space-y-4">
                {/* Document info */}
                <div className="text-sm text-text-muted">
                  {context.document_name} · {t('citation.chunkContext', 'Context')} (
                  {context.current_chunk.chunk_index + 1}/{context.total_chunks})
                </div>

                {/* Previous chunks */}
                {context.previous_chunks.map((chunk, i) => (
                  <div key={`prev-${i}`}>{renderChunk(chunk, 'previous')}</div>
                ))}

                {/* Current chunk (highlighted) */}
                {renderChunk(context.current_chunk, 'current')}

                {/* Next chunks */}
                {context.next_chunks.map((chunk, i) => (
                  <div key={`next-${i}`}>{renderChunk(chunk, 'next')}</div>
                ))}

                {/* View original document button */}
                <div className="pt-4 border-t border-border">
                  <Button
                    variant="outline"
                    onClick={() => {
                      window.open(
                        `/knowledge/document/${currentSource?.kb_id}?doc=${currentSource?.document_id}&chunk=${currentSource?.chunk_index}`,
                        '_blank'
                      )
                    }}
                  >
                    <ExternalLink className="w-4 h-4 mr-2" />
                    {t('citation.viewOriginal', 'View Original Document')}
                  </Button>
                </div>
              </div>
            ) : currentSource?.content_preview ? (
              // Show content preview when detailed context is not available
              <div className="space-y-4">
                <div className="text-sm text-text-muted">{currentSource.title}</div>
                <div className="p-3 rounded-lg bg-primary/10 border-l-2 border-primary">
                  <div className="text-xs text-primary font-medium mb-1">
                    {t('citation.currentChunk', 'Current Reference')}
                  </div>
                  <div className="text-sm text-text-primary whitespace-pre-wrap">
                    {currentSource.content_preview}
                  </div>
                </div>
              </div>
            ) : (
              <div className="text-center text-text-muted py-8">
                {t('citation.selectSource', 'Select a source to view details')}
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
