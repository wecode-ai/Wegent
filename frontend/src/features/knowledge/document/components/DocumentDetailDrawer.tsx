// SPDX-FileCopyrightText: 2025 WeCode, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import { useEffect, useState, useCallback } from 'react';
import { X, FileText, Clock, HardDrive, Loader2, AlertCircle, CheckCircle2 } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { Spinner } from '@/components/ui/spinner';
import { ScrollArea } from '@/components/ui/scroll-area';
import { getDocumentDetail } from '@/apis/knowledge';
import type { KnowledgeDocument, KnowledgeDocumentDetail, SummaryStatus } from '@/types/knowledge';
import { useTranslation } from '@/hooks/useTranslation';

interface DocumentDetailDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  document: KnowledgeDocument | null;
}

export function DocumentDetailDrawer({
  open,
  onOpenChange,
  document,
}: DocumentDetailDrawerProps) {
  const { t } = useTranslation('knowledge');
  const [detail, setDetail] = useState<KnowledgeDocumentDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchDetail = useCallback(async () => {
    if (!document?.id) return;

    setLoading(true);
    setError(null);
    try {
      const data = await getDocumentDetail(document.id);
      setDetail(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load document detail');
    } finally {
      setLoading(false);
    }
  }, [document?.id]);

  useEffect(() => {
    if (open && document?.id) {
      fetchDetail();
    } else {
      setDetail(null);
      setError(null);
    }
  }, [open, document?.id, fetchDetail]);

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const formatDateTime = (dateString: string) => {
    const date = new Date(dateString);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    return `${year}/${month}/${day} ${hours}:${minutes}`;
  };

  const getSummaryStatusInfo = (status: SummaryStatus) => {
    switch (status) {
      case 'pending':
        return {
          label: t('document.detail.summaryStatus.pending'),
          icon: <Clock className="w-4 h-4 text-text-muted" />,
          variant: 'secondary' as const,
        };
      case 'processing':
        return {
          label: t('document.detail.summaryStatus.processing'),
          icon: <Loader2 className="w-4 h-4 text-primary animate-spin" />,
          variant: 'default' as const,
        };
      case 'completed':
        return {
          label: t('document.detail.summaryStatus.completed'),
          icon: <CheckCircle2 className="w-4 h-4 text-success" />,
          variant: 'success' as const,
        };
      case 'failed':
        return {
          label: t('document.detail.summaryStatus.failed'),
          icon: <AlertCircle className="w-4 h-4 text-error" />,
          variant: 'destructive' as const,
        };
      default:
        return {
          label: status,
          icon: null,
          variant: 'secondary' as const,
        };
    }
  };

  const displayData = detail || document;
  const summaryStatusInfo = displayData ? getSummaryStatusInfo(displayData.summary_status) : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[50vw] max-h-[90vh] p-0 gap-0 flex flex-col md:max-w-[50vw] sm:max-w-[95vw]">
        {/* Header */}
        <DialogHeader className="px-6 py-4 border-b border-border flex-shrink-0">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-primary/10 rounded-lg flex-shrink-0">
              <FileText className="w-5 h-5 text-primary" />
            </div>
            <div className="flex-1 min-w-0">
              <DialogTitle className="text-lg font-semibold text-text-primary truncate">
                {displayData?.name || t('document.detail.title')}
              </DialogTitle>
              <p className="text-xs text-text-muted mt-0.5">
                {displayData?.file_extension?.toUpperCase()}
              </p>
            </div>
          </div>
        </DialogHeader>

        {/* Content */}
        <div className="flex-1 overflow-hidden">
          {loading && !detail ? (
            <div className="flex items-center justify-center py-12">
              <Spinner />
            </div>
          ) : error ? (
            <div className="flex flex-col items-center justify-center py-12 text-text-secondary">
              <AlertCircle className="w-12 h-12 mb-4 text-error opacity-50" />
              <p>{error}</p>
            </div>
          ) : displayData ? (
            <ScrollArea className="h-full max-h-[calc(90vh-80px)]">
              <div className="p-6 space-y-6">
                {/* File Info Section */}
                <div className="bg-surface rounded-lg p-4 border border-border">
                  <h3 className="text-sm font-medium text-text-primary mb-3">
                    {t('document.detail.fileInfo')}
                  </h3>
                  <div className="grid grid-cols-2 gap-4 text-sm">
                    <div className="flex items-center gap-2">
                      <HardDrive className="w-4 h-4 text-text-muted" />
                      <span className="text-text-muted">{t('document.document.columns.size')}:</span>
                      <span className="text-text-primary">{formatFileSize(displayData.file_size)}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <Clock className="w-4 h-4 text-text-muted" />
                      <span className="text-text-muted">{t('document.document.columns.date')}:</span>
                      <span className="text-text-primary">{formatDateTime(displayData.created_at)}</span>
                    </div>
                    <div className="flex items-center gap-2 col-span-2">
                      {summaryStatusInfo?.icon}
                      <span className="text-text-muted">{t('document.detail.summaryStatusLabel')}:</span>
                      <Badge variant={summaryStatusInfo?.variant} size="sm">
                        {summaryStatusInfo?.label}
                      </Badge>
                    </div>
                  </div>
                </div>

                {/* Summary Section */}
                <div className="bg-surface rounded-lg p-4 border border-border">
                  <h3 className="text-sm font-medium text-text-primary mb-3">
                    {t('document.detail.summary')}
                  </h3>
                  <div className="text-sm text-text-secondary">
                    {displayData.summary_status === 'completed' && displayData.summary ? (
                      <p className="whitespace-pre-wrap">{displayData.summary}</p>
                    ) : displayData.summary_status === 'processing' ? (
                      <div className="flex items-center gap-2 text-text-muted">
                        <Loader2 className="w-4 h-4 animate-spin" />
                        <span>{t('document.detail.summaryGenerating')}</span>
                      </div>
                    ) : displayData.summary_status === 'failed' ? (
                      <div className="flex items-start gap-2 text-error">
                        <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                        <span>
                          {t('document.detail.summaryError')}
                          {displayData.summary_error && `: ${displayData.summary_error}`}
                        </span>
                      </div>
                    ) : (
                      <p className="text-text-muted">{t('document.detail.noSummary')}</p>
                    )}
                  </div>
                </div>

                {/* Content Section */}
                <div className="bg-surface rounded-lg p-4 border border-border">
                  <h3 className="text-sm font-medium text-text-primary mb-3">
                    {t('document.detail.content')}
                  </h3>
                  <div className="text-sm text-text-secondary max-h-[300px] overflow-y-auto">
                    {detail?.content ? (
                      <pre className="whitespace-pre-wrap font-sans text-text-secondary leading-relaxed">
                        {detail.content}
                      </pre>
                    ) : loading ? (
                      <div className="flex items-center gap-2 text-text-muted">
                        <Loader2 className="w-4 h-4 animate-spin" />
                        <span>{t('common:loading')}</span>
                      </div>
                    ) : (
                      <p className="text-text-muted">{t('document.detail.noContent')}</p>
                    )}
                  </div>
                </div>
              </div>
            </ScrollArea>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
