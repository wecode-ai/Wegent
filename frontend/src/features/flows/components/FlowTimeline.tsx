'use client'

// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Flow execution timeline component - Twitter-like social feed style.
 * Displays flow executions as posts similar to social media feeds.
 */
import { useMemo } from 'react'
import { useRouter } from 'next/navigation'
import {
  AlertCircle,
  Bot,
  CheckCircle2,
  ChevronRight,
  Clock,
  Loader2,
  MessageSquare,
  RefreshCw,
  Sparkles,
  XCircle,
  Zap,
} from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { Button } from '@/components/ui/button'
import { useFlowContext } from '../contexts/flowContext'
import type { FlowExecution, FlowExecutionStatus } from '@/types/flow'

const statusConfig: Record<
  FlowExecutionStatus,
  { icon: React.ReactNode; text: string; color: string }
> = {
  PENDING: {
    icon: <Clock className="h-3 w-3" />,
    text: 'status_pending',
    color: 'text-text-muted',
  },
  RUNNING: {
    icon: <Loader2 className="h-3 w-3 animate-spin" />,
    text: 'status_running',
    color: 'text-primary',
  },
  COMPLETED: {
    icon: <CheckCircle2 className="h-3 w-3" />,
    text: 'status_completed',
    color: 'text-green-600',
  },
  FAILED: {
    icon: <XCircle className="h-3 w-3" />,
    text: 'status_failed',
    color: 'text-red-500',
  },
  RETRYING: {
    icon: <RefreshCw className="h-3 w-3 animate-spin" />,
    text: 'status_retrying',
    color: 'text-amber-500',
  },
  CANCELLED: {
    icon: <AlertCircle className="h-3 w-3" />,
    text: 'status_cancelled',
    color: 'text-text-muted',
  },
}

