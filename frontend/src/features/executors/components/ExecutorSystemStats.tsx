// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useTranslation } from '@/hooks/useTranslation'
import { SystemStats, TaskStats } from '@/apis/devices'
import { HardDrive, Cpu, Database, Clock, FolderOpen, FileText, ListTodo } from 'lucide-react'

interface ExecutorSystemStatsProps {
  systemStats?: SystemStats
  taskStats?: TaskStats
  compact?: boolean
}

/**
 * Format uptime seconds to human readable string.
 */
function formatUptime(
  seconds: number,
  dayLabel: string,
  hourLabel: string,
  minLabel: string
): string {
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)

  if (days > 0) {
    return `${days} ${dayLabel} ${hours} ${hourLabel}`
  }
  if (hours > 0) {
    return `${hours} ${hourLabel} ${minutes} ${minLabel}`
  }
  return `${minutes} ${minLabel}`
}

/**
 * Format bytes to human readable size.
 */
function formatSize(mb: number): string {
  if (mb >= 1024) {
    return `${(mb / 1024).toFixed(1)} GB`
  }
  return `${mb.toFixed(0)} MB`
}

/**
 * Component displaying executor system statistics.
 */
export function ExecutorSystemStats({
  systemStats,
  taskStats,
  compact = false,
}: ExecutorSystemStatsProps) {
  const { t } = useTranslation('devices')

  if (!systemStats && !taskStats) {
    return null
  }

  if (compact) {
    return (
      <div className="flex flex-wrap gap-2 text-xs text-text-muted">
        {systemStats && (
          <>
            <span className="flex items-center gap-1">
              <Cpu className="h-3 w-3" />
              {systemStats.cpu_percent.toFixed(0)}%
            </span>
            <span className="flex items-center gap-1">
              <Database className="h-3 w-3" />
              {systemStats.memory_percent.toFixed(0)}%
            </span>
            <span className="flex items-center gap-1">
              <HardDrive className="h-3 w-3" />
              {systemStats.disk_percent.toFixed(0)}%
            </span>
          </>
        )}
        {taskStats && (
          <span className="flex items-center gap-1">
            <ListTodo className="h-3 w-3" />
            {taskStats.running_tasks}/{taskStats.queued_tasks}
          </span>
        )}
      </div>
    )
  }

  return (
    <div className="space-y-3 text-sm">
      {/* Uptime */}
      {systemStats && systemStats.uptime_seconds > 0 && (
        <div className="flex items-center gap-2">
          <Clock className="h-4 w-4 text-text-muted" />
          <span className="text-text-muted">{t('uptime')}:</span>
          <span>
            {formatUptime(systemStats.uptime_seconds, t('days'), t('hours'), t('minutes'))}
          </span>
        </div>
      )}

      {/* System Resources */}
      {systemStats && (
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-text-muted">
            <span className="font-medium">{t('system_resources')}</span>
          </div>
          <div className="grid grid-cols-3 gap-4 pl-2">
            <div>
              <div className="flex items-center gap-1 text-text-muted">
                <Database className="h-3 w-3" />
                {t('memory')}
              </div>
              <div className="text-xs">
                {formatSize(systemStats.memory_used_mb)} / {formatSize(systemStats.memory_total_mb)}
                <span className="ml-1 text-text-muted">
                  ({systemStats.memory_percent.toFixed(1)}%)
                </span>
              </div>
            </div>
            <div>
              <div className="flex items-center gap-1 text-text-muted">
                <HardDrive className="h-3 w-3" />
                {t('disk')}
              </div>
              <div className="text-xs">
                {systemStats.disk_used_gb.toFixed(1)} / {systemStats.disk_total_gb.toFixed(1)} GB
                <span className="ml-1 text-text-muted">
                  ({systemStats.disk_percent.toFixed(1)}%)
                </span>
              </div>
            </div>
            <div>
              <div className="flex items-center gap-1 text-text-muted">
                <Cpu className="h-3 w-3" />
                {t('cpu')}
              </div>
              <div className="text-xs">{systemStats.cpu_percent.toFixed(1)}%</div>
            </div>
          </div>
        </div>
      )}

      {/* Storage */}
      {systemStats && (
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-text-muted">
            <span className="font-medium">{t('storage')}</span>
          </div>
          <div className="grid grid-cols-2 gap-4 pl-2">
            <div>
              <div className="flex items-center gap-1 text-text-muted">
                <FolderOpen className="h-3 w-3" />
                {t('workspace')}
              </div>
              <div className="text-xs">
                {formatSize(systemStats.workspace_size_mb)} ({systemStats.workspace_count} tasks)
              </div>
            </div>
            <div>
              <div className="flex items-center gap-1 text-text-muted">
                <FileText className="h-3 w-3" />
                {t('logs')}
              </div>
              <div className="text-xs">{formatSize(systemStats.log_size_mb)}</div>
            </div>
          </div>
        </div>
      )}

      {/* Task Stats */}
      {taskStats && (
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-text-muted">
            <span className="font-medium">{t('tasks')}</span>
          </div>
          <div className="grid grid-cols-3 gap-4 pl-2">
            <div>
              <div className="text-text-muted">{t('running')}</div>
              <div className="text-lg font-semibold">{taskStats.running_tasks}</div>
            </div>
            <div>
              <div className="text-text-muted">{t('queued')}</div>
              <div className="text-lg font-semibold">{taskStats.queued_tasks}</div>
            </div>
            <div>
              <div className="text-text-muted">{t('today')}</div>
              <div className="text-lg font-semibold">{taskStats.completed_today}</div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
