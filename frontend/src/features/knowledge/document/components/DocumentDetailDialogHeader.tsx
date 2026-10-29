// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useMemo, useState } from 'react'
import { Download, ExternalLink, FileText, Maximize2, Minimize2, RefreshCw } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { cn } from '@/lib/utils'
import { formatFileSize } from '@/apis/attachments'
import { wikiApis } from '@/apis/wiki'
import { useTranslation } from '@/hooks/useTranslation'
import type { KnowledgeDocument } from '@/types/knowledge'
import { formatDateTime } from '@/utils/dateTime'
import { parseUTCDate } from '@/lib/utils'
import { getExternalSourceInfo, getSyncedWikiConnectorType } from '../utils/documentUtils'
import { ExternalDocumentBadge } from './ExternalDocumentBadge'
import { ExternalSourceStatusBadge } from './ExternalSourceStatusBadge'

interface DocumentDetailDialogHeaderProps {
  document: KnowledgeDocument
  isFullscreen: boolean
  canSyncSource: boolean
  sourceSyncBusy: boolean
  sourceSyncLabel: string
  onSourceSync: () => void
  canPreviewSource: boolean
  isSourceView: boolean
  isEditing: boolean
  contentSourceMode: 'parsed' | 'source'
  onContentSourceModeChange: (mode: 'parsed' | 'source') => void
  onToggleFullscreen: () => void
  allowDownload: boolean
  onSourceDownload: () => void
  getCurrentLanguage: (language?: string) => string
}