export function FlowTimeline() {
  const { t } = useTranslation('flow')
  const router = useRouter()
  const { executions, executionsLoading, executionsTotal, loadMoreExecutions } = useFlowContext()

  // Group executions by date for section headers
  const groupedExecutions = useMemo(() => {
    const groups: { label: string; items: FlowExecution[] }[] = []
    const today = new Date()
    today.setHours(0, 0, 0, 0)

    const yesterday = new Date(today)
    yesterday.setDate(yesterday.getDate() - 1)

    const weekAgo = new Date(today)
    weekAgo.setDate(weekAgo.getDate() - 7)

    const groupMap: Record<string, FlowExecution[]> = {}

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

      if (!groupMap[groupKey]) {
        groupMap[groupKey] = []
      }
      groupMap[groupKey].push(exec)
    })

    const order = ['today', 'yesterday', 'this_week', 'earlier']
    const labels: Record<string, string> = {
      today: t('common:tasks.today'),
      yesterday: t('yesterday'),
      this_week: t('common:tasks.this_week'),
      earlier: t('common:tasks.earlier'),
    }

    order.forEach(key => {
      if (groupMap[key]?.length > 0) {
        groups.push({ label: labels[key], items: groupMap[key] })
      }
    })

    return groups
  }, [executions, t])

  const formatRelativeTime = (dateStr: string) => {
    const date = new Date(dateStr)
    const now = new Date()
    const diffMs = now.getTime() - date.getTime()
    const diffMins = Math.floor(diffMs / 60000)
    const diffHours = Math.floor(diffMs / 3600000)
    const diffDays = Math.floor(diffMs / 86400000)

    if (diffMins < 1) return t('feed.just_now')
    if (diffMins < 60) return t('feed.minutes_ago', { count: diffMins })
    if (diffHours < 24) return t('feed.hours_ago', { count: diffHours })
    if (diffDays < 7) return t('feed.days_ago', { count: diffDays })
    return date.toLocaleDateString()
  }

  const handleViewTask = (exec: FlowExecution) => {
    if (exec.task_id) {
      router.push(`/chat?taskId=${exec.task_id}`)
    }
  }

  const renderPost = (exec: FlowExecution, isLast: boolean) => {
    const status = statusConfig[exec.status]
    const flowName = exec.flow_display_name || exec.flow_name || t('feed.unnamed_flow')

    return (
      <div key={exec.id} className="relative">
        {/* Timeline connector line */}
        {!isLast && <div className="absolute left-5 top-12 bottom-0 w-px bg-border" />}

        <div className="flex gap-3 pb-6">
          {/* Avatar */}
          <div className="relative flex-shrink-0">
            <div className="h-10 w-10 rounded-full bg-gradient-to-br from-primary/20 to-primary/5 flex items-center justify-center ring-4 ring-white">
              <Bot className="h-5 w-5 text-primary" />
            </div>
            {/* Status indicator dot */}
            <div
              className={`absolute -bottom-0.5 -right-0.5 h-3.5 w-3.5 rounded-full border-2 border-white flex items-center justify-center ${
                exec.status === 'COMPLETED'
                  ? 'bg-green-500'
                  : exec.status === 'FAILED'
                    ? 'bg-red-500'
                    : exec.status === 'RUNNING'
                      ? 'bg-primary'
                      : 'bg-gray-400'
              }`}
            >
              {exec.status === 'RUNNING' && (
                <div className="h-1.5 w-1.5 rounded-full bg-white animate-pulse" />
              )}
            </div>
          </div>

          {/* Content */}
          <div className="flex-1 min-w-0">
            {/* Header */}
            <div className="flex items-baseline gap-2 flex-wrap">
              <span className="font-semibold text-text-primary text-[15px]">{flowName}</span>
              {exec.team_name && <span className="text-text-muted text-sm">@{exec.team_name}</span>}
              <span className="text-text-muted text-sm">·</span>
              <span className="text-text-muted text-sm">{formatRelativeTime(exec.created_at)}</span>
            </div>

            {/* Action description */}
            <div className="flex items-center gap-1.5 text-sm text-text-muted mt-0.5 mb-2">
              <span className={status.color}>{status.icon}</span>
              <span>{t(status.text)}</span>
              {exec.trigger_reason && (
                <>
                  <span>·</span>
                  <span className="flex items-center gap-1">
                    <Zap className="h-3 w-3" />
                    {exec.trigger_reason}
                  </span>
                </>
              )}
            </div>

            {/* Main content - the prompt */}
            <div className="text-[15px] text-text-primary leading-relaxed whitespace-pre-wrap">
              {exec.prompt}
            </div>

            {/* AI Summary card for collection tasks */}
            {exec.task_type === 'collection' && exec.result_summary && (
              <div className="mt-3 rounded-2xl border border-border bg-surface/50 overflow-hidden">
                <div className="px-4 py-3">
                  <div className="flex items-center gap-1.5 text-xs font-medium text-primary mb-2">
                    <Sparkles className="h-3.5 w-3.5" />
                    {t('feed.ai_summary')}
                  </div>
                  <div className="text-sm text-text-primary whitespace-pre-wrap line-clamp-6">
                    {exec.result_summary}
                  </div>
                </div>
              </div>
            )}

            {/* Error message */}
            {exec.error_message && (
              <div className="mt-3 rounded-2xl border border-red-200 bg-red-50 overflow-hidden">
                <div className="px-4 py-3">
                  <div className="flex items-center gap-1.5 text-xs font-medium text-red-600 mb-1">
                    <AlertCircle className="h-3.5 w-3.5" />
                    {t('feed.error_occurred')}
                  </div>
                  <div className="text-sm text-red-700 line-clamp-3">{exec.error_message}</div>
                </div>
              </div>
            )}

            {/* Footer - View details link */}
            {exec.task_id && (
              <button
                onClick={() => handleViewTask(exec)}
                className="mt-3 inline-flex items-center gap-1 text-sm text-primary hover:text-primary/80 transition-colors"
              >
                <MessageSquare className="h-3.5 w-3.5" />
                {t('feed.view_conversation')}
                <ChevronRight className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      {/* Feed Content */}
      <div className="flex-1 overflow-y-auto">
        {executionsLoading && executions.length === 0 ? (
          <div className="flex h-60 items-center justify-center">
            <div className="flex flex-col items-center gap-3 text-text-muted">
              <Loader2 className="h-8 w-8 animate-spin text-primary" />
              <span>{t('common:actions.loading')}</span>
            </div>
          </div>
        ) : executions.length === 0 ? (
          <div className="flex h-60 flex-col items-center justify-center gap-4 text-text-muted px-4">
            <div className="h-20 w-20 rounded-full bg-surface flex items-center justify-center">
              <Sparkles className="h-10 w-10 text-text-muted/30" />
            </div>
            <div className="text-center">
              <p className="font-medium text-text-primary text-lg mb-1">{t('feed.empty_title')}</p>
              <p className="text-sm max-w-xs">{t('feed.empty_hint')}</p>
            </div>
          </div>
        ) : (
          <div className="px-4 py-4">
            {groupedExecutions.map(group => (
              <div key={group.label} className="mb-6">
                {/* Date Section Header */}
                <div className="flex items-center gap-3 mb-4 pl-[52px]">
                  <div className="text-xs font-medium text-text-muted">{group.label}</div>
                  <div className="flex-1 h-px bg-border" />
                </div>
                {/* Posts */}
                <div>
                  {group.items.map((exec, index) =>
                    renderPost(exec, index === group.items.length - 1)
                  )}
                </div>
              </div>
            ))}

            {/* Load more */}
            {executions.length < executionsTotal && (
              <div className="flex justify-center py-4 pl-[52px]">
                <Button
                  variant="outline"
                  onClick={loadMoreExecutions}
                  disabled={executionsLoading}
                  className="rounded-full px-6"
                >
                  {executionsLoading ? (
                    <>
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      {t('common:actions.loading')}
                    </>
                  ) : (
                    t('feed.load_more')
                  )}
                </Button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
