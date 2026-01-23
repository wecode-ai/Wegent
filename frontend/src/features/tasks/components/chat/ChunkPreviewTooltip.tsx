// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

/**
 * Source Document Preview Dialog Component
 *
 * Displays the full original document content when clicking on a citation reference.
 * Shows document content in a dialog similar to DocumentDetailDialog style.
 * Fetches full document content from the API when kb_id and document_id are available.
 */

import React, { useState, useEffect } from 'react'
import { FileText, Copy, Check } from 'lucide-react'
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
import { useTranslation } from '@/hooks/useTranslation'
import { toast } from 'sonner'
import type { SourceReference } from '@/types/socket'
import type { DocumentDetailResponse } from '@/types/knowledge'
import { knowledgeBaseApi } from '@/apis/knowledge-base'

interface ChunkPreviewTooltipProps {
  source: SourceReference
  anchorRef: React.RefObject<HTMLElement | null>
  onClose: () => void
  onViewDetail: () => void
}

export function ChunkPreviewTooltip({ source, onClose }: ChunkPreviewTooltipProps) {
  const { t } = useTranslation('chat')
  const [copiedContent, setCopiedContent] = useState(false)
  const [documentDetail, setDocumentDetail] = useState<DocumentDetailResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Check if we have valid kb_id and document_id to fetch full document content
  const hasValidDocumentInfo =
    source.kb_id != null &&
    source.document_id != null &&
    typeof source.kb_id === 'number' &&
    typeof source.document_id === 'number'

  // Fetch full document content when dialog opens
  useEffect(() => {
    if (hasValidDocumentInfo) {
      setLoading(true)
      setError(null)

      knowledgeBaseApi
        .getDocumentDetail(source.kb_id!, source.document_id!, {
          includeContent: true,
          includeSummary: false,
        })
        .then(response => {
          setDocumentDetail(response)
        })
        .catch(err => {
          console.error('Failed to load document content:', err)
          setError(err.message || 'Failed to load content')
        })
        .finally(() => setLoading(false))
    }
  }, [hasValidDocumentInfo, source.kb_id, source.document_id])

  // Use document content if available, otherwise fall back to content_preview
  const displayContent = documentDetail?.content || source.content_preview

  const handleCopyContent = async () => {
    if (!displayContent) return
    try {
      await navigator.clipboard.writeText(displayContent)
      setCopiedContent(true)
      toast.success(t('citation.copySuccess', 'Copied to clipboard'))
      setTimeout(() => setCopiedContent(false), 2000)
    } catch {
      toast.error(t('citation.copyError', 'Failed to copy'))
    }
  }

  return (
    <Dialog open={true} onOpenChange={open => !open && onClose()}>
      <DialogContent className="max-w-4xl max-h-[85vh] flex flex-col p-0">
        {/* Header */}
        <DialogHeader className="px-6 py-4 border-b border-border flex-shrink-0">
          <div className="flex items-start gap-3">
            <div className="p-2 bg-primary/10 rounded-lg flex-shrink-0 mt-0.5">
              <FileText className="w-5 h-5 text-primary" />
            </div>
            <div className="flex-1 min-w-0">
              <DialogTitle className="text-base font-medium text-text-primary truncate">
                {source.title}
              </DialogTitle>
              <DialogDescription className="mt-1 text-xs text-text-muted">
                {t('citation.sourceReference', 'Source Reference')}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-6 py-4">
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-medium text-text-primary">
                {t('citation.documentContent', 'Document Content')}
              </h3>
              <div className="flex items-center gap-2">
                {documentDetail?.truncated && (
                  <Badge variant="warning" size="sm">
                    {t('citation.truncated', 'Truncated')}
                  </Badge>
                )}
                {displayContent && !loading && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={handleCopyContent}
                    disabled={copiedContent}
                  >
                    {copiedContent ? (
                      <>
                        <Check className="w-3.5 h-3.5 mr-1" />
                        {t('citation.copied', 'Copied')}
                      </>
                    ) : (
                      <>
                        <Copy className="w-3.5 h-3.5 mr-1" />
                        {t('citation.copy', 'Copy')}
                      </>
                    )}
                  </Button>
                )}
              </div>
            </div>

            {loading ? (
              <div className="p-8 bg-surface rounded-lg border border-border flex items-center justify-center">
                <Spinner />
              </div>
            ) : error ? (
              <div className="p-4 bg-surface rounded-lg border border-border">
                <div className="text-sm text-destructive mb-2">{error}</div>
                {source.content_preview && (
                  <pre className="text-xs text-text-secondary whitespace-pre-wrap break-words font-mono leading-relaxed">
                    {source.content_preview}
                  </pre>
                )}
              </div>
            ) : displayContent ? (
              <div className="p-4 bg-surface rounded-lg border border-border">
                <pre className="text-xs text-text-secondary whitespace-pre-wrap break-words font-mono leading-relaxed">
                  {displayContent}
                </pre>
                {documentDetail?.content_length !== undefined && (
                  <div className="mt-3 pt-3 border-t border-border text-xs text-text-muted">
                    {t('citation.contentLength', 'Content length')}:{' '}
                    {documentDetail.content_length.toLocaleString()}{' '}
                    {t('citation.characters', 'characters')}
                  </div>
                )}
              </div>
            ) : (
              <div className="p-4 bg-surface rounded-lg border border-border text-center text-sm text-text-muted">
                {t('citation.noPreview', 'No preview available')}
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