export function DocumentDetailDialogHeader({
  document,
  isFullscreen,
  canSyncSource,
  sourceSyncBusy,
  sourceSyncLabel,
  onSourceSync,
  canPreviewSource,
  isSourceView,
  isEditing,
  contentSourceMode,
  onContentSourceModeChange,
  onToggleFullscreen,
  allowDownload,
  onSourceDownload,
  getCurrentLanguage,
}: DocumentDetailDialogHeaderProps) {
  const { t } = useTranslation('knowledge')
  const [resolvedWikiConnection, setResolvedWikiConnection] = useState<{
    id: string
    name: string | null
  } | null>(null)
  const sourceInfo = useMemo(() => getExternalSourceInfo(document), [document])
  const syncedWikiConnectorType = useMemo(() => getSyncedWikiConnectorType(document), [document])
  const wikiConnectionId =
    sourceInfo?.provider === 'wiki' && sourceInfo.sync?.enabled
      ? sourceInfo.sync.connection_id
      : undefined
  const wikiConnectionName =
    resolvedWikiConnection && resolvedWikiConnection.id === wikiConnectionId
      ? resolvedWikiConnection.name
      : null
  const externalLastImportedAt = useMemo(() => {
    if (!sourceInfo?.last_success_at) return null
    const date = parseUTCDate(sourceInfo.last_success_at)
    return date && !Number.isNaN(date.getTime()) ? formatDateTime(date.getTime()) : null
  }, [sourceInfo])

  useEffect(() => {
    if (!wikiConnectionId) return

    let cancelled = false
    void wikiApis
      .listConnections()
      .then(response => {
        if (cancelled) return
        const connection = response.connections.find(item => item.id === wikiConnectionId)
        setResolvedWikiConnection({
          id: wikiConnectionId,
          name: connection?.display_name || null,
        })
      })
      .catch(() => {
        if (!cancelled) setResolvedWikiConnection({ id: wikiConnectionId, name: null })
      })

    return () => {
      cancelled = true
    }
  }, [wikiConnectionId])

  return (
    <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
      <div className="flex min-w-0 items-start gap-3">
        <div className="mt-0.5 flex-shrink-0 rounded-lg bg-primary/10 p-2">
          <FileText className="h-5 w-5 text-primary" />
        </div>
        <div className="min-w-0 flex-1">
          <DialogTitle className="truncate text-base font-medium text-text-primary">
            {document.name}
          </DialogTitle>
          {!isFullscreen && (
            <DialogDescription className="mt-1 flex items-center gap-2 text-xs text-text-muted">
              <span>{document.file_extension.toUpperCase()}</span>
              <span>•</span>
              <span>{formatFileSize(document.file_size)}</span>
              <span>•</span>
              <span>
                {new Date(document.created_at).toLocaleDateString(getCurrentLanguage(), {
                  year: 'numeric',
                  month: '2-digit',
                  day: '2-digit',
                })}
              </span>
            </DialogDescription>
          )}
          {!isFullscreen && sourceInfo && (
            <div
              className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-text-muted"
              data-testid="external-source-info"
            >
              {syncedWikiConnectorType ? (
                <ExternalDocumentBadge
                  syncedWiki
                  extension={document.file_extension}
                  connectorType={syncedWikiConnectorType}
                />
              ) : (
                <span className="capitalize">{sourceInfo.provider}</span>
              )}
              {wikiConnectionName && (
                <>
                  <span>•</span>
                  <span data-testid="external-wiki-connection-name">
                    {t('document.document.externalSource.wikiConnectionName', {
                      name: wikiConnectionName,
                    })}
                  </span>
                </>
              )}
              <span>•</span>
              {sourceInfo.url && (
                <a
                  href={sourceInfo.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex min-h-[44px] min-w-[44px] items-center gap-1 text-primary hover:underline md:min-h-0 md:min-w-0"
                  data-testid="external-source-link"
                >
                  <span className="truncate">{sourceInfo.title || sourceInfo.url}</span>
                  <ExternalLink className="h-3 w-3 flex-shrink-0" />
                </a>
              )}
              {externalLastImportedAt && (
                <>
                  <span>•</span>
                  <span>
                    {t('document.document.externalSource.lastImportedAt', {
                      time: externalLastImportedAt,
                    })}
                  </span>
                </>
              )}
              {sourceInfo.status === 'accessible' ? (
                <Badge
                  variant="default"
                  size="sm"
                  className="bg-green-500/10 text-green-600 border-green-500/20"
                >
                  {t('document.document.externalSource.accessible')}
                </Badge>
              ) : (
                <ExternalSourceStatusBadge
                  document={document}
                  testId="external-source-inaccessible"
                />
              )}
            </div>
          )}
        </div>
      </div>

      <div className="flex flex-shrink-0 items-center gap-2 max-md:w-full">
        {!isFullscreen && canSyncSource && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onSourceSync}
            disabled={sourceSyncBusy}
            aria-label={sourceSyncLabel}
            className="flex-shrink-0 max-md:min-h-[44px] max-md:min-w-[44px]"
            data-testid={`document-detail-sync-dingtalk-${document.id}`}
          >
            <RefreshCw className={cn('h-3.5 w-3.5 md:mr-1', sourceSyncBusy && 'animate-spin')} />
            <span className="hidden md:inline">{sourceSyncLabel}</span>
          </Button>
        )}
        {!isEditing && canPreviewSource && (
          <div
            className={cn(
              'flex flex-shrink-0 items-center gap-2',
              !isSourceView && 'invisible pointer-events-none'
            )}
            aria-hidden={!isSourceView}
            data-testid="knowledge-source-preview-actions"
          >
            {allowDownload && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={onSourceDownload}
                className="max-md:min-h-[44px] max-md:min-w-[44px]"
                aria-label={t('document.document.detail.sourcePreview.download')}
                data-testid="knowledge-source-preview-download"
              >
                <Download className="h-3.5 w-3.5" />
                <span className="hidden md:inline">
                  {t('document.document.detail.sourcePreview.download')}
                </span>
              </Button>
            )}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onToggleFullscreen}
              className="max-md:min-h-[44px] max-md:min-w-[44px]"
              aria-label={
                isFullscreen
                  ? t('document.document.detail.exitFullscreen')
                  : t('document.document.detail.fullscreen')
              }
              data-testid="knowledge-source-preview-fullscreen"
            >
              {isFullscreen ? (
                <Minimize2 className="h-3.5 w-3.5" />
              ) : (
                <Maximize2 className="h-3.5 w-3.5" />
              )}
            </Button>
          </div>
        )}

        {!isFullscreen && canPreviewSource && (
          <Tabs
            value={contentSourceMode}
            onValueChange={value => onContentSourceModeChange(value as 'parsed' | 'source')}
            className="max-md:flex-1"
          >
            <TabsList className="h-8 max-md:grid max-md:h-11 max-md:w-full max-md:grid-cols-2">
              <TabsTrigger
                value="source"
                className="h-7 px-3 text-xs max-md:min-h-[44px]"
                data-testid="knowledge-document-source-tab"
              >
                {t('document.document.detail.sourceFile')}
              </TabsTrigger>
              <TabsTrigger
                value="parsed"
                className="h-7 px-3 text-xs max-md:min-h-[44px]"
                data-testid="knowledge-document-parsed-tab"
              >
                {t('document.document.detail.parsedContent')}
              </TabsTrigger>
            </TabsList>
          </Tabs>
        )}
      </div>
    </div>
  )
}
