'use client'

// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Flow execution timeline component.
 */
import { useCallback, useMemo } from 'react'
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  Clock,
  Loader2,
  RefreshCw,
  XCircle,
} from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { useFlowContext } from '../contexts/flowContext'
import type { FlowExecution, FlowExecutionStatus } from '@/types/flow'

interface FlowTimelineProps {
  onViewExecution?: (execution: FlowExecution) => void
}

const statusIcons: Record<FlowExecutionStatus, React.ReactNode> = {
  PENDING: <Clock className="h-4 w-4 text-text-muted" />,
  RUNNING: <Loader2 className="h-4 w-4 animate-spin text-primary" />,
  COMPLETED: <CheckCircle2 className="h-4 w-4 text-green-500" />,
  FAILED: <XCircle className="h-4 w-4 text-destructive" />,
  RETRYING: <RefreshCw className="h-4 w-4 animate-spin text-amber-500" />,
  CANCELLED: <AlertCircle className="h-4 w-4 text-text-muted" />,
}

const statusColors: Record<FlowExecutionStatus, string> = {
  PENDING: 'bg-gray-100 text-gray-700',
  RUNNING: 'bg-blue-100 text-blue-700',
  COMPLETED: 'bg-green-100 text-green-700',
  FAILED: 'bg-red-100 text-red-700',
  RETRYING: 'bg-amber-100 text-amber-700',
  CANCELLED: 'bg-gray-100 text-gray-600',
}

