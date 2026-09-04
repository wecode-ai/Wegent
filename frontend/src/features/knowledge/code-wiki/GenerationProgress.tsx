// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useState } from 'react'
import { Check, ChevronDown, ChevronUp, Circle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { useTranslation } from '@/hooks/useTranslation'
import type { CodeWikiRunProgress, CodeWikiRunStatus } from '@/types/code-wiki'

interface GenerationProgressProps {
  status: CodeWikiRunStatus | null
  onCancel?: () => void
  cancelling?: boolean
}

const PLAN_ONLY_STEPS = ['plan', 'writing', 'publish'] as const
const PLAN_AND_QA_STEPS = ['plan', 'writing', 'qa', 'publish'] as const
type ProgressStep = (typeof PLAN_AND_QA_STEPS)[number]

export function GenerationProgress({
  status,
  onCancel,
  cancelling = false,
}: GenerationProgressProps) {
  const { t } = useTranslation('knowledge')
  const progress = visibleProgress(status)
  const [expanded, setExpanded] = useState(true)

  useEffect(() => setExpanded(true), [status?.generation_id])

  if (!progress) return null
  const hasSteps = progress.total_steps > 0
  const steps = progress.total_steps === 3 ? PLAN_ONLY_STEPS : PLAN_AND_QA_STEPS

  const stepLabel = (step: ProgressStep, number: number) => {
    if (number < progress.current_step) {
      if (step === 'plan') {
        return t('codeWiki.progress.stepLabel.planPassed', { count: progress.pages_total })
      }
      return t(`codeWiki.progress.stepLabel.${step}Completed`, {
        count: progress.pages_total,
      })
    }
    if (number === progress.current_step) {
      if (step === 'writing') {
        return t('codeWiki.progress.stepLabel.writingActive', {
          current: progress.pages_written,
          total: progress.pages_total,
        })
      }
      return t(`codeWiki.progress.stage.${progress.stage}`)
    }
    return t(`codeWiki.progress.stepLabel.${step}`)
  }

  return (
    <div className="px-4 pt-4" data-testid="code-wiki-generation-progress">
      <section className="mx-auto w-full max-w-2xl overflow-hidden rounded-xl border border-border bg-surface shadow-sm">
        <div className="flex items-center">
          <button
            type="button"
            className="flex min-h-11 min-w-0 flex-1 items-center gap-3 px-4 py-3 text-left hover:bg-surface-hover disabled:cursor-default disabled:hover:bg-transparent"
            onClick={() => hasSteps && setExpanded(value => !value)}
            disabled={!hasSteps}
            aria-expanded={hasSteps ? expanded : undefined}
            data-testid="code-wiki-progress-toggle"
          >
            <Spinner size="sm" className="shrink-0 text-primary" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-text-primary">
                {t('codeWiki.progress.title')}
              </p>
              <p
                className="truncate text-xs text-text-tertiary"
                data-testid="code-wiki-progress-stage"
              >
                {t(`codeWiki.progress.stage.${progress.stage}`)}
              </p>
            </div>
            {hasSteps && (
              <>
                <span
                  className="shrink-0 text-xs text-text-tertiary"
                  data-testid="code-wiki-progress-step"
                >
                  {t('codeWiki.progress.step', {
                    current: progress.current_step,
                    total: progress.total_steps,
                  })}
                </span>
                {expanded ? (
                  <ChevronUp className="h-4 w-4 shrink-0 text-text-tertiary" />
                ) : (
                  <ChevronDown className="h-4 w-4 shrink-0 text-text-tertiary" />
                )}
              </>
            )}
          </button>

          {onCancel && (
            <Button
              type="button"
              variant="destructive"
              size="sm"
              onClick={onCancel}
              disabled={cancelling}
              className="mr-3 h-11 shrink-0 sm:h-9"
              data-testid="code-wiki-progress-cancel"
            >
              {cancelling ? <Spinner size="sm" /> : null}
              {t(cancelling ? 'codeWiki.progress.cancelling' : 'codeWiki.progress.cancel')}
            </Button>
          )}
        </div>

        {hasSteps && expanded && (
          <ol
            className="border-t border-border px-4 py-4 sm:px-5"
            data-testid="code-wiki-progress-steps"
          >
            {steps.map((step, index) => {
              const number = index + 1
              const completed = number < progress.current_step
              const active = number === progress.current_step
              return (
                <li key={step} className="flex gap-3" data-testid={`code-wiki-progress-${step}`}>
                  <div className="flex w-5 shrink-0 flex-col items-center">
                    {completed ? (
                      <span className="flex h-5 w-5 items-center justify-center rounded-full bg-success text-white">
                        <Check className="h-3.5 w-3.5" />
                      </span>
                    ) : active ? (
                      <span className="flex h-5 w-5 items-center justify-center rounded-full border-2 border-primary">
                        <span className="h-2 w-2 animate-pulse rounded-full bg-primary" />
                      </span>
                    ) : (
                      <Circle className="h-5 w-5 text-text-tertiary" />
                    )}
                    {index < steps.length - 1 && (
                      <span
                        className={`h-6 w-px ${completed ? 'bg-success' : 'bg-border'}`}
                        aria-hidden="true"
                      />
                    )}
                  </div>
                  <span
                    className={`pb-5 text-sm last:pb-0 ${
                      active
                        ? 'font-medium text-text-primary'
                        : completed
                          ? 'text-text-secondary'
                          : 'text-text-tertiary'
                    }`}
                  >
                    {stepLabel(step, number)}
                  </span>
                </li>
              )
            })}
          </ol>
        )}
      </section>
    </div>
  )
}

export function visibleProgress(status: CodeWikiRunStatus | null): CodeWikiRunProgress | null {
  if (status?.status !== 'running' || status.is_stale) return null
  return status.progress ?? null
}
