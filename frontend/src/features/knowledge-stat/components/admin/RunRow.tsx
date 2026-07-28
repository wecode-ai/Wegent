// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import {
  RotateCcw,
  ChevronDown,
  ChevronRight,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Loader2,
} from 'lucide-react'

import { useTranslation } from '@/hooks/useTranslation'
import { Button } from '@/components/ui/button'
import type { RunInfo } from '../../api'
import { retryRun } from '../../api'
import { useCollectorRuns } from '../../hooks/useCollectorRuns'
import { CollectorRunDetail } from './CollectorRunDetail'

interface RunRowProps {
  run: RunInfo
  expanded: boolean
  onToggle: () => void
  onRetried?: () => void
}

function StatusBadge({ status }: { status: string }) {
  const { t } = useTranslation('knowledge-stat')

  const config: Record<string, { icon: React.ElementType; className: string }> = {
    completed: { icon: CheckCircle2, className: 'text-green-600 bg-green-50' },
    partial: { icon: AlertTriangle, className: 'text-yellow-600 bg-yellow-50' },
    failed: { icon: XCircle, className: 'text-red-600 bg-red-50' },
    running: { icon: Loader2, className: 'text-blue-600 bg-blue-50' },
  }

  const c = config[status] ?? config.failed
  const Icon = c.icon

  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${c.className}`}
    >
      <Icon className={`h-3 w-3 ${status === 'running' ? 'animate-spin' : ''}`} />
      {t(`runs.status.${status}`, status)}
    </span>
  )
}

function formatTime(iso: string | null): string {
  if (!iso) return '-'
  // Pure date (YYYY-MM-DD, no time component): JS new Date() treats this
  // as UTC midnight, then getHours() shifts by local timezone → shows
  // 08:00:00 in UTC+8. Detect and short-circuit for date-only strings.
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    return iso
  }
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function formatDuration(start: string | null, end: string | null): string {
  if (!start || !end) return '-'
  const ms = new Date(end).getTime() - new Date(start).getTime()
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${(ms / 60_000).toFixed(1)}m`
}

export function RunRow({ run, expanded, onToggle, onRetried }: RunRowProps) {
  const { t, i18n } = useTranslation('knowledge-stat')
  const collectorHook = useCollectorRuns()
  const canRetry = run.status === 'failed' || run.status === 'partial'

  const handleToggle = () => {
    if (!expanded) {
      collectorHook.load(run.id)
    } else {
      collectorHook.reset()
    }
    onToggle()
  }

  const handleRetry = async () => {
    if (!confirm(t('runs.list.retry_confirm'))) return
    try {
      await retryRun(run.id)
      onRetried?.()
    } catch {
      // error already handled by apiClient
    }
  }

  return (
    <div className="rounded-lg border border-border bg-surface overflow-hidden">
      <div
        className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-muted/30 transition-colors"
        onClick={handleToggle}
        data-testid={`run-row-${run.id}`}
      >
        <button
          type="button"
          className="text-text-muted shrink-0"
          aria-label={expanded ? t('runs.list.collapse') : t('runs.list.expand')}
        >
          {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </button>

        <span className="text-xs font-mono text-text-muted shrink-0">#{run.id}</span>

        <span className="text-sm text-text-primary shrink-0 tabular-nums">
          {run.target_date ?? '-'}
        </span>

        <StatusBadge status={run.status} />

        <span className="text-xs text-text-secondary shrink-0">
          {formatDuration(run.started_at, run.completed_at)}
        </span>

        <span className="text-xs text-text-muted shrink-0">{run.metrics_count} rows</span>

        <span className="text-xs text-text-muted shrink-0">
          {i18n.exists(`runs.triggered_by.${run.triggered_by}`)
            ? t(`runs.triggered_by.${run.triggered_by}`)
            : run.triggered_by}
        </span>

        {run.triggered_user_id && (
          <span className="text-xs text-text-muted shrink-0">UID: {run.triggered_user_id}</span>
        )}

        {run.error_message && (
          <span className="text-xs text-red-500 truncate max-w-[200px]" title={run.error_message}>
            {run.error_message}
          </span>
        )}

        <div className="flex-1" />

        {canRetry && (
          <Button
            variant="ghost"
            size="sm"
            onClick={e => {
              e.stopPropagation()
              handleRetry()
            }}
            className="text-xs h-7 shrink-0"
            data-testid={`run-retry-${run.id}`}
          >
            <RotateCcw className="h-3 w-3 mr-1" />
            {t('runs.list.retry')}
          </Button>
        )}
      </div>

      <div className="flex items-center gap-4 px-4 pb-2 pt-0 cursor-pointer" onClick={handleToggle}>
        <span className="w-4 shrink-0" />
        {run.stat_start && (
          <span className="text-[11px] text-primary/80">
            {t('runs.list.stat_range')}: {formatTime(run.stat_start)}
            {run.stat_end ? ` ~ ${formatTime(run.stat_end)}` : ''}
          </span>
        )}
        <span className="text-[11px] text-text-muted">
          {t('runs.list.started_at')}: {formatTime(run.started_at)}
        </span>
        <span className="text-[11px] text-text-muted">
          {t('runs.list.completed_at')}: {formatTime(run.completed_at)}
        </span>
      </div>

      {expanded && (
        <div className="border-t border-border px-4 py-3">
          <CollectorRunDetail
            collectors={collectorHook.collectors}
            loading={collectorHook.loading}
            error={collectorHook.error}
          />
        </div>
      )}
    </div>
  )
}
