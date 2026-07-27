// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { CheckCircle2, XCircle, Loader2 } from 'lucide-react'

import { useTranslation } from '@/hooks/useTranslation'
import type { CollectorRunInfo } from '../../api'

interface CollectorRunDetailProps {
  collectors: CollectorRunInfo[]
  loading: boolean
  error: Error | null
}

function CollectorStatusDot({ status }: { status: string }) {
  const config: Record<string, { icon: React.ElementType; color: string }> = {
    success: { icon: CheckCircle2, color: 'text-green-500' },
    failed: { icon: XCircle, color: 'text-red-500' },
    running: { icon: Loader2, color: 'text-blue-500' },
    skipped: { icon: CheckCircle2, color: 'text-gray-400' },
  }
  const c = config[status] ?? config.failed
  const Icon = c.icon
  return <Icon className={`h-3.5 w-3.5 ${c.color} ${status === 'running' ? 'animate-spin' : ''}`} />
}

function formatDuration(start: string | null, end: string | null): string {
  if (!start || !end) return '-'
  const ms = new Date(end).getTime() - new Date(start).getTime()
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${(ms / 60_000).toFixed(1)}m`
}

function formatDurationMs(durationMs: number, start: string | null, end: string | null): string {
  if (durationMs > 0) {
    if (durationMs < 1000) return `${durationMs}ms`
    if (durationMs < 60_000) return `${(durationMs / 1000).toFixed(1)}s`
    return `${(durationMs / 60_000).toFixed(1)}m`
  }
  return formatDuration(start, end)
}

export function CollectorRunDetail({ collectors, loading, error }: CollectorRunDetailProps) {
  const { t } = useTranslation('knowledge-stat')

  if (loading) {
    return (
      <div className="flex items-center justify-center py-4 text-text-muted text-sm">
        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
        {t('loading')}
      </div>
    )
  }

  if (error) {
    return <div className="text-red-500 text-sm py-2">{error.message}</div>
  }

  if (collectors.length === 0) {
    return <div className="text-text-muted text-sm py-2">{t('no_data')}</div>
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-text-secondary text-xs">
            <th className="text-left py-1.5 pr-3 font-medium">{t('runs.collector.status')}</th>
            <th className="text-left py-1.5 pr-3 font-medium">{t('runs.collector.name')}</th>
            <th className="text-left py-1.5 pr-3 font-medium">{t('runs.collector.domain')}</th>
            <th className="text-right py-1.5 pr-3 font-medium">{t('runs.collector.rows')}</th>
            <th className="text-right py-1.5 pr-3 font-medium">{t('runs.collector.duration')}</th>
            <th className="text-left py-1.5 font-medium">{t('runs.collector.error')}</th>
          </tr>
        </thead>
        <tbody>
          {[...collectors]
            .sort((a, b) => (b.duration_ms ?? 0) - (a.duration_ms ?? 0))
            .map(c => (
              <tr key={c.id} className="border-b border-border/50 last:border-0">
                <td className="py-1.5 pr-3">
                  <CollectorStatusDot status={c.status} />
                </td>
                <td className="py-1.5 pr-3 text-text-primary font-mono text-xs">
                  {c.collector_name}
                </td>
                <td className="py-1.5 pr-3 text-text-secondary text-xs">
                  {t(`domains.${c.domain}`, c.domain)}
                </td>
                <td className="py-1.5 pr-3 text-right text-text-secondary tabular-nums">
                  {c.rows_written}
                </td>
                <td className="py-1.5 pr-3 text-right text-text-secondary tabular-nums">
                  {formatDurationMs(c.duration_ms, c.started_at, c.completed_at)}
                </td>
                <td
                  className="py-1.5 text-xs text-red-500 max-w-[300px] truncate"
                  title={c.error_message ?? ''}
                >
                  {c.error_message ?? '-'}
                </td>
              </tr>
            ))}
        </tbody>
      </table>
    </div>
  )
}