export function FlowTimeline({ onViewExecution }: FlowTimelineProps) {
  const { t } = useTranslation('flow')
  const {
    executions,
    executionsLoading,
    executionsTotal,
    refreshExecutions,
    loadMoreExecutions,
  } = useFlowContext()

  // Group executions by date
  const groupedExecutions = useMemo(() => {
    const groups: Record<string, FlowExecution[]> = {}
    const today = new Date()
    today.setHours(0, 0, 0, 0)

    const yesterday = new Date(today)
    yesterday.setDate(yesterday.getDate() - 1)

    const weekAgo = new Date(today)
    weekAgo.setDate(weekAgo.getDate() - 7)

    executions.forEach(exec => {
      const execDate = new Date(exec.created_at)
      execDate.setHours(0, 0, 0, 0)

      let groupKey: string
      if (execDate.getTime() === today.getTime()) {
        groupKey = 'today'
      } else if (execDate.getTime() === yesterday.getTime()) {
        groupKey = 'yesterday'
      } else if (execDate >= weekAgo) {
        groupKey = 'this_week'
      } else {
        groupKey = 'earlier'
      }

      if (!groups[groupKey]) {
        groups[groupKey] = []
      }
      groups[groupKey].push(exec)
    })

    return groups
  }, [executions])

  const formatTime = (dateStr: string) => {
    const date = new Date(dateStr)
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }

  const formatDuration = (start?: string, end?: string) => {
    if (!start || !end) return '-'
    const startTime = new Date(start).getTime()
    const endTime = new Date(end).getTime()
    const duration = Math.round((endTime - startTime) / 1000)

    if (duration < 60) return `${duration}s`
    if (duration < 3600) return `${Math.floor(duration / 60)}m ${duration % 60}s`
    return `${Math.floor(duration / 3600)}h ${Math.floor((duration % 3600) / 60)}m`
  }

  const groupLabels: Record<string, string> = {
    today: t('common:tasks.today'),
    yesterday: t('yesterday'),
    this_week: t('common:tasks.this_week'),
    earlier: t('common:tasks.earlier'),
  }

  const renderExecution = (exec: FlowExecution) => (
    <Collapsible key={exec.id} className="border-b border-border last:border-0">
      <CollapsibleTrigger asChild>
        <div className="flex cursor-pointer items-center gap-3 px-4 py-3 hover:bg-surface/50">
          {/* Status Icon */}
          <div className="flex-shrink-0">
            {statusIcons[exec.status]}
          </div>

          {/* Time */}
          <div className="w-16 flex-shrink-0 text-sm text-text-muted">
            {formatTime(exec.created_at)}
          </div>

          {/* Content */}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate font-medium">
                {exec.flow_display_name || exec.flow_name || `Flow #${exec.flow_id}`}
              </span>
              <Badge
                className={`text-xs ${statusColors[exec.status]}`}
                variant="secondary"
              >
                {t(`status_${exec.status.toLowerCase()}`)}
              </Badge>
            </div>
            <div className="flex items-center gap-2 text-xs text-text-muted">
              {exec.team_name && <span>{exec.team_name}</span>}
              <span>·</span>
              <span>{exec.trigger_reason || exec.trigger_type}</span>
              {exec.completed_at && (
                <>
                  <span>·</span>
                  <span>
                    {t('duration')}: {formatDuration(exec.started_at, exec.completed_at)}
                  </span>
                </>
              )}
            </div>
          </div>

          {/* Expand */}
          <ChevronDown className="h-4 w-4 text-text-muted transition-transform data-[state=open]:rotate-180" />
        </div>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="border-t border-border bg-surface/30 px-4 py-3">
          {/* Result summary for collection tasks */}
          {exec.task_type === 'collection' && exec.result_summary && (
            <div className="mb-3 rounded-lg bg-base p-3">
              <div className="text-xs font-medium text-text-muted mb-1">
                {t('result_summary')}
              </div>
              <div className="text-sm whitespace-pre-wrap">
                {exec.result_summary}
              </div>
            </div>
          )}

          {/* Error message */}
          {exec.error_message && (
            <div className="mb-3 rounded-lg bg-red-50 p-3 text-sm text-red-700">
              {exec.error_message}
            </div>
          )}

          {/* Prompt */}
          <div className="mb-3">
            <div className="text-xs font-medium text-text-muted mb-1">
              {t('prompt_used')}
            </div>
            <div className="rounded-lg bg-base p-3 text-sm max-h-32 overflow-y-auto">
              {exec.prompt}
            </div>
          </div>

          {/* Actions */}
          <div className="flex justify-end gap-2">
            {exec.task_id && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => onViewExecution?.(exec)}
              >
                {t('view_task')}
              </Button>
            )}
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  )

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <h2 className="text-lg font-semibold">{t('execution_timeline')}</h2>
        <Button
          variant="ghost"
          size="sm"
          onClick={refreshExecutions}
          disabled={executionsLoading}
        >
          <RefreshCw
            className={`mr-1.5 h-4 w-4 ${executionsLoading ? 'animate-spin' : ''}`}
          />
          {t('common:actions.refresh')}
        </Button>
      </div>

      {/* Timeline */}
      <div className="flex-1 overflow-y-auto">
        {executionsLoading && executions.length === 0 ? (
          <div className="flex h-40 items-center justify-center text-text-muted">
            {t('common:actions.loading')}
          </div>
        ) : executions.length === 0 ? (
          <div className="flex h-40 flex-col items-center justify-center gap-2 text-text-muted">
            <p>{t('no_executions')}</p>
            <p className="text-xs">{t('no_executions_hint')}</p>
          </div>
        ) : (
          <div>
            {['today', 'yesterday', 'this_week', 'earlier'].map(
              group =>
                groupedExecutions[group]?.length > 0 && (
                  <div key={group}>
                    <div className="sticky top-0 bg-base px-4 py-2 text-xs font-medium text-text-muted">
                      {groupLabels[group]}
                    </div>
                    {groupedExecutions[group].map(renderExecution)}
                  </div>
                )
            )}

            {/* Load more */}
            {executions.length < executionsTotal && (
              <div className="flex justify-center py-4">
                <Button
                  variant="ghost"
                  onClick={loadMoreExecutions}
                  disabled={executionsLoading}
                >
                  {executionsLoading
                    ? t('common:actions.loading')
                    : t('common:tasks.load_more')}
                </Button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
