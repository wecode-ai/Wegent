// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import {
  adminApis,
  BackgroundExecutionMonitorStats,
  BackgroundExecutionMonitorError,
} from '@/apis/admin'
import { toast } from 'sonner'
import {
  Activity,
  CheckCircle,
  XCircle,
  Clock,
  AlertTriangle,
  Play,
  Pause,
  RefreshCw,
} from 'lucide-react'
import { ChevronLeftIcon, ChevronRightIcon } from '@heroicons/react/24/solid'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Tag } from '@/components/ui/tag'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { cn } from '@/lib/utils'

interface StatCardProps {
  title: string
  value: number | string
  icon: React.ReactNode
  variant?: 'default' | 'success' | 'warning' | 'error'
  subtitle?: string
}

function StatCard({ title, value, icon, variant = 'default', subtitle }: StatCardProps) {
  const variantClasses = {
    default: 'bg-card border-border',
    success: 'bg-green-500/10 border-green-500/30',
    warning: 'bg-yellow-500/10 border-yellow-500/30',
    error: 'bg-red-500/10 border-red-500/30',
  }

  const iconClasses = {
    default: 'text-text-muted',
    success: 'text-green-500',
    warning: 'text-yellow-500',
    error: 'text-red-500',
  }

  return (
    <div className={cn('rounded-lg border p-4', variantClasses[variant])}>
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm text-text-muted">{title}</p>
          <p className="text-2xl font-bold text-text-primary">{value}</p>
          {subtitle && <p className="text-xs text-text-muted mt-1">{subtitle}</p>}
        </div>
        <div className={cn('p-2 rounded-full bg-muted', iconClasses[variant])}>{icon}</div>
      </div>
    </div>
  )
}

function getStatusTag(status: string) {
  switch (status) {
    case 'COMPLETED':
      return <Tag variant="success">{status}</Tag>
    case 'FAILED':
      return <Tag variant="error">{status}</Tag>
    case 'RUNNING':
      return <Tag variant="info">{status}</Tag>
    case 'PENDING':
      return <Tag variant="warning">{status}</Tag>
    case 'CANCELLED':
      return <Tag variant="default">{status}</Tag>
    default:
      return <Tag variant="default">{status}</Tag>
  }
}

