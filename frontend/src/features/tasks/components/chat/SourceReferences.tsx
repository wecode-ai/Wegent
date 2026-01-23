// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

/**
 * Source References Component
 *
 * Displays knowledge base source references for RAG-enhanced responses.
 * Shows document titles with index numbers (e.g., [1], [2], [3]).
 * Supports hovering to view full document content.
 */

import React, { useState, useEffect, useCallback } from 'react'
import { FileText, Loader2 } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { getDocumentDetail } from '@/apis/knowledge'
import type { CitationSource } from '@/types/knowledge'

interface SourceReference {
  index: number
  title: string
  kb_id: number
  document_id?: number
}

interface SourceReferencesProps {
  sources: SourceReference[] | CitationSource[]
  className?: string
  /** Whether to show document content on hover (default: true) */
  showHoverContent?: boolean
}

interface DocumentTooltipProps {
  documentId: number
  documentName: string
  children: React.ReactNode
}

/**
 * Document hover tooltip that shows full document content
 */
function DocumentTooltip({ documentId, documentName, children }: DocumentTooltipProps) {
  const [isHovered, setIsHovered] = useState(false)
  const [showTooltip, setShowTooltip] = useState(false)
  const [loading, setLoading] = useState(false)
  const [content, setContent] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Delay showing tooltip
  useEffect(() => {
    let timer: NodeJS.Timeout | undefined

    if (isHovered) {
      timer = setTimeout(() => setShowTooltip(true), 300)
    } else {
      setShowTooltip(false)
    }

    return () => {
      if (timer) clearTimeout(timer)
    }
  }, [isHovered])

  // Fetch document content when tooltip is shown
  const fetchContent = useCallback(async () => {
    if (content !== null || loading) return

    setLoading(true)
    setError(null)

    try {
      const detail = await getDocumentDetail(documentId)
      setContent(detail.content || '')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load document')
    } finally {
      setLoading(false)
    }
  }, [documentId, content, loading])

  useEffect(() => {
    if (showTooltip && content === null && !loading) {
      fetchContent()
    }
  }, [showTooltip, content, loading, fetchContent])

  return (
    <span
      className="relative inline-block"
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      {children}

      {showTooltip && (
        <div
          className="absolute z-50 w-[450px] max-h-[350px] overflow-y-auto bg-surface border border-border rounded-lg shadow-lg"
          style={{
            bottom: '100%',
            left: '0',
            marginBottom: '8px',
          }}
        >
          {/* Header */}
          <div className="sticky top-0 flex items-center gap-2 px-3 py-2 bg-surface-hover/50 border-b border-border">
            <FileText className="w-4 h-4 text-text-secondary flex-shrink-0" />
            <span className="text-sm font-medium text-text-primary truncate">{documentName}</span>
          </div>

          {/* Content */}
          <div className="p-3">
            {loading && (
              <div className="flex items-center justify-center py-4">
                <Loader2 className="w-5 h-5 animate-spin text-primary" />
                <span className="ml-2 text-sm text-text-secondary">Loading...</span>
              </div>
            )}

            {error && <div className="text-sm text-red-500 py-2">{error}</div>}

            {!loading && !error && content !== null && (
              <div className="text-sm text-text-primary whitespace-pre-wrap break-words">
                {content.length > 2000 ? `${content.slice(0, 2000)}...` : content}
              </div>
            )}
          </div>
        </div>
      )}
    </span>
  )
}

export function SourceReferences({
  sources,
  className = '',
  showHoverContent = true,
}: SourceReferencesProps) {
  const { t } = useTranslation()

  if (!sources || sources.length === 0) {
    return null
  }

  // Deduplicate sources by document_id
  const uniqueSources = sources.reduce((acc, source) => {
    const docId = 'document_id' in source ? source.document_id : undefined
    if (docId) {
      const key = `${source.kb_id}-${docId}`
      if (!acc.has(key)) {
        acc.set(key, source)
      }
    } else {
      // No document_id, use index as key
      acc.set(`idx-${source.index}`, source)
    }
    return acc
  }, new Map<string, (typeof sources)[0]>())

  const deduplicatedSources = Array.from(uniqueSources.values())

  return (
    <div className={`mt-3 pt-3 border-t border-border ${className}`}>
      <div className="flex items-start gap-2 text-xs text-text-muted">
        <FileText className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
        <div className="flex-1">
          <div className="font-medium mb-1.5">{t('chat.sourceReferences', 'References')}:</div>
          <div className="flex flex-wrap gap-x-3 gap-y-1">
            {deduplicatedSources.map((source, idx) => {
              const docId = 'document_id' in source ? source.document_id : undefined
              const title =
                'title' in source
                  ? source.title
                  : 'document_name' in source
                    ? source.document_name
                    : ''

              const content = (
                <div className="flex items-baseline gap-1 cursor-pointer hover:text-text-primary transition-colors">
                  <span className="font-mono text-primary">[{source.index}]</span>
                  <span className="text-text-secondary">{title}</span>
                </div>
              )

              if (showHoverContent && docId) {
                return (
                  <DocumentTooltip
                    key={`source-${source.kb_id}-${docId}-${idx}`}
                    documentId={docId}
                    documentName={title}
                  >
                    {content}
                  </DocumentTooltip>
                )
              }

              return <div key={`source-${source.index}-${idx}`}>{content}</div>
            })}
          </div>
        </div>
      </div>
    </div>
  )
}
