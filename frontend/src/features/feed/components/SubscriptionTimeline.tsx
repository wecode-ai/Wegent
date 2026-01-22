'use client'

// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Subscription execution timeline component - Twitter-like social feed style.
 * Displays background executions as posts similar to social media feeds.
 */
import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  AlertCircle,
  Bot,
  CheckCircle2,
  ChevronRight,
  Clock,
  Copy,
  Loader2,
  MessageSquare,
  Plus,
  RefreshCw,
  Settings,
  Sparkles,
  StopCircle,
  Trash2,
  VolumeX,
  XCircle,
  Zap,
} from 'lucide-react'
import { toast } from 'sonner'
import { useTranslation } from '@/hooks/useTranslation'
import { Button } from '@/components/ui/button'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { EnhancedMarkdown } from '@/components/common/EnhancedMarkdown'
import { SmartImage } from '@/components/common/SmartUrlRenderer'
import { useTheme } from '@/features/theme/ThemeProvider'
import { useSubscriptionContext } from '../contexts/subscriptionContext'
import type { BackgroundExecution, BackgroundExecutionStatus } from '@/types/subscription'
import { parseUTCDate } from '@/lib/utils'
import { paths } from '@/config/paths'
import { SubscriptionConversationDialog } from './SubscriptionConversationDialog'

interface SubscriptionTimelineProps {
  onCreateSubscription?: () => void
}

