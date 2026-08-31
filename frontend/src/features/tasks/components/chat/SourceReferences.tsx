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

import React, { useSyncExternalStore } from 'react'
import { ExternalLink, FileText } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import type { RetrievalSummaryPayload, SourceReference } from '@/types/socket'

export type ExternalSourceOpener = (source: SourceReference) => React.ReactNode

const externalSourceOpeners = new Map<string, ExternalSourceOpener>()
const externalSourceOpenerListeners = new Set<() => void>()
let externalSourceOpenerVersion = 0

const VIDEO_SEGMENT_SOURCE_TYPE = 'wegent_video_segment'
const VIDEO_CHAPTERS_SOURCE_TYPE = 'wegent_video_chapters'

export function registerExternalSourceOpener(
  sourceType: string,
  opener: ExternalSourceOpener
): void {
  if (!sourceType || typeof opener !== 'function') return
  externalSourceOpeners.set(sourceType, opener)
  externalSourceOpenerVersion += 1
  externalSourceOpenerListeners.forEach(listener => listener())
}

export function getExternalSourceOpener(sourceType: string): ExternalSourceOpener | undefined {
  return externalSourceOpeners.get(sourceType)
}

function subscribeExternalSourceOpeners(listener: () => void): () => void {
  externalSourceOpenerListeners.add(listener)
  return () => externalSourceOpenerListeners.delete(listener)
}

function getExternalSourceOpenerVersion(): number {
  return externalSourceOpenerVersion
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

function isVideoSegmentSource(source: SourceReference): boolean {
  return source.source_type === VIDEO_SEGMENT_SOURCE_TYPE
}

function isVideoChaptersSource(source: SourceReference): boolean {
  return source.source_type === VIDEO_CHAPTERS_SOURCE_TYPE
}

function isVideoSource(source: SourceReference): boolean {
  return isVideoSegmentSource(source) || isVideoChaptersSource(source)
}

function videoSegmentCount(source: SourceReference): number {
  return source.segments?.length ?? 0
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
  useSyncExternalStore(
    subscribeExternalSourceOpeners,
    getExternalSourceOpenerVersion,
    getExternalSourceOpenerVersion
  )
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

  const indexedSources = sources.map((source, position) => ({ source, position }))
  const segmentSources = indexedSources
    .filter(({ source }) => isVideoSegmentSource(source))
    .sort(
      (left, right) =>
        videoSegmentCount(right.source) - videoSegmentCount(left.source) ||
        left.position - right.position
    )
  const chapterSources = indexedSources.filter(({ source }) => isVideoChaptersSource(source))
  const otherSources = indexedSources.filter(({ source }) => !isVideoSource(source))
  const renderSource = ({ source, position }: (typeof indexedSources)[number]) => {
    const videoSource = isVideoSource(source)
    return (
      <div
        key={getSourceReferenceKey(source, position)}
        className={videoSource ? 'w-full min-w-0 pb-1' : 'flex min-w-0 items-baseline gap-1'}
      >
        {!videoSource && <span className="font-mono text-primary">[{source.index}]</span>}
        <SourceReferenceItem
          source={source}
          openLabel={t('sourceReferences.openSource')}
          unavailableLabel={t('sourceReferences.unavailableSource')}
        />
      </div>
    )
  }

  return (
    <div className={`mt-3 pt-3 border-t border-border ${className}`}>
      <div className="flex items-start gap-2 text-xs text-text-muted">
        <FileText className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
        <div className="flex-1">
          {hasSources && (
            <>
              <div className="font-medium mb-1.5">{t('sourceReferences.title')}:</div>
              <div className="flex flex-wrap gap-x-3 gap-y-3">
                {segmentSources.map(renderSource)}
                {otherSources.map(renderSource)}
                {chapterSources.length > 0 && (
                  <div className="w-full space-y-2 border-t border-border pt-3">
                    <p className="text-xs font-medium text-text-secondary">
                      {t('sourceReferences.allVideoChapters')}
                    </p>
                    <div className="flex flex-col gap-2">{chapterSources.map(renderSource)}</div>
                  </div>
                )}
              </div>
            </>
          )}
          <RetrievalSummaryFooter sources={sources} summary={retrievalSummary} />
        </div>
      </div>
    </div>
  )
}
