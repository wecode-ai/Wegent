// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useCallback, useEffect, useState } from 'react'
import { Activity, RefreshCw, XCircle } from 'lucide-react'
import { toast } from 'sonner'
import { adminApis, type TaskRunStats } from '@/apis/admin'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Tag } from '@/components/ui/tag'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'

interface StatCardProps {
  title: string
  value: number
  icon: React.ReactNode
  tone?: 'default' | 'success' | 'error' | 'warning'
  subtitle?: string
}

const toneClasses = {
  default: 'border-border bg-card',
  success: 'border-green-500/30 bg-green-500/10',
  error: 'border-red-500/30 bg-red-500/10',
  warning: 'border-yellow-500/30 bg-yellow-500/10',
}

function StatCard({ title, value, icon, tone = 'default', subtitle }: StatCardProps) {
  return (
    <Card className={cn('p-4', toneClasses[tone])}>
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm text-text-muted">{title}</p>
          <p className="text-2xl font-bold text-text-primary">{value}</p>
          {subtitle && <p className="mt-1 text-xs text-text-muted">{subtitle}</p>}
        </div>
        <div className="rounded-full bg-muted p-2 text-text-secondary">{icon}</div>
      </div>
    </Card>
  )
}

function formatDateTime(value: string): string {
  return new Date(value).toLocaleString()
}

export function TaskRunMonitorPanel() {
  const { t } = useTranslation()
  const [timeRange, setTimeRange] = useState('24')
  const [stats, setStats] = useState<TaskRunStats | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isRefreshing, setIsRefreshing] = useState(false)

  const loadStats = useCallback(async () => {
    try {
      setStats(await adminApis.getTaskRunStats(Number(timeRange)))
    } catch (error) {
      console.error('Failed to load task run statistics:', error)
      toast.error(t('admin:task_run_monitor.errors.load_failed'))
    }
  }, [t, timeRange])

  useEffect(() => {
    setIsLoading(true)
    loadStats().finally(() => setIsLoading(false))
  }, [loadStats])

  const handleRefresh = async () => {
    setIsRefreshing(true)
    await loadStats()
    setIsRefreshing(false)
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="h-8 w-8 animate-spin rounded-full border-b-2 border-primary" />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-text-primary">
            {t('admin:task_run_monitor.title')}
          </h1>
          <p className="text-sm text-text-muted">{t('admin:task_run_monitor.description')}</p>
        </div>
        <div className="flex items-center gap-2">
          <Select value={timeRange} onValueChange={setTimeRange}>
            <SelectTrigger className="w-[150px]" data-testid="task-run-time-range">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {['1', '6', '24', '72', '168', '720'].map(hours => (
                <SelectItem key={hours} value={hours}>
                  {t(`admin:task_run_monitor.time_range.${hours}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            variant="outline"
            size="icon"
            onClick={handleRefresh}
            disabled={isRefreshing}
            data-testid="task-run-refresh"
            aria-label={t('admin:task_run_monitor.refresh')}
          >
            <RefreshCw className={cn('h-4 w-4', isRefreshing && 'animate-spin')} />
          </Button>
        </div>
      </div>

      {stats && (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            <StatCard
              title={t('admin:task_run_monitor.stats.total')}
              value={stats.total_runs}
              icon={<Activity className="h-5 w-5" />}
              subtitle={
                stats.total_is_approximate
                  ? t('admin:task_run_monitor.stats.approximate')
                  : undefined
              }
            />
            <StatCard
              title={t('admin:task_run_monitor.stats.failed')}
              value={stats.failed_runs}
              icon={<XCircle className="h-5 w-5" />}
              tone="error"
              subtitle={`${stats.failure_rate.toFixed(1)}%`}
            />
          </div>

          <div className="grid gap-6 xl:grid-cols-2">
            <section className="space-y-3">
              <div>
                <h2 className="text-lg font-semibold text-text-primary">
                  {t('admin:task_run_monitor.failure_reasons.title')}
                </h2>
                <p className="text-sm text-text-muted">
                  {t('admin:task_run_monitor.failure_reasons.description')}
                </p>
              </div>
              <Card className="divide-y divide-border overflow-hidden">
                {stats.failure_reasons.length === 0 ? (
                  <p className="p-8 text-center text-sm text-text-muted">
                    {t('admin:task_run_monitor.failure_reasons.empty')}
                  </p>
                ) : (
                  stats.failure_reasons.map((item, index) => (
                    <div key={`${item.reason}-${index}`} className="space-y-2 p-4">
                      <div className="flex items-start justify-between gap-4">
                        <p className="min-w-0 break-words text-sm text-text-primary">
                          {item.reason || t('admin:task_run_monitor.failure_reasons.unknown')}
                        </p>
                        <Tag variant="error">{item.count}</Tag>
                      </div>
                      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                        <div
                          className="h-full rounded-full bg-red-500"
                          style={{ width: `${Math.max(item.percentage, 2)}%` }}
                        />
                      </div>
                      <p className="text-xs text-text-muted">{item.percentage.toFixed(1)}%</p>
                    </div>
                  ))
                )}
              </Card>
            </section>

            <section className="space-y-3">
              <div>
                <h2 className="text-lg font-semibold text-text-primary">
                  {t('admin:task_run_monitor.recent_failures.title')}
                </h2>
                <p className="text-sm text-text-muted">
                  {t('admin:task_run_monitor.recent_failures.description')}
                </p>
              </div>
              <Card className="max-h-[560px] divide-y divide-border overflow-y-auto">
                {stats.recent_failures.length === 0 ? (
                  <p className="p-8 text-center text-sm text-text-muted">
                    {t('admin:task_run_monitor.recent_failures.empty')}
                  </p>
                ) : (
                  stats.recent_failures.map(item => (
                    <div key={item.subtask_id} className="space-y-2 p-4">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium text-text-primary">{item.task_title}</span>
                        <Tag variant="error">#{item.task_id}</Tag>
                        <Tag variant="default">{item.client_origin}</Tag>
                      </div>
                      <p className="break-words text-sm text-error">
                        {item.error_message || t('admin:task_run_monitor.failure_reasons.unknown')}
                      </p>
                      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-text-muted">
                        <span>
                          {t('admin:task_run_monitor.recent_failures.user')}:{' '}
                          {item.user_name || `#${item.user_id}`}
                        </span>
                        <span>
                          {t('admin:task_run_monitor.recent_failures.subtask')} #{item.subtask_id}
                        </span>
                        <span>{formatDateTime(item.updated_at)}</span>
                      </div>
                    </div>
                  ))
                )}
              </Card>
            </section>
          </div>

          <p className="text-xs text-text-muted">{t('admin:task_run_monitor.rate_note')}</p>
        </>
      )}
    </div>
  )
}

export default TaskRunMonitorPanel
