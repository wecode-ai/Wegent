// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useTranslation } from '@/hooks/useTranslation'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { PromptDraftVersion } from '@/features/prompt-draft/utils/promptDraftStorage'
import { PromptDraftDiffView, buildPromptDraftDiff } from './PromptDraftDiffView'

export interface PromptDraftComparisonPanelProps {
  previousVersion: PromptDraftVersion | null
  nextVersion: PromptDraftVersion | null
  onKeepOld: () => void
  onUseNew: () => void
  isDecisionPending?: boolean
  title?: string
  previousLabel?: string
  nextLabel?: string
  keepActionLabel?: string
  useActionLabel?: string
  className?: string
}

export function PromptDraftComparisonPanel({
  previousVersion,
  nextVersion,
  onKeepOld,
  onUseNew,
  isDecisionPending = false,
  title,
  previousLabel,
  nextLabel,
  keepActionLabel,
  useActionLabel,
  className,
}: PromptDraftComparisonPanelProps) {
  const { t } = useTranslation('pet')

  if (!previousVersion || !nextVersion) {
    return (
      <div
        className={cn('flex h-full items-center justify-center text-sm text-text-muted', className)}
        data-testid="prompt-draft-comparison-panel"
      >
        {t('promptDraft.compare.empty') || 'promptDraft.compare.empty'}
      </div>
    )
  }

  const diff = buildPromptDraftDiff(previousVersion.prompt, nextVersion.prompt)
  const comparisonTitle = title ?? t('promptDraft.compare.title') ?? 'promptDraft.compare.title'
  const keepLabel = keepActionLabel ?? t('promptDraft.keepOld') ?? 'Keep Old'
  const useLabel = useActionLabel ?? t('promptDraft.useNew') ?? 'Use New'
  const previousVersionLabel =
    previousLabel ?? t('promptDraft.compare.previous') ?? 'Previous Version'
  const nextVersionLabel = nextLabel ?? t('promptDraft.compare.next') ?? 'New Version'

  return (
    <div
      className={cn('flex h-full flex-col gap-3', className)}
      data-testid="prompt-draft-comparison-panel"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-sm font-medium text-text-primary">{comparisonTitle}</div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={onKeepOld}
            disabled={isDecisionPending}
            data-testid="prompt-draft-keep-old-button"
          >
            {keepLabel}
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={onUseNew}
            disabled={isDecisionPending}
            data-testid="prompt-draft-use-new-button"
          >
            {useLabel}
          </Button>
        </div>
      </div>

      <div className="text-xs text-text-muted">
        {t('promptDraft.compare.summary') || 'promptDraft.compare.summary'}: +{diff.added} / -
        {diff.removed} / ~{diff.unchanged}
      </div>

      <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-2">
        <section className="flex min-h-0 flex-col rounded-lg border border-border bg-surface/40 p-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="truncate text-sm font-medium text-text-primary">
                {previousVersionLabel}
              </div>
              <div className="text-xs text-text-muted">{previousVersion.title}</div>
            </div>
            <div className="text-xs text-text-muted">
              {previousVersion.model} · {previousVersion.source}
            </div>
          </div>
          <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap rounded-md bg-base p-3 text-sm text-text-primary">
            {previousVersion.prompt}
          </pre>
        </section>

        <section className="flex min-h-0 flex-col rounded-lg border border-border bg-surface/40 p-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="truncate text-sm font-medium text-text-primary">
                {nextVersionLabel}
              </div>
              <div className="text-xs text-text-muted">{nextVersion.title}</div>
            </div>
            <div className="text-xs text-text-muted">
              {nextVersion.model} · {nextVersion.source}
            </div>
          </div>
          <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap rounded-md bg-base p-3 text-sm text-text-primary">
            {nextVersion.prompt}
          </pre>
        </section>
      </div>

      <div className="min-h-0 flex-1">
        <div className="mb-2 text-sm font-medium text-text-primary">
          {t('promptDraft.compare.diff') || 'promptDraft.compare.diff'}
        </div>
        <PromptDraftDiffView
          originalPrompt={previousVersion.prompt}
          currentPrompt={nextVersion.prompt}
          className="max-h-[240px] overflow-auto"
        />
      </div>
    </div>
  )
}
