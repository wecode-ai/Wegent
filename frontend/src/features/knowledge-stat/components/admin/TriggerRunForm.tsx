// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useCallback, useMemo } from 'react'
import { Play, Loader2 } from 'lucide-react'

import { useTranslation } from '@/hooks/useTranslation'
import { Button } from '@/components/ui/button'
import { triggerRun } from '../../api'
import { enumerateDateRange, inclusiveDateCount, localYesterday } from '../../date-utils'
import { useMetricList } from '../../hooks/useMetricList'
import { DOMAIN_LIST } from './constants'

interface TriggerRunFormProps {
  onTriggered?: () => void
}

export function TriggerRunForm({ onTriggered }: TriggerRunFormProps) {
  const { t } = useTranslation('knowledge-stat')
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [selectedDomains, setSelectedDomains] = useState<Set<string>>(new Set())
  const [submitting, setSubmitting] = useState(false)
  const [result, setResult] = useState<{
    type: 'success' | 'partial' | 'failed'
    message: string
  } | null>(null)

  // Domain list now comes from the backend so newly registered domains
  // (e.g. content_quality, which used to be missing from the hardcoded
  // DOMAIN_LIST) are selectable without a frontend redeploy. Falls back
  // to the static list while loading or if the metric endpoint fails.
  const { data: metricList } = useMetricList('admin')
  const domains = useMemo(() => {
    const backend = metricList?.domains?.map(d => d.domain).filter(d => d && d !== 'dashboard')
    return backend && backend.length > 0 ? backend : DOMAIN_LIST
  }, [metricList])
  const yesterday = useMemo(localYesterday, [])
  const validationError = useMemo(() => {
    if (!startDate) return null
    const effectiveEnd = endDate || startDate
    if (effectiveEnd < startDate) return t('runs.trigger.invalid_range')
    if (startDate > yesterday || effectiveEnd > yesterday) {
      return t('runs.trigger.future_date')
    }
    const days = inclusiveDateCount(startDate, effectiveEnd)
    if (days > 31) return t('runs.trigger.range_too_large')
    return null
  }, [startDate, endDate, yesterday, t])

  const toggleDomain = useCallback((domain: string) => {
    setSelectedDomains(prev => {
      const next = new Set(prev)
      if (next.has(domain)) {
        next.delete(domain)
      } else {
        next.add(domain)
      }
      return next
    })
  }, [])

  const handleSubmit = useCallback(async () => {
    if (!startDate || validationError) return

    const dates = enumerateDateRange(startDate, endDate || startDate)

    const domains = selectedDomains.size > 0 ? Array.from(selectedDomains) : undefined
    setSubmitting(true)
    setResult(null)

    // Serial dispatch: the backend rejects concurrent runs for the same
    // target_date with 409 run_in_progress, and a single kb_stat worker
    // processes the queue sequentially anyway. Sending all dates at once
    // would only inflate the 409 noise and confuse the success/fail tally.
    let successCount = 0
    let failCount = 0
    let skippedCount = 0
    for (const date of dates) {
      try {
        await triggerRun({ target_date: date, domains })
        successCount++
      } catch (err: unknown) {
        // 409 = a run is already in progress for this date; treat as
        // skipped rather than a hard failure so the user sees the truth.
        const status = (err as { status?: number } | null)?.status
        if (status === 409) {
          skippedCount++
        } else {
          failCount++
        }
      }
    }

    if (failCount === 0) {
      const skippedNote = skippedCount > 0 ? ` (${skippedCount} ${t('runs.trigger.skipped')})` : ''
      setResult({ type: 'success', message: `${t('runs.trigger.success')}${skippedNote}` })
    } else if (successCount > 0) {
      setResult({ type: 'partial', message: t('runs.trigger.partial_success') })
    } else {
      setResult({ type: 'failed', message: t('runs.trigger.failed') })
    }

    setSubmitting(false)
    onTriggered?.()

    setTimeout(() => setResult(null), 5000)
  }, [startDate, endDate, selectedDomains, t, onTriggered, validationError])

  return (
    <div className="rounded-lg border border-border bg-surface p-4 space-y-3">
      <h3 className="text-sm font-semibold text-text-primary flex items-center gap-2">
        <Play className="h-4 w-4 text-primary" />
        {t('runs.trigger.title')}
      </h3>

      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <label className="text-sm text-text-secondary">{t('runs.trigger.start_date')}</label>
          <input
            type="date"
            value={startDate}
            onChange={e => setStartDate(e.target.value)}
            max={endDate || yesterday}
            className="rounded-md border border-border bg-base px-3 py-1.5 text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-primary/30"
            data-testid="trigger-start-date"
          />
        </div>
        <span className="text-text-muted">~</span>
        <div className="flex items-center gap-2">
          <label className="text-sm text-text-secondary">{t('runs.trigger.end_date')}</label>
          <input
            type="date"
            value={endDate}
            onChange={e => setEndDate(e.target.value)}
            min={startDate || undefined}
            max={yesterday}
            className="rounded-md border border-border bg-base px-3 py-1.5 text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-primary/30"
            data-testid="trigger-end-date"
          />
        </div>
        <span className="text-xs text-text-muted">{t('runs.trigger.single_day_hint')}</span>
        {validationError && <span className="text-xs text-red-500">{validationError}</span>}
      </div>

      <div className="space-y-1.5">
        <span className="text-sm text-text-secondary">{t('runs.trigger.domains')}</span>
        <div className="flex flex-wrap gap-2">
          {domains.map(domain => (
            <button
              key={domain}
              type="button"
              onClick={() => toggleDomain(domain)}
              className={`rounded-md border px-2.5 py-1 text-xs font-medium transition-colors ${
                selectedDomains.has(domain)
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'border-border bg-base text-text-secondary hover:border-primary/50'
              }`}
              data-testid={`trigger-domain-${domain}`}
            >
              {t(`domains.${domain}`, domain)}
            </button>
          ))}
        </div>
        <span className="text-xs text-text-muted">{t('runs.trigger.domains_placeholder')}</span>
      </div>

      <div className="flex items-center gap-3">
        <Button
          variant="primary"
          size="sm"
          onClick={handleSubmit}
          disabled={!startDate || submitting || !!validationError}
          data-testid="trigger-submit"
        >
          {submitting ? (
            <>
              <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
              {t('runs.trigger.submitting')}
            </>
          ) : (
            <>
              <Play className="h-3.5 w-3.5 mr-1.5" />
              {t('runs.trigger.submit')}
            </>
          )}
        </Button>
        {result && (
          <span
            className={`text-xs font-medium ${
              result.type === 'success'
                ? 'text-green-600'
                : result.type === 'partial'
                  ? 'text-yellow-600'
                  : 'text-red-600'
            }`}
          >
            {result.message}
          </span>
        )}
      </div>
    </div>
  )
}