const statusConfig: Record<
  BackgroundExecutionStatus,
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
  COMPLETED_SILENT: {
    icon: <VolumeX className="h-3 w-3" />,
    text: 'status_completed_silent',
    color: 'text-text-muted',
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

export function SubscriptionTimeline({ onCreateSubscription }: SubscriptionTimelineProps) {
  const { t } = useTranslation('feed')
  const { theme } = useTheme()
  const router = useRouter()
  const {
    executions,
    executionsLoading,
    executionsRefreshing,
    executionsTotal,
    loadMoreExecutions,
    refreshExecutions,
    cancelExecution,
    deleteExecution,
  } = useSubscriptionContext()

  // Dialog state for viewing conversation
  const [dialogTaskId, setDialogTaskId] = useState<number | null>(null)
  // Track which execution is currently being cancelled
  const [cancellingId, setCancellingId] = useState<number | null>(null)
  // Track which execution is currently being deleted
  const [deletingId, setDeletingId] = useState<number | null>(null)
  // Track which execution is pending delete confirmation
  const [pendingDeleteExec, setPendingDeleteExec] = useState<BackgroundExecution | null>(null)

  // Group executions by date for section headers
  const groupedExecutions = useMemo(() => {
    try {
      const groups: { label: string; items: BackgroundExecution[] }[] = []
      const today = new Date()
      today.setHours(0, 0, 0, 0)

      const yesterday = new Date(today)
      yesterday.setDate(yesterday.getDate() - 1)

      const weekAgo = new Date(today)
      weekAgo.setDate(weekAgo.getDate() - 7)

      const groupMap: Record<string, BackgroundExecution[]> = {}

      executions.forEach(exec => {
        // Parse as UTC time from backend
        const execDate = parseUTCDate(exec.created_at)
        if (!execDate || isNaN(execDate.getTime())) return

        // Create a local date for comparison (strip time)
        const execLocalDate = new Date(execDate)
        execLocalDate.setHours(0, 0, 0, 0)

        let groupKey: string
        if (execLocalDate.getTime() === today.getTime()) {
          groupKey = 'today'
        } else if (execLocalDate.getTime() === yesterday.getTime()) {
          groupKey = 'yesterday'
        } else if (execLocalDate >= weekAgo) {
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
    } catch {
      // Return empty groups on error to prevent crash
      return []
    }
  }, [executions, t])

  const formatRelativeTime = (dateStr: string) => {
    try {
      // Parse as UTC time from backend
      const date = parseUTCDate(dateStr)
      if (!date || isNaN(date.getTime())) return '-'

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
    } catch {
      return '-'
    }
  }

  const handleViewTask = (exec: BackgroundExecution) => {
    if (exec.task_id) {
      setDialogTaskId(exec.task_id)
    }
  }

  const handleCopyIds = async (exec: BackgroundExecution) => {
    const ids = [
      `Execution ID: ${exec.id}`,
      `Subscription ID: ${exec.subscription_id}`,
      exec.task_id ? `Task ID: ${exec.task_id}` : null,
    ]
      .filter(Boolean)
      .join('\n')

    try {
      await navigator.clipboard.writeText(ids)
      toast.success(t('feed.ids_copied'))
    } catch {
      toast.error(t('copy_failed'))
    }
  }

  const handleCancel = async (exec: BackgroundExecution) => {
    if (cancellingId) return // Prevent double-click
    try {
      setCancellingId(exec.id)
      await cancelExecution(exec.id)
      toast.success(t('cancel_success'))
    } catch {
      toast.error(t('cancel_failed'))
    } finally {
      setCancellingId(null)
    }
  }

  // Show delete confirmation dialog
  const handleDeleteClick = (exec: BackgroundExecution) => {
    setPendingDeleteExec(exec)
  }

  // Confirm delete action
  const handleConfirmDelete = async () => {
    if (!pendingDeleteExec || deletingId) return
    try {
      setDeletingId(pendingDeleteExec.id)
      await deleteExecution(pendingDeleteExec.id)
      toast.success(t('feed.delete_success'))
    } catch {
      toast.error(t('feed.delete_failed'))
    } finally {
      setDeletingId(null)
      setPendingDeleteExec(null)
    }
  }

  // Check if execution can be deleted
  // Only subscription owner can delete, and only for terminal states
  const canDelete = (exec: BackgroundExecution) => {
    const isTerminalState =
      exec.status === 'COMPLETED' ||
      exec.status === 'COMPLETED_SILENT' ||
      exec.status === 'FAILED' ||
      exec.status === 'CANCELLED'
    // Use can_delete from backend if available, otherwise fall back to terminal state check
    return exec.can_delete !== undefined ? exec.can_delete && isTerminalState : isTerminalState
  }

  // Track which execution's summary is expanded
  const [expandedSummaryId, setExpandedSummaryId] = useState<number | null>(null)

  const renderPost = (exec: BackgroundExecution, isLast: boolean) => {
    const status = statusConfig[exec.status]
    const subscriptionName =
      exec.subscription_display_name || exec.subscription_name || t('feed.unnamed_subscription')
    const isSummaryExpanded = expandedSummaryId === exec.id
    const isSilent = exec.status === 'COMPLETED_SILENT' || exec.is_silent

    return (
      <div key={exec.id} className={`relative ${isSilent ? 'opacity-60' : ''}`}>
        {/* Timeline connector line */}
        {!isLast && <div className="absolute left-5 top-12 bottom-0 w-px bg-border" />}

        <div className="flex gap-3 pb-6">
          {/* Avatar with status ring */}
          <div className="relative flex-shrink-0">
            <div
              className={`h-10 w-10 rounded-full bg-gradient-to-br from-primary/20 to-primary/5 flex items-center justify-center ring-[3px] ${
                exec.status === 'COMPLETED'
                  ? 'ring-green-500'
                  : exec.status === 'COMPLETED_SILENT'
                    ? 'ring-gray-400/50'
                    : exec.status === 'FAILED'
                      ? 'ring-red-500'
                      : exec.status === 'RUNNING'
                        ? 'ring-primary animate-pulse'
                        : exec.status === 'RETRYING'
                          ? 'ring-amber-500 animate-pulse'
                          : 'ring-gray-400/50'
              }`}
            >
              <Bot className="h-5 w-5 text-primary" />
            </div>
            {/* Silent indicator badge */}
            {isSilent && (
              <div className="absolute -bottom-0.5 -right-0.5 h-4 w-4 rounded-full bg-surface border border-border flex items-center justify-center">
                <VolumeX className="h-2.5 w-2.5 text-text-muted" />
              </div>
            )}
          </div>

          {/* Content */}
          <div className="flex-1 min-w-0">
            {/* Header */}
            <div className="flex items-center gap-2">
              <div className="flex items-baseline gap-2 flex-wrap flex-1 min-w-0">
                <span className="font-semibold text-text-primary text-[15px]">
                  {subscriptionName}
                </span>
                {exec.team_name && (
                  <span className="text-text-muted text-sm">@{exec.team_name}</span>
                )}
                <span className="text-text-muted text-sm">·</span>
                <span className="text-text-muted text-sm">
                  {formatRelativeTime(exec.created_at)}
                </span>
              </div>
              <button
                onClick={() => handleCopyIds(exec)}
                className="p-1.5 rounded-md text-text-muted hover:text-text-primary hover:bg-surface transition-colors"
                title={t('feed.copy_ids')}
              >
                <Copy className="h-3.5 w-3.5" />
              </button>
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

            {/* AI Summary card for collection tasks */}
            {exec.task_type === 'collection' && exec.result_summary && (
              <div className="rounded-2xl border border-border bg-surface/50 overflow-hidden">
                <div className="px-4 py-3">
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-1.5 text-xs font-medium text-primary">
                      <Bot className="h-3.5 w-3.5" />
                      {exec.team_name || t('feed.unnamed_subscription')}
                    </div>
                    <div className="flex items-center gap-3">
                      {exec.task_id && (
                        <button
                          onClick={() => handleViewTask(exec)}
                          className="inline-flex items-center gap-1 text-xs text-primary hover:text-primary/80 transition-colors"
                        >
                          <MessageSquare className="h-3 w-3" />
                          {t('feed.view_conversation')}
                        </button>
                      )}
                      {canDelete(exec) && (
                        <button
                          onClick={() => handleDeleteClick(exec)}
                          disabled={deletingId === exec.id}
                          className="inline-flex items-center gap-1 text-xs text-text-muted hover:text-red-500 transition-colors disabled:opacity-50"
                        >
                          {deletingId === exec.id ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            <Trash2 className="h-3 w-3" />
                          )}
                          {t('feed.delete_execution')}
                        </button>
                      )}
                    </div>
                  </div>
                  <div className="text-sm prose prose-sm max-w-none dark:prose-invert">
                    {isSummaryExpanded ? (
                      <EnhancedMarkdown
                        source={exec.result_summary}
                        theme={theme}
                        components={{
                          img: ({ src, alt }) => {
                            if (!src || typeof src !== 'string') return null
                            return <SmartImage src={src} alt={alt} />
                          },
                        }}
                      />
                    ) : (
                      <div className="line-clamp-6 overflow-hidden">
                        <EnhancedMarkdown
                          source={exec.result_summary}
                          theme={theme}
                          components={{
                            img: ({ src, alt }) => {
                              if (!src || typeof src !== 'string') return null
                              return <SmartImage src={src} alt={alt} />
                            },
                          }}
                        />
                      </div>
                    )}
                  </div>
                  {/* Action buttons area */}
                  <div className="mt-3 flex items-center gap-3">
                    {isSummaryExpanded ? (
                      <button
                        onClick={() => setExpandedSummaryId(null)}
                        className="text-xs text-primary hover:text-primary/80 transition-colors"
                      >
                        {t('feed.collapse')}
                      </button>
                    ) : (
                      <button
                        onClick={() => setExpandedSummaryId(exec.id)}
                        className="text-xs text-primary hover:text-primary/80 transition-colors"
                      >
                        {t('feed.expand')}
                      </button>
                    )}
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

            {/* Footer - Actions */}
            <div className="mt-3 flex items-center gap-3">
              {/* Cancel button for PENDING/RUNNING executions */}
              {(exec.status === 'PENDING' || exec.status === 'RUNNING') && (
                <button
                  onClick={() => handleCancel(exec)}
                  disabled={cancellingId === exec.id}
                  className="inline-flex items-center gap-1 text-sm text-red-500 hover:text-red-600 transition-colors disabled:opacity-50"
                >
                  {cancellingId === exec.id ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <StopCircle className="h-3.5 w-3.5" />
                  )}
                  {t('cancel_execution')}
                </button>
              )}
              {/* View conversation link - only show if not already in AI summary card */}
              {exec.task_id && !(exec.task_type === 'collection' && exec.result_summary) && (
                <button
                  onClick={() => handleViewTask(exec)}
                  className="inline-flex items-center gap-1 text-sm text-primary hover:text-primary/80 transition-colors"
                >
                  <MessageSquare className="h-3.5 w-3.5" />
                  {t('feed.view_conversation')}
                  <ChevronRight className="h-3.5 w-3.5" />
                </button>
              )}
              {/* Delete button for terminal state executions - only show if user can delete */}
              {canDelete(exec) && (
                <button
                  onClick={() => handleDeleteClick(exec)}
                  disabled={deletingId === exec.id}
                  className="inline-flex items-center gap-1 text-sm text-text-muted hover:text-red-500 transition-colors disabled:opacity-50"
                >
                  {deletingId === exec.id ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Trash2 className="h-3.5 w-3.5" />
                  )}
                  {t('feed.delete_execution')}
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="relative flex h-full flex-col">
      {/* Feed Content */}
      <div className="flex-1 overflow-y-auto">
        {/* Refresh indicator */}
        {executionsRefreshing && (
          <div className="flex items-center justify-center py-2 bg-surface/80 border-b border-border">
            <Loader2 className="h-4 w-4 animate-spin text-primary mr-2" />
            <span className="text-sm text-text-muted">{t('common:actions.loading')}</span>
          </div>
        )}
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
              <p className="text-sm max-w-xs mb-4">{t('feed.empty_hint')}</p>
              {onCreateSubscription && (
                <Button onClick={onCreateSubscription} className="mb-3">
                  <Plus className="h-4 w-4 mr-1.5" />
                  {t('create_subscription')}
                </Button>
              )}
              <p className="text-xs text-text-muted">
                {t('feed.empty_settings_hint')}{' '}
                <button
                  onClick={() => router.push(paths.feedSubscriptions.getHref())}
                  className="text-primary hover:underline inline-flex items-center gap-0.5"
                >
                  <Settings className="h-3 w-3" />
                  {t('feed.manage')}
                </button>
              </p>
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

      {/* Floating Refresh Button */}
      {executions.length > 0 && (
        <button
          onClick={() => refreshExecutions()}
          disabled={executionsRefreshing}
          className="absolute bottom-6 right-6 h-10 w-10 rounded-full bg-surface border border-border text-text-muted shadow-sm hover:text-text-primary hover:border-border-hover hover:shadow-md transition-all disabled:opacity-50 flex items-center justify-center cursor-pointer"
          title={t('feed.refresh')}
        >
          <RefreshCw className={`h-4 w-4 ${executionsRefreshing ? 'animate-spin' : ''}`} />
        </button>
      )}

      {/* Conversation Dialog */}
      <SubscriptionConversationDialog
        taskId={dialogTaskId}
        open={dialogTaskId !== null}
        onOpenChange={open => {
          if (!open) setDialogTaskId(null)
        }}
      />

      {/* Delete Confirmation Dialog */}
      <AlertDialog
        open={pendingDeleteExec !== null}
        onOpenChange={open => {
          if (!open) setPendingDeleteExec(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('feed.delete_confirm_title')}</AlertDialogTitle>
            <AlertDialogDescription>{t('feed.delete_confirm_message')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common:actions.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleConfirmDelete}
              className="bg-red-500 hover:bg-red-600"
            >
              {t('common:actions.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