function formatDateTime(dateStr: string | null): string {
  if (!dateStr) return '-'
  const date = new Date(dateStr)
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function BackgroundExecutionMonitorPanel() {
  const { t } = useTranslation()
  const [stats, setStats] = useState<BackgroundExecutionMonitorStats | null>(null)
  const [errors, setErrors] = useState<BackgroundExecutionMonitorError[]>([])
  const [total, setTotal] = useState(0)
  const [isLoading, setIsLoading] = useState(true)
  const [isRefreshing, setIsRefreshing] = useState(false)

  // Filter states
  const [timeRange, setTimeRange] = useState('24')
  const [statusFilter, setStatusFilter] = useState<string>('all')
  const [page, setPage] = useState(1)
  const limit = 20

  const loadStats = useCallback(async () => {
    try {
      const data = await adminApis.getBackgroundExecutionMonitorStats(parseInt(timeRange))
      setStats(data)
    } catch (error) {
      console.error('Failed to load background execution monitor stats:', error)
      toast.error(t('admin:monitor.errors.load_stats_failed'))
    }
  }, [timeRange, t])

  const loadErrors = useCallback(async () => {
    try {
      const status = statusFilter === 'all' ? undefined : statusFilter
      const data = await adminApis.getBackgroundExecutionMonitorErrors(
        page,
        limit,
        parseInt(timeRange),
        status
      )
      setErrors(data.items)
      setTotal(data.total)
    } catch (error) {
      console.error('Failed to load background execution monitor errors:', error)
      toast.error(t('admin:monitor.errors.load_errors_failed'))
    }
  }, [page, timeRange, statusFilter, t])

  const loadData = useCallback(async () => {
    setIsLoading(true)
    await Promise.all([loadStats(), loadErrors()])
    setIsLoading(false)
  }, [loadStats, loadErrors])

  const handleRefresh = useCallback(async () => {
    setIsRefreshing(true)
    await Promise.all([loadStats(), loadErrors()])
    setIsRefreshing(false)
  }, [loadStats, loadErrors])

  useEffect(() => {
    loadData()
  }, [loadData])

  useEffect(() => {
    setPage(1)
  }, [timeRange, statusFilter])

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    )
  }

  const totalPages = Math.ceil(total / limit)

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-text-primary">{t('admin:monitor.title')}</h1>
          <p className="text-text-muted text-sm">{t('admin:monitor.description')}</p>
        </div>
        <div className="flex items-center gap-2">
          <Select value={timeRange} onValueChange={setTimeRange}>
            <SelectTrigger className="w-[140px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="1">{t('admin:monitor.time_range.1h')}</SelectItem>
              <SelectItem value="6">{t('admin:monitor.time_range.6h')}</SelectItem>
              <SelectItem value="24">{t('admin:monitor.time_range.24h')}</SelectItem>
              <SelectItem value="72">{t('admin:monitor.time_range.3d')}</SelectItem>
              <SelectItem value="168">{t('admin:monitor.time_range.7d')}</SelectItem>
            </SelectContent>
          </Select>
          <Button variant="outline" size="icon" onClick={handleRefresh} disabled={isRefreshing}>
            <RefreshCw className={cn('h-4 w-4', isRefreshing && 'animate-spin')} />
          </Button>
        </div>
      </div>

      {/* Stats Grid */}
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
          <StatCard
            title={t('admin:monitor.stats.total_executions')}
            value={stats.total_executions}
            icon={<Activity className="h-5 w-5" />}
          />
          <StatCard
            title={t('admin:monitor.stats.completed')}
            value={stats.completed_count}
            icon={<CheckCircle className="h-5 w-5" />}
            variant="success"
            subtitle={`${stats.success_rate.toFixed(1)}%`}
          />
          <StatCard
            title={t('admin:monitor.stats.failed')}
            value={stats.failed_count}
            icon={<XCircle className="h-5 w-5" />}
            variant="error"
            subtitle={`${stats.failure_rate.toFixed(1)}%`}
          />
          <StatCard
            title={t('admin:monitor.stats.timeout')}
            value={stats.timeout_count}
            icon={<Clock className="h-5 w-5" />}
            variant="warning"
            subtitle={`${stats.timeout_rate.toFixed(1)}%`}
          />
          <StatCard
            title={t('admin:monitor.stats.running')}
            value={stats.running_count}
            icon={<Play className="h-5 w-5" />}
          />
          <StatCard
            title={t('admin:monitor.stats.pending')}
            value={stats.pending_count}
            icon={<Pause className="h-5 w-5" />}
          />
        </div>
      )}

      {/* Subscription Stats */}
      {stats && (
        <div className="grid grid-cols-2 gap-4">
          <StatCard
            title={t('admin:monitor.stats.active_subscriptions')}
            value={stats.active_subscriptions_count}
            icon={<Activity className="h-5 w-5" />}
            subtitle={t('admin:monitor.stats.enabled_subscriptions')}
          />
          <StatCard
            title={t('admin:monitor.stats.total_subscriptions')}
            value={stats.total_subscriptions_count}
            icon={<AlertTriangle className="h-5 w-5" />}
            subtitle={t('admin:monitor.stats.all_subscriptions')}
          />
        </div>
      )}

      {/* Error List */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-text-primary">
            {t('admin:monitor.error_list.title')}
          </h2>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-[140px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t('admin:monitor.error_list.all_status')}</SelectItem>
              <SelectItem value="FAILED">{t('admin:monitor.error_list.failed')}</SelectItem>
              <SelectItem value="CANCELLED">{t('admin:monitor.error_list.cancelled')}</SelectItem>
              <SelectItem value="RUNNING">{t('admin:monitor.error_list.running')}</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="bg-base border border-border rounded-md p-2 w-full max-h-[50vh] flex flex-col overflow-y-auto">
          {errors.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <CheckCircle className="w-12 h-12 text-text-muted mb-4" />
              <p className="text-text-muted">{t('admin:monitor.error_list.no_errors')}</p>
            </div>
          ) : (
            <div className="flex-1 overflow-y-auto space-y-2 p-1">
              {errors.map(error => (
                <Card
                  key={error.execution_id}
                  className="p-3 bg-base hover:bg-hover transition-colors"
                >
                  <div className="flex items-start justify-between min-w-0 gap-4">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="font-mono text-sm text-text-primary">
                          #{error.execution_id}
                        </span>
                        {getStatusTag(error.status)}
                        {error.trigger_type && <Tag variant="default">{error.trigger_type}</Tag>}
                      </div>
                      <div className="flex items-center gap-3 text-xs text-text-muted">
                        <span>Subscription: {error.subscription_id}</span>
                        <span>User: {error.user_id}</span>
                        {error.task_id && <span>Task: {error.task_id}</span>}
                        <span>{formatDateTime(error.created_at)}</span>
                      </div>
                      {error.error_message && (
                        <p className="mt-2 text-sm text-error truncate" title={error.error_message}>
                          {error.error_message}
                        </p>
                      )}
                    </div>
                  </div>
                </Card>
              ))}
            </div>
          )}
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between">
            <p className="text-sm text-text-muted">
              {t('admin:monitor.error_list.pagination', {
                start: (page - 1) * limit + 1,
                end: Math.min(page * limit, total),
                total,
              })}
            </p>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage(p => Math.max(1, p - 1))}
                disabled={page === 1}
                className="h-8 px-3"
              >
                <ChevronLeftIcon className="w-4 h-4 mr-1" />
                {t('common:common.previous')}
              </Button>
              <span className="text-sm text-text-muted">
                {page} / {totalPages}
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                disabled={page === totalPages}
                className="h-8 px-3"
              >
                {t('common:common.next')}
                <ChevronRightIcon className="w-4 h-4 ml-1" />
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

export default BackgroundExecutionMonitorPanel
