// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState } from 'react'
import { Layers, ChevronDown, ChevronUp, Hash, RefreshCw, Copy, Check } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Spinner } from '@/components/ui/spinner'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { useDocumentChunks } from '../hooks/useDocumentChunks'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'

interface ChunksSectionProps {
  documentId: number
  enabled?: boolean
}

export function ChunksSection({ documentId, enabled = true }: ChunksSectionProps) {
  const { t } = useTranslation('knowledge')
  const [isOpen, setIsOpen] = useState(false)
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null)

  const {
    chunks,
    total,
    splitterType,
    splitterSubtype,
    loading,
    error,
    hasMore,
    loadMore,
    refresh,
  } = useDocumentChunks({
    documentId,
    enabled: enabled && isOpen,
    pageSize: 10,
  })

  const handleCopy = async (content: string, index: number) => {
    try {
      await navigator.clipboard.writeText(content)
      setCopiedIndex(index)
      toast.success(t('document.document.detail.copySuccess'))
      setTimeout(() => setCopiedIndex(null), 2000)
    } catch {
      toast.error(t('document.document.detail.copyError'))
    }
  }

  // Format splitter type for display
  const formatSplitterType = (type?: string, subtype?: string) => {
    if (!type) return null
    if (type === 'smart' && subtype) {
      return `${type} (${subtype})`
    }
    return type
  }

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen} className="space-y-3">
      <div className="flex items-center justify-between">
        <CollapsibleTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="flex items-center gap-2 px-0 hover:bg-transparent"
          >
            <Layers className="w-4 h-4 text-primary" />
            <span className="text-sm font-medium text-text-primary">
              {t('document.document.detail.chunksTitle')}
            </span>
            {total > 0 && (
              <Badge variant="secondary" size="sm" className="ml-1">
                {total}
              </Badge>
            )}
            {isOpen ? (
              <ChevronUp className="w-4 h-4 text-text-muted" />
            ) : (
              <ChevronDown className="w-4 h-4 text-text-muted" />
            )}
          </Button>
        </CollapsibleTrigger>

        {isOpen && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => refresh()}
            disabled={loading}
            className="h-7 px-2"
          >
            <RefreshCw className={cn('w-3.5 h-3.5', loading && 'animate-spin')} />
          </Button>
        )}
      </div>

      <CollapsibleContent className="space-y-3">
        {/* Splitter info */}
        {splitterType && (
          <div className="flex items-center gap-2 text-xs text-text-muted">
            <span>{t('document.document.detail.splitterType')}:</span>
            <Badge variant="secondary" size="sm">
              {formatSplitterType(splitterType, splitterSubtype)}
            </Badge>
          </div>
        )}

        {/* Loading state */}
        {loading && chunks.length === 0 && (
          <div className="flex items-center justify-center py-8">
            <Spinner className="w-5 h-5" />
            <span className="ml-2 text-sm text-text-muted">
              {t('document.document.detail.chunksLoading')}
            </span>
          </div>
        )}

        {/* Error state */}
        {error && (
          <div className="p-4 bg-error/10 text-error rounded-lg text-sm">
            {t('document.document.detail.chunksError')}
          </div>
        )}

        {/* Empty state */}
        {!loading && !error && chunks.length === 0 && (
          <div className="p-4 bg-surface rounded-lg text-center text-sm text-text-muted">
            {t('document.document.detail.chunksEmpty')}
          </div>
        )}

        {/* Chunks list */}
        {chunks.length > 0 && (
          <div className="space-y-2">
            {chunks.map((chunk, idx) => (
              <div
                key={chunk.index}
                className="group relative p-3 bg-surface rounded-lg border border-border hover:border-primary/30 transition-colors"
              >
                {/* Chunk header */}
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <div className="flex items-center gap-1 text-xs text-text-muted">
                      <Hash className="w-3 h-3" />
                      <span>{chunk.index}</span>
                    </div>
                    <Badge variant="secondary" size="sm" className="text-[10px]">
                      {t('document.document.detail.chunkTokens', { count: chunk.token_count })}
                    </Badge>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 w-6 p-0 opacity-0 group-hover:opacity-100 transition-opacity"
                    onClick={() => handleCopy(chunk.content, idx)}
                  >
                    {copiedIndex === idx ? (
                      <Check className="w-3 h-3 text-success" />
                    ) : (
                      <Copy className="w-3 h-3" />
                    )}
                  </Button>
                </div>

                {/* Chunk content - show full content without truncation */}
                <div className="text-xs text-text-secondary leading-relaxed whitespace-pre-wrap">
                  {chunk.content}
                </div>

                {/* Position info */}
                <div className="mt-2 text-[10px] text-text-muted">
                  {chunk.start_position} - {chunk.end_position}
                </div>
              </div>
            ))}

            {/* Load more button */}
            {hasMore && (
              <Button
                variant="outline"
                size="sm"
                onClick={loadMore}
                disabled={loading}
                className="w-full"
              >
                {loading ? (
                  <>
                    <Spinner className="w-3.5 h-3.5 mr-2" />
                    {t('document.document.detail.chunksLoading')}
                  </>
                ) : (
                  t('common:actions.loadMore')
                )}
              </Button>
            )}

            {/* Total count */}
            <div className="text-center text-xs text-text-muted">
              {t('document.document.detail.chunksTotal', { count: total })}
            </div>
          </div>
        )}
      </CollapsibleContent>
    </Collapsible>
  )
}
