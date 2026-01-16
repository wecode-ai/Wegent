// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState } from 'react'
import { FileText, RefreshCw, Copy, Check } from 'lucide-react'
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
import { useDocumentDetail } from '../hooks/useDocumentDetail'
import type { KnowledgeDocument } from '@/types/knowledge'
import { useTranslation } from '@/hooks/useTranslation'
import { toast } from 'sonner'

interface DocumentDetailDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  document: KnowledgeDocument | null
  knowledgeBaseId: number
}

export function DocumentDetailDialog({
  open,
  onOpenChange,
  document,
  knowledgeBaseId,
}: DocumentDetailDialogProps) {
  const { t, getCurrentLanguage } = useTranslation('knowledge')
  const [copiedContent, setCopiedContent] = useState(false)

  const { detail, loading, error, refresh } = useDocumentDetail({
    kbId: knowledgeBaseId,
    docId: document?.id || 0,
    enabled: open && !!document,
  })

  const handleCopyContent = async () => {
    if (!detail?.content) return
    try {
      await navigator.clipboard.writeText(detail.content)
      setCopiedContent(true)
      toast.success(t('document.document.detail.copySuccess'))
      setTimeout(() => setCopiedContent(false), 2000)
    } catch {
      toast.error(t('document.document.detail.copyError'))
    }
  }

  const handleRefresh = () => {
    refresh()
  }

  if (!document) return null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[85vh] flex flex-col p-0">
        {/* Header */}
        <DialogHeader className="px-6 py-4 border-b border-border flex-shrink-0">
          <div className="flex items-start gap-3">
            <div className="p-2 bg-primary/10 rounded-lg flex-shrink-0 mt-0.5">
              <FileText className="w-5 h-5 text-primary" />
            </div>
            <div className="flex-1 min-w-0">
              <DialogTitle className="text-base font-medium text-text-primary truncate">
                {document.name}
              </DialogTitle>
              <DialogDescription className="flex items-center gap-2 mt-1 text-xs text-text-muted">
                <span>{document.file_extension.toUpperCase()}</span>
                <span>•</span>
                <span>
                  {new Date(document.created_at).toLocaleDateString(getCurrentLanguage(), {
                    year: 'numeric',
                    month: '2-digit',
                    day: '2-digit',
                  })}
                </span>
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-6 py-4">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Spinner />
            </div>
          ) : error ? (
            <div className="flex flex-col items-center justify-center py-12 text-text-secondary">
              <p className="mb-4">{error}</p>
              <Button variant="outline" onClick={handleRefresh}>
                {t('common:actions.retry')}
              </Button>
            </div>
          ) : (
            <div className="space-y-6">
              {/* Summary Section */}
              {detail?.summary && (
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-medium text-text-primary">
                      {t('document.document.detail.summary')}
                    </h3>
                    <Button variant="ghost" size="sm" onClick={handleRefresh}>
                      <RefreshCw className="w-3.5 h-3.5" />
                    </Button>
                  </div>

                  {/* Summary Status */}
                  {detail.summary.status && (
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-text-muted">
                        {t('document.document.detail.status')}:
                      </span>
                      <Badge
                        variant={
                          detail.summary.status === 'completed'
                            ? 'success'
                            : detail.summary.status === 'generating'
                              ? 'warning'
                              : 'default'
                        }
                        size="sm"
                      >
                        {t(`document.document.detail.statusValues.${detail.summary.status}`)}
                      </Badge>
                    </div>
                  )}

                  {/* Short Summary */}
                  {detail.summary.short_summary && (
                    <div className="p-3 bg-surface rounded-lg">
                      <p className="text-sm text-text-primary">{detail.summary.short_summary}</p>
                    </div>
                  )}

                  {/* Long Summary */}
                  {detail.summary.long_summary && (
                    <div className="p-3 bg-surface rounded-lg">
                      <p className="text-sm text-text-secondary leading-relaxed whitespace-pre-wrap">
                        {detail.summary.long_summary}
                      </p>
                    </div>
                  )}

                  {/* Topics */}
                  {detail.summary.topics && detail.summary.topics.length > 0 && (
                    <div className="space-y-2">
                      <span className="text-xs text-text-muted">
                        {t('document.document.detail.topics')}:
                      </span>
                      <div className="flex flex-wrap gap-2">
                        {detail.summary.topics.map((topic, index) => (
                          <Badge key={index} variant="secondary" size="sm">
                            {topic}
                          </Badge>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Content Section */}
              {detail?.content !== undefined && (
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-medium text-text-primary">
                      {t('document.document.detail.content')}
                    </h3>
                    <div className="flex items-center gap-2">
                      {detail.truncated && (
                        <Badge variant="warning" size="sm">
                          {t('document.document.detail.truncated')}
                        </Badge>
                      )}
                      {detail.content && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={handleCopyContent}
                          disabled={copiedContent}
                        >
                          {copiedContent ? (
                            <>
                              <Check className="w-3.5 h-3.5 mr-1" />
                              {t('document.document.detail.copied')}
                            </>
                          ) : (
                            <>
                              <Copy className="w-3.5 h-3.5 mr-1" />
                              {t('document.document.detail.copy')}
                            </>
                          )}
                        </Button>
                      )}
                    </div>
                  </div>

                  {detail.content ? (
                    <div className="p-4 bg-surface rounded-lg border border-border">
                      <pre className="text-xs text-text-secondary whitespace-pre-wrap break-words font-mono leading-relaxed">
                        {detail.content}
                      </pre>
                      {detail.content_length !== undefined && (
                        <div className="mt-3 pt-3 border-t border-border text-xs text-text-muted">
                          {t('document.document.detail.contentLength')}:{' '}
                          {detail.content_length.toLocaleString()}{' '}
                          {t('document.document.detail.characters')}
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="p-4 bg-surface rounded-lg border border-border text-center text-sm text-text-muted">
                      {t('document.document.detail.noContent')}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
