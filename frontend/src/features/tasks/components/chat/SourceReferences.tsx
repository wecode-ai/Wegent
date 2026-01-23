// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

/**
 * Source References Component
 *
 * Displays knowledge base source references for RAG-enhanced responses.
 * Groups sources by document and shows each document only once.
 * Supports clicking to view chunk details in a dialog.
 */

import React, { useState, useRef, useMemo } from 'react'
import { FileText } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import type { SourceReference } from '@/types/socket'
import { ChunkPreviewTooltip } from './ChunkPreviewTooltip'
import { SourceChunkDialog } from './SourceChunkDialog'

interface SourceReferencesProps {
  sources: SourceReference[]
  className?: string
}

/**
 * Unique document info for display
 */
interface UniqueDocument {
  key: string
  title: string
  firstSource: SourceReference // First source of this document (for click handling)
}

/**
 * Get unique documents from sources (deduplicated by document)
 */
function getUniqueDocuments(sources: SourceReference[]): UniqueDocument[] {
  const documentMap = new Map<string, UniqueDocument>()

  for (const source of sources) {
    // Create a unique key for each document
    // Prefer document_id if available, otherwise use title
    const docKey =
      source.document_id !== undefined
        ? `${source.kb_id}-${source.document_id}`
        : `${source.kb_id}-${source.title}`

    // Only keep the first occurrence of each document
    if (!documentMap.has(docKey)) {
      documentMap.set(docKey, {
        key: docKey,
        title: source.title,
        firstSource: source,
      })
    }
  }

  return Array.from(documentMap.values())
}

export function SourceReferences({ sources, className = '' }: SourceReferencesProps) {
  const { t } = useTranslation('chat')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [selectedIndex, setSelectedIndex] = useState(1)
  const [tooltipSource, setTooltipSource] = useState<SourceReference | null>(null)
  const anchorRefs = useRef<Map<string, HTMLButtonElement>>(new Map())

  // Get unique documents (deduplicated by document)
  const uniqueDocuments = useMemo(() => getUniqueDocuments(sources), [sources])

  if (!sources || sources.length === 0) {
    return null
  }

  const handleDocumentClick = (doc: UniqueDocument, element: HTMLButtonElement) => {
    anchorRefs.current.set(doc.key, element)
    // If content_preview is available, show tooltip first
    if (doc.firstSource.content_preview) {
      setTooltipSource(doc.firstSource)
    } else {
      // Otherwise, go directly to dialog
      setSelectedIndex(doc.firstSource.index)
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
              {uniqueDocuments.map(doc => (
                <button
                  key={doc.key}
                  className="flex items-baseline gap-1 hover:bg-surface px-1.5 py-0.5 rounded cursor-pointer transition-colors"
                  onClick={e => handleDocumentClick(doc, e.currentTarget)}
                >
                  <span className="text-text-secondary hover:text-text-primary">{doc.title}</span>
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
            current:
              anchorRefs.current.get(
                tooltipSource.document_id !== undefined
                  ? `${tooltipSource.kb_id}-${tooltipSource.document_id}`
                  : `${tooltipSource.kb_id}-${tooltipSource.title}`
              ) || null,
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
