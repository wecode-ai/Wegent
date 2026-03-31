// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { Button } from '@/components/ui/button'
import { cn, formatUTCDate } from '@/lib/utils'
import { useTranslation } from '@/hooks/useTranslation'
import type { PromptDraftVersion } from '@/features/prompt-draft/utils/promptDraftStorage'

export interface PromptDraftVersionListProps {
  versions: PromptDraftVersion[]
  currentVersionId: string
  onRollback: (versionId: string) => void
  onCompareToCurrent: (versionId: string) => void
  isDecisionPending?: boolean
  className?: string
}

function getSourceLabel(t: (key: string) => string, source: PromptDraftVersion['source']): string {
  const key = `promptDraft.source.${source}`
  return t(key) || key
}

export function PromptDraftVersionList({
  versions,
  currentVersionId,
  onRollback,
  onCompareToCurrent,
  isDecisionPending = false,
  className,
}: PromptDraftVersionListProps) {
  const { t } = useTranslation('pet')
  const visibleVersions = versions.slice(0, 3)

  return (
    <div className={cn('space-y-2', className)} data-testid="prompt-draft-version-list">
      <div className="text-sm font-medium text-text-primary">
        {t('promptDraft.versions') || 'promptDraft.versions'}
      </div>
      <div className="space-y-2">
        {visibleVersions.map(version => {
          const isCurrent = version.id === currentVersionId
          const disabled = isDecisionPending || isCurrent

          return (
            <article
              key={version.id}
              className={cn(
                'rounded-lg border border-border bg-base p-3',
                isCurrent && 'border-primary/50 bg-primary/5'
              )}
              data-testid={`prompt-draft-version-card-${version.id}`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <div className="truncate text-sm font-medium text-text-primary">
                      {version.title}
                    </div>
                    {isCurrent && (
                      <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs text-primary">
                        {t('promptDraft.currentVersion') || 'promptDraft.currentVersion'}
                      </span>
                    )}
                  </div>
                  <div className="mt-1 text-xs text-text-muted">
                    {getSourceLabel(t, version.source)} · {formatUTCDate(version.createdAt)}
                  </div>
                  <div className="mt-1 text-xs text-text-muted">
                    {version.model} · v{version.version}
                  </div>
                </div>

                <div className="flex shrink-0 flex-col gap-2 sm:flex-row">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => onCompareToCurrent(version.id)}
                    disabled={disabled}
                    data-testid={`prompt-draft-compare-button-${version.id}`}
                  >
                    {t('promptDraft.compareToCurrent') || 'promptDraft.compareToCurrent'}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => onRollback(version.id)}
                    disabled={disabled}
                    data-testid={`prompt-draft-rollback-button-${version.id}`}
                  >
                    {t('promptDraft.rollback') || 'promptDraft.rollback'}
                  </Button>
                </div>
              </div>
            </article>
          )
        })}
      </div>
    </div>
  )
}
