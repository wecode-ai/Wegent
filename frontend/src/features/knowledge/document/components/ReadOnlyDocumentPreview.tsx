// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { useState } from 'react'
import { downloadAttachment, type AttachmentDownloadScope } from '@/apis/attachments'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import type { KnowledgeDocument } from '@/types/knowledge'
import { useDocumentDetail } from '../hooks/useDocumentDetail'
import {
  isKnowledgeSourcePreviewSupported,
  isKnowledgeSourcePreviewTooLarge,
} from '../utils/sourcePreview'
import { DocumentContentViewer } from './DocumentContentViewer'
import { DocumentProtectionBoundary } from './DocumentProtectionBoundary'
import { KnowledgeSourcePreview } from './KnowledgeSourcePreview'

interface ReadOnlyDocumentPreviewProps {
  document: KnowledgeDocument
  allowDownload: boolean
  watermarkText?: string | null
  signal: AbortSignal
  isCurrent: () => boolean
  attachmentScope: AttachmentDownloadScope
  onReadError: (error: unknown, surface: 'content' | 'page' | 'attachment') => void
}

export function ReadOnlyDocumentPreview({
  document,
  allowDownload,
  watermarkText,
  signal,
  isCurrent,
  attachmentScope,
  onReadError,
}: ReadOnlyDocumentPreviewProps) {
  const { t } = useTranslation('knowledge')
  const canPreviewSource = allowDownload && isKnowledgeSourcePreviewSupported(document)
  const [showSource, setShowSource] = useState(canPreviewSource)
  const [downloadFailed, setDownloadFailed] = useState(false)
  const attachmentId = document.attachment_id

  const download = async () => {
    if (!canPreviewSource || !attachmentId || !attachmentScope.isCurrent()) return
    setDownloadFailed(false)
    try {
      await downloadAttachment(attachmentId, document.name, undefined, attachmentScope)
    } catch (error) {
      if (!attachmentScope.isCurrent()) return
      onReadError(error, 'attachment')
      setDownloadFailed(true)
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <p className="break-words font-medium">{document.name}</p>
      {canPreviewSource && (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            aria-pressed={showSource}
            className="min-h-11"
            data-testid="answer-original-file"
            onClick={() => setShowSource(true)}
          >
            {t('document.document.detail.sourceFile')}
          </Button>
          <Button
            type="button"
            variant="outline"
            aria-pressed={!showSource}
            className="min-h-11"
            data-testid="answer-original-parsed"
            onClick={() => setShowSource(false)}
          >
            {t('document.document.detail.parsedContent')}
          </Button>
          {showSource && !isKnowledgeSourcePreviewTooLarge(document.file_size) && (
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              data-testid="answer-original-download"
              onClick={() => void download()}
            >
              {t('document.document.detail.sourcePreview.download')}
            </Button>
          )}
        </div>
      )}
      {canPreviewSource && downloadFailed && (
        <p role="alert">{t('document.document.detail.sourcePreview.downloadFailed')}</p>
      )}
      {showSource && canPreviewSource ? (
        <KnowledgeSourcePreview
          document={document}
          active
          className="md:min-h-0"
          onDownload={() => void download()}
          attachmentScope={attachmentScope}
          onReadError={error => onReadError(error, 'attachment')}
        />
      ) : (
        <DocumentProtectionBoundary
          enabled={!allowDownload}
          knowledgeBaseId={document.kind_id}
          watermarkText={watermarkText || t('document.document.detail.protectedWatermark')}
        >
          <ParsedDocumentPreview
            document={document}
            allowDownload={allowDownload}
            watermarkText={watermarkText}
            signal={signal}
            isCurrent={isCurrent}
            onReadError={onReadError}
          />
        </DocumentProtectionBoundary>
      )}
    </div>
  )
}

function ParsedDocumentPreview({
  document,
  allowDownload,
  watermarkText,
  signal,
  isCurrent,
  onReadError,
}: Omit<ReadOnlyDocumentPreviewProps, 'attachmentScope'>) {
  const { t } = useTranslation('knowledge')
  const [loadMoreFailed, setLoadMoreFailed] = useState(false)
  const { detail, loading, error, loadingMore, hasMoreContent, fullContent, loadMore } =
    useDocumentDetail({
      kbId: document.kind_id,
      docId: document.id,
      includeSummary: false,
      signal,
      onReadError: error => onReadError(error, 'content'),
      onLoadMoreError: error => {
        if (!isCurrent()) return
        setLoadMoreFailed(true)
        onReadError(error, 'page')
      },
    })

  if (!isCurrent()) return null
  if (loading) return <p role="status">{t('document.document.detail.loadingMore')}</p>
  if (error) return null

  return (
    <div
      role="region"
      aria-label={t('document.document.detail.parsedContent')}
      tabIndex={0}
      className="h-full min-h-0 overflow-auto overscroll-contain focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary"
    >
      <DocumentContentViewer
        content={fullContent}
        document={document}
        knowledgeBaseId={document.kind_id}
        isOrganization={false}
        protectedPreview={!allowDownload}
        watermarkText={watermarkText || t('document.document.detail.protectedWatermark')}
        viewMode="preview"
        allowInlineImage={false}
        hasMoreContent={hasMoreContent}
        loadingMore={loadingMore}
        loadMoreFailed={loadMoreFailed}
        contentLength={detail?.content_length}
        onLoadMore={() => {
          if (!isCurrent()) return
          setLoadMoreFailed(false)
          void loadMore()
        }}
        onOpenChange={() => {}}
      />
    </div>
  )
}
