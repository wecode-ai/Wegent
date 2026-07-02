// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

/**
 * Source References Component
 *
 * Displays knowledge base source references for RAG-enhanced responses.
 * Shows document titles with index numbers (e.g., [1], [2], [3]).
 */

import React from 'react'
import { ExternalLink, FileText } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import type { RetrievalSummaryPayload, SourceReference } from '@/types/socket'

export type ExternalSourceOpener = (source: SourceReference) => React.ReactNode

const externalSourceOpeners = new Map<string, ExternalSourceOpener>()

export function registerExternalSourceOpener(
  sourceType: string,
  opener: ExternalSourceOpener
): void {
  if (!sourceType || typeof opener !== 'function') return
  externalSourceOpeners.set(sourceType, opener)
}

export function getExternalSourceOpener(sourceType: string): ExternalSourceOpener | undefined {
  return externalSourceOpeners.get(sourceType)
}

interface SourceReferencesProps {
  sources: SourceReference[]
  retrievalSummary?: RetrievalSummaryPayload
  className?: string
}

function getSourceReferenceKey(source: SourceReference, position: number): string {
  return [
    source.index,
    source.source_type ?? 'internal',
    source.source_id ?? source.kb_id ?? '',
    source.source_uri ?? '',
    source.title ?? '',
    position,
  ].join(':')
}

function isHttpUrl(sourceUri?: string): boolean {
  if (!sourceUri) return false
  try {
    const url = new URL(sourceUri)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

function SourceReferenceItem({
  source,
  openLabel,
  unavailableLabel,
}: {
  source: SourceReference
  openLabel: string
  unavailableLabel: string
}) {
  const label = source.title || source.source_name || source.source_id || String(source.index)
  const sourceUri = source.source_uri
  const opener = source.source_type ? getExternalSourceOpener(source.source_type) : undefined

  if (isHttpUrl(sourceUri)) {
    return (
      <a
        href={sourceUri}
        target="_blank"
        rel="noopener noreferrer"
        className="text-text-secondary hover:text-primary hover:underline inline-flex items-center gap-1 max-w-md"
        title={sourceUri}
        aria-label={openLabel}
      >
        <span className="truncate">{label}</span>
        <ExternalLink className="w-3 h-3 shrink-0" />
      </a>
    )
  }

  if (opener) {
    return <>{opener(source)}</>
  }

  return (
    <span className="text-text-secondary truncate max-w-md" title={sourceUri || unavailableLabel}>
      {label}
    </span>
  )
}

function getCitationSourceKey(source: SourceReference): string | null {
  if (source.source_id) {
    return `${source.source_type || 'external'}:${source.source_id}`
  }
  if (source.kb_id !== null && source.kb_id !== undefined) {
    return `internal:${source.kb_id}`
  }
  if (source.source_uri) {
    return `uri:${source.source_uri}`
  }
  return null
}

function countCitationSources(sources: SourceReference[]): number {
  const sourceKeys = new Set<string>()
  sources.forEach(source => {
    const sourceKey = getCitationSourceKey(source)
    if (sourceKey) {
      sourceKeys.add(sourceKey)
    }
  })
  return sourceKeys.size
}

function RetrievalSummaryFooter({
  sources,
  summary,
}: {
  sources: SourceReference[]
  summary?: RetrievalSummaryPayload
}) {
  const { t } = useTranslation('chat')
  const statuses = summary?.source_statuses ?? []
  const hasDetailedStatuses = statuses.length > 0
  const ignoredCount = hasDetailedStatuses
    ? statuses.filter(status => status.status === 'ignored' || status.status === 'failed').length
    : (summary?.ignored_source_ids?.length ?? 0)
  const noHitCount = statuses.filter(status => status.status === 'no_hit').length

  if (sources.length > 0) {
    const sourceCount = countCitationSources(sources) || sources.length
    return (
      <div className="mt-2 text-xs text-text-muted">
        {t('sourceReferences.footerCited', {
          documents: sources.length,
          sources: sourceCount,
        })}
        {noHitCount > 0 && ` · ${t('sourceReferences.footerNoHit', { count: noHitCount })}`}
        {ignoredCount > 0 && ` · ${t('sourceReferences.footerSkipped', { count: ignoredCount })}`}
      </div>
    )
  }

  const searchedCount = hasDetailedStatuses
    ? statuses.filter(status => status.status === 'hit' || status.status === 'no_hit').length
    : (summary?.searched_source_ids?.length ?? 0)

  if (searchedCount === 0 && ignoredCount === 0) {
    return null
  }

  return (
    <div className="mt-2 text-xs text-text-muted">
      {searchedCount > 0 &&
        t('sourceReferences.footerSearchedNoReferences', { searched: searchedCount })}
      {ignoredCount > 0 &&
        `${searchedCount > 0 ? ' · ' : ''}${t('sourceReferences.footerSkipped', {
          count: ignoredCount,
        })}`}
    </div>
  )
}

export function SourceReferences({
  sources,
  retrievalSummary,
  className = '',
}: SourceReferencesProps) {
  const { t } = useTranslation('chat')
  const hasSources = sources && sources.length > 0
  const hasSummary =
    (retrievalSummary?.source_statuses?.length ?? 0) > 0 ||
    (retrievalSummary?.searched_source_ids?.length ?? 0) > 0 ||
    (retrievalSummary?.ignored_source_ids?.length ?? 0) > 0

  if (!hasSources && !hasSummary) {
    return null
  }

  return (
    <div className={`mt-3 pt-3 border-t border-border ${className}`}>
      <div className="flex items-start gap-2 text-xs text-text-muted">
        <FileText className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
        <div className="flex-1">
          {hasSources && (
            <>
              <div className="font-medium mb-1.5">{t('sourceReferences.title')}:</div>
              <div className="flex flex-wrap gap-x-3 gap-y-1">
                {sources.map((source, position) => (
                  <div
                    key={getSourceReferenceKey(source, position)}
                    className="flex items-baseline gap-1 min-w-0"
                  >
                    <span className="font-mono text-primary">[{source.index}]</span>
                    <SourceReferenceItem
                      source={source}
                      openLabel={t('sourceReferences.openSource')}
                      unavailableLabel={t('sourceReferences.unavailableSource')}
                    />
                  </div>
                ))}
              </div>
            </>
          )}
          <RetrievalSummaryFooter sources={sources} summary={retrievalSummary} />
        </div>
      </div>
    </div>
  )
}
