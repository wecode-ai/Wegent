// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

/**
 * Source Chunk Dialog Component
 *
 * Displays detailed chunk context with previous and next chunks for better understanding.
 * Allows users to navigate between different sources and view original documents.
 * Redesigned with Wegent Calm UI philosophy: low saturation, generous whitespace, teal accent.
 */

import React, { useState, useEffect } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Spinner } from '@/components/ui/spinner'
import {
  FileText,
  ExternalLink,
  Copy,
  Check,
  ChevronUp,
  ChevronDown,
  BookOpen,
  Hash,
  Layers,
} from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { toast } from 'sonner'
import type { SourceReference } from '@/types/socket'
import type { ChunkContextResponse, ChunkItem } from '@/types/knowledge'
import { getChunkContext } from '@/apis/knowledge'
import { cn } from '@/lib/utils'

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
  const [copiedContent, setCopiedContent] = useState(false)
  const [expandedChunks, setExpandedChunks] = useState<Set<string>>(new Set(['current']))

  const currentSource = sources.find(s => s.index === selectedIndex)

  // Reset selected state and load content when dialog opens with new initialSourceIndex
  useEffect(() => {
    if (open) {
      setSelectedIndex(initialSourceIndex)
      setExpandedChunks(new Set(['current']))
      // Reset context to trigger reload
      setContext(null)
    }
  }, [open, initialSourceIndex])

  // Check if document_id and chunk_index are valid numbers (not null/undefined)
  const hasValidChunkInfo =
    currentSource?.document_id != null &&
    currentSource?.chunk_index != null &&
    typeof currentSource.document_id === 'number' &&
    typeof currentSource.chunk_index === 'number'

  // Load chunk context when selectedIndex changes
  // Use selectedIndex and source's document_id/chunk_index as dependencies for precise control
  useEffect(() => {
    if (open && currentSource && hasValidChunkInfo) {
      setLoading(true)
      setError(null)

      getChunkContext(currentSource.document_id!, currentSource.chunk_index!, 1)
        .then(setContext)
        .catch(err => {
          console.error('Failed to load chunk context:', err)
          setError(err.message || 'Failed to load context')
        })
        .finally(() => setLoading(false))
    } else if (open && currentSource) {
      // Reset context when chunk info is not available
      setContext(null)
      setError(null)
      setLoading(false)
    }
    // Include selectedIndex to ensure re-fetch when user clicks different source in the list
    // Include document_id and chunk_index to ensure re-fetch when source data changes
  }, [
    open,
    selectedIndex,
    currentSource?.document_id,
    currentSource?.chunk_index,
    hasValidChunkInfo,
  ])

  // Copy content to clipboard
  const handleCopyContent = async () => {
    const content = context?.current_chunk?.content || currentSource?.content_preview
    if (!content) return

    try {
      await navigator.clipboard.writeText(content)
      setCopiedContent(true)
      toast.success(t('citation.copySuccess', 'Copied to clipboard'))
      setTimeout(() => setCopiedContent(false), 2000)
    } catch {
      toast.error(t('citation.copyError', 'Failed to copy'))
    }
  }

  // Toggle chunk expansion
  const toggleChunkExpand = (key: string) => {
    setExpandedChunks(prev => {
      const next = new Set(prev)
      if (next.has(key)) {
        next.delete(key)
      } else {
        next.add(key)
      }
      return next
    })
  }

  // Render chunk block with improved design
  const renderChunk = (chunk: ChunkItem, type: 'previous' | 'current' | 'next', index?: number) => {
    const isHighlighted = type === 'current'
    const key = type === 'current' ? 'current' : `${type}-${index}`
    const isExpanded = expandedChunks.has(key)

    return (
      <div
        className={cn(
          'rounded-xl transition-all duration-200',
          isHighlighted
            ? 'bg-primary/5 border border-primary/20 shadow-sm'
            : 'bg-surface/50 border border-border/50 hover:border-border'
        )}
      >
        {/* Chunk Header */}
        <div
          className={cn(
            'flex items-center justify-between px-4 py-3 cursor-pointer',
            !isHighlighted && 'hover:bg-surface/80'
          )}
          onClick={() => !isHighlighted && toggleChunkExpand(key)}
        >
          <div className="flex items-center gap-3">
            <div
              className={cn(
                'flex items-center justify-center w-6 h-6 rounded-full text-xs font-medium',
                isHighlighted ? 'bg-primary text-white' : 'bg-text-muted/10 text-text-muted'
              )}
            >
              {chunk.chunk_index + 1}
            </div>
            <div className="flex items-center gap-2">
              <span
                className={cn(
                  'text-sm font-medium',
                  isHighlighted ? 'text-primary' : 'text-text-secondary'
                )}
              >
                {type === 'previous' && t('citation.previousChunk', 'Previous')}
                {type === 'current' && t('citation.currentChunk', 'Current Reference')}
                {type === 'next' && t('citation.nextChunk', 'Next')}
              </span>
              <Badge variant="secondary" size="sm" className="text-xs font-normal bg-surface">
                {chunk.token_count} tokens
              </Badge>
            </div>
          </div>
          {!isHighlighted && (
            <Button variant="ghost" size="sm" className="h-6 w-6 p-0">
              {isExpanded ? (
                <ChevronUp className="w-4 h-4 text-text-muted" />
              ) : (
                <ChevronDown className="w-4 h-4 text-text-muted" />
              )}
            </Button>
          )}
        </div>

        {/* Chunk Content */}
        {(isHighlighted || isExpanded) && (
          <div className={cn('px-4 pb-4 pt-0', !isHighlighted && 'border-t border-border/30')}>
            <div
              className={cn(
                'text-sm leading-relaxed whitespace-pre-wrap',
                isHighlighted ? 'text-text-primary' : 'text-text-secondary'
              )}
            >
              {chunk.content}
            </div>
          </div>
        )}
      </div>
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-5xl max-h-[85vh] flex flex-col p-0 gap-0">
        {/* Header */}
        <DialogHeader className="px-6 py-4 border-b border-border flex-shrink-0">
          <div className="flex items-start gap-3">
            <div className="p-2.5 bg-primary/10 rounded-xl flex-shrink-0">
              <BookOpen className="w-5 h-5 text-primary" />
            </div>
            <div className="flex-1 min-w-0">
              <DialogTitle className="text-lg font-semibold text-text-primary">
                {t('citation.sourceList', 'Source References')}
              </DialogTitle>
              <DialogDescription className="flex items-center gap-2 mt-1 text-sm text-text-muted">
                <Layers className="w-3.5 h-3.5" />
                <span>
                  {t('citation.sourceCount', '{{count}} sources', {
                    count: sources.length,
                  })}
                </span>
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        {/* Main Content */}
        <div className="flex flex-1 overflow-hidden min-h-0">
          {/* Left: Source list */}
          <div className="w-64 flex-shrink-0 border-r border-border bg-surface/30 overflow-y-auto">
            <div className="p-3 space-y-1">
              {sources.map(source => (
                <button
                  key={source.index}
                  className={cn(
                    'w-full text-left px-3 py-2.5 rounded-lg text-sm transition-all duration-150',
                    selectedIndex === source.index
                      ? 'bg-primary/10 text-primary shadow-sm'
                      : 'hover:bg-surface text-text-secondary hover:text-text-primary'
                  )}
                  onClick={() => setSelectedIndex(source.index)}
                >
                  <div className="flex items-start gap-2.5">
                    <div
                      className={cn(
                        'flex items-center justify-center w-5 h-5 rounded text-xs font-mono flex-shrink-0 mt-0.5',
                        selectedIndex === source.index
                          ? 'bg-primary text-white'
                          : 'bg-text-muted/10 text-text-muted'
                      )}
                    >
                      {source.index}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="font-medium truncate">{source.title}</div>
                      {source.content_preview && (
                        <div className="text-xs text-text-muted mt-0.5 line-clamp-2">
                          {source.content_preview.slice(0, 60)}...
                        </div>
                      )}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </div>

          {/* Right: Chunk details */}
          <div className="flex-1 overflow-y-auto">
            <div className="p-6">
              {loading ? (
                <div className="flex flex-col items-center justify-center py-16">
                  <Spinner className="w-8 h-8" />
                  <p className="mt-3 text-sm text-text-muted">
                    {t('citation.loading', 'Loading content...')}
                  </p>
                </div>
              ) : error ? (
                <div className="flex flex-col items-center justify-center py-16">
                  <div className="p-3 bg-destructive/10 rounded-full mb-3">
                    <FileText className="w-6 h-6 text-destructive" />
                  </div>
                  <p className="text-sm text-destructive">{error}</p>
                  <p className="text-xs text-text-muted mt-1">
                    {t('citation.errorHint', 'Please try again later')}
                  </p>
                </div>
              ) : context ? (
                <div className="space-y-4">
                  {/* Document info card */}
                  <div className="flex items-center justify-between p-4 bg-surface rounded-xl border border-border">
                    <div className="flex items-center gap-3">
                      <div className="p-2 bg-primary/10 rounded-lg">
                        <FileText className="w-4 h-4 text-primary" />
                      </div>
                      <div>
                        <div className="font-medium text-text-primary">{context.document_name}</div>
                        <div className="flex items-center gap-2 text-xs text-text-muted mt-0.5">
                          <Hash className="w-3 h-3" />
                          <span>
                            {t('citation.chunkPosition', 'Chunk {{current}} of {{total}}', {
                              current: context.current_chunk.chunk_index + 1,
                              total: context.total_chunks,
                            })}
                          </span>
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={handleCopyContent}
                        disabled={copiedContent}
                        className="h-8"
                      >
                        {copiedContent ? (
                          <>
                            <Check className="w-3.5 h-3.5 mr-1.5" />
                            {t('citation.copied', 'Copied')}
                          </>
                        ) : (
                          <>
                            <Copy className="w-3.5 h-3.5 mr-1.5" />
                            {t('citation.copy', 'Copy')}
                          </>
                        )}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          window.open(
                            `/knowledge/document/${currentSource?.kb_id}?doc=${currentSource?.document_id}&chunk=${currentSource?.chunk_index}`,
                            '_blank'
                          )
                        }}
                        className="h-8"
                      >
                        <ExternalLink className="w-3.5 h-3.5 mr-1.5" />
                        {t('citation.viewOriginal', 'View Document')}
                      </Button>
                    </div>
                  </div>

                  {/* Chunk context */}
                  <div className="space-y-3">
                    {/* Previous chunks */}
                    {context.previous_chunks.map((chunk, i) => (
                      <div key={`prev-${i}`}>{renderChunk(chunk, 'previous', i)}</div>
                    ))}

                    {/* Current chunk (highlighted) */}
                    {renderChunk(context.current_chunk, 'current')}

                    {/* Next chunks */}
                    {context.next_chunks.map((chunk, i) => (
                      <div key={`next-${i}`}>{renderChunk(chunk, 'next', i)}</div>
                    ))}
                  </div>
                </div>
              ) : currentSource?.content_preview ? (
                // Show content preview when detailed context is not available
                <div className="space-y-4">
                  {/* Document info card */}
                  <div className="flex items-center justify-between p-4 bg-surface rounded-xl border border-border">
                    <div className="flex items-center gap-3">
                      <div className="p-2 bg-primary/10 rounded-lg">
                        <FileText className="w-4 h-4 text-primary" />
                      </div>
                      <div>
                        <div className="font-medium text-text-primary">{currentSource.title}</div>
                        <div className="flex items-center gap-2 text-xs text-text-muted mt-0.5">
                          <Hash className="w-3 h-3" />
                          <span>
                            {t('citation.reference', 'Reference')} [{currentSource.index}]
                          </span>
                        </div>
                      </div>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={handleCopyContent}
                      disabled={copiedContent}
                      className="h-8"
                    >
                      {copiedContent ? (
                        <>
                          <Check className="w-3.5 h-3.5 mr-1.5" />
                          {t('citation.copied', 'Copied')}
                        </>
                      ) : (
                        <>
                          <Copy className="w-3.5 h-3.5 mr-1.5" />
                          {t('citation.copy', 'Copy')}
                        </>
                      )}
                    </Button>
                  </div>

                  {/* Content preview */}
                  <div className="rounded-xl bg-primary/5 border border-primary/20 shadow-sm">
                    <div className="flex items-center gap-3 px-4 py-3">
                      <div className="flex items-center justify-center w-6 h-6 rounded-full bg-primary text-white text-xs font-medium">
                        {currentSource.index}
                      </div>
                      <span className="text-sm font-medium text-primary">
                        {t('citation.currentChunk', 'Current Reference')}
                      </span>
                    </div>
                    <div className="px-4 pb-4">
                      <div className="text-sm text-text-primary leading-relaxed whitespace-pre-wrap">
                        {currentSource.content_preview}
                      </div>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center py-16">
                  <div className="p-3 bg-surface rounded-full mb-3">
                    <FileText className="w-6 h-6 text-text-muted" />
                  </div>
                  <p className="text-sm text-text-muted">
                    {t('citation.selectSource', 'Select a source to view details')}
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
