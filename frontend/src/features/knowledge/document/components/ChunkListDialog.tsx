// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useEffect, useCallback } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { AlertCircle, ChevronDown, ChevronUp, Trash2 } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { getDocumentChunks, deleteDocumentChunk } from '@/apis/knowledge'
import { Spinner } from '@/components/ui/spinner'
import type { KnowledgeDocument, ChunkItem } from '@/types/knowledge'

interface ChunkListDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  document: KnowledgeDocument | null
  onChunkDeleted?: () => void
}

export function ChunkListDialog({
  open,
  onOpenChange,
  document,
  onChunkDeleted,
}: ChunkListDialogProps) {
  const { t } = useTranslation('knowledge')
  const [chunks, setChunks] = useState<ChunkItem[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [hasNonTextContent, setHasNonTextContent] = useState(false)
  const [skippedElements, setSkippedElements] = useState<string[]>([])
  const [expandedChunks, setExpandedChunks] = useState<Set<number>>(new Set())
  const [deletingChunk, setDeletingChunk] = useState<number | null>(null)
  const pageSize = 20

  // Load chunks
  const loadChunks = useCallback(async () => {
    if (!document) return

    setLoading(true)
    setError(null)
    try {
      const result = await getDocumentChunks(document.id, page, pageSize)
      setChunks(result.chunks)
      setTotal(result.total)
      setHasNonTextContent(result.has_non_text_content)
      setSkippedElements(result.skipped_elements)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load chunks')
    } finally {
      setLoading(false)
    }
  }, [document, page])

  useEffect(() => {
    if (open && document) {
      loadChunks()
    }
  }, [open, document, loadChunks])

  // Reset state when dialog closes
  useEffect(() => {
    if (!open) {
      setChunks([])
      setPage(1)
      setTotal(0)
      setExpandedChunks(new Set())
      setError(null)
    }
  }, [open])

  // Toggle expand/collapse
  const toggleExpand = (chunkIndex: number) => {
    setExpandedChunks(prev => {
      const next = new Set(prev)
      if (next.has(chunkIndex)) {
        next.delete(chunkIndex)
      } else {
        next.add(chunkIndex)
      }
      return next
    })
  }

  // Delete chunk
  const handleDeleteChunk = async (chunkIndex: number) => {
    if (!document) return

    setDeletingChunk(chunkIndex)
    try {
      await deleteDocumentChunk(document.id, chunkIndex)
      await loadChunks()
      onChunkDeleted?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete chunk')
    } finally {
      setDeletingChunk(null)
    }
  }

  const totalPages = Math.ceil(total / pageSize)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[80vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle>
            {t('document.chunks.title', { name: document?.name || '' })}
          </DialogTitle>
        </DialogHeader>

        {/* Non-text content warning */}
        {hasNonTextContent && (
          <div className="flex items-center gap-2 p-3 bg-warning/10 text-warning rounded-lg text-sm">
            <AlertCircle className="w-4 h-4 flex-shrink-0" />
            <span>
              {t('document.chunks.skippedWarning', {
                elements: skippedElements.join(', '),
              })}
            </span>
          </div>
        )}

        {/* Chunk list */}
        <div className="flex-1 overflow-y-auto space-y-3 pr-2">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Spinner />
            </div>
          ) : error ? (
            <div className="flex items-center gap-2 p-3 bg-error/10 text-error rounded-lg text-sm">
              <AlertCircle className="w-4 h-4 flex-shrink-0" />
              <span>{error}</span>
            </div>
          ) : chunks.length === 0 ? (
            <div className="flex items-center justify-center py-12 text-text-muted">
              {t('document.chunks.empty')}
            </div>
          ) : (
            chunks.map(chunk => (
              <div
                key={chunk.chunk_index}
                className="border border-border rounded-lg p-3 space-y-2"
              >
                {/* Chunk header */}
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">#{chunk.chunk_index + 1}</span>
                    <span className="text-xs text-text-muted">
                      {chunk.token_count} tokens
                    </span>
                    {chunk.forced_split && (
                      <span className="text-xs text-warning flex items-center gap-1">
                        <AlertCircle className="w-3 h-3" />
                        {t('document.chunks.forcedSplit')}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => toggleExpand(chunk.chunk_index)}
                      aria-expanded={expandedChunks.has(chunk.chunk_index)}
                      aria-label={expandedChunks.has(chunk.chunk_index) ? t('common:actions.collapse') : t('common:actions.expand')}
                    >
                      {expandedChunks.has(chunk.chunk_index) ? (
                        <ChevronUp className="w-4 h-4" />
                      ) : (
                        <ChevronDown className="w-4 h-4" />
                      )}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleDeleteChunk(chunk.chunk_index)}
                      disabled={deletingChunk === chunk.chunk_index}
                      aria-label={t('common:actions.delete')}
                    >
                      {deletingChunk === chunk.chunk_index ? (
                        <Spinner className="w-4 h-4" />
                      ) : (
                        <Trash2 className="w-4 h-4 text-error" />
                      )}
                    </Button>
                  </div>
                </div>

                {/* Chunk content */}
                <div
                  className={`text-sm text-text-secondary whitespace-pre-wrap ${
                    expandedChunks.has(chunk.chunk_index) ? '' : 'line-clamp-3'
                  }`}
                >
                  {chunk.content}
                </div>
              </div>
            ))
          )}
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between pt-4 border-t border-border">
            <span className="text-sm text-text-muted">
              {t('document.chunks.pagination', {
                current: page,
                total: totalPages,
                count: total,
              })}
            </span>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage(p => p - 1)}
                disabled={page <= 1 || loading}
              >
                {t('common:actions.previous')}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage(p => p + 1)}
                disabled={page >= totalPages || loading}
              >
                {t('common:actions.next')}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
