'use client'

// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Discover subscription execution history dialog component.
 * Displays the recent 5 execution history records for a discovered subscription.
 */
import { useEffect, useState, useCallback } from 'react'
import {
  AlertCircle,
  CheckCircle2,
  Clock,
  History,
  Loader2,
  MessageSquare,
  RefreshCw,
  VolumeX,
  XCircle,
} from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { useTheme } from '@/features/theme/ThemeProvider'
import { subscriptionApis } from '@/apis/subscription'
import type { BackgroundExecution, BackgroundExecutionStatus } from '@/types/subscription'
import { cn } from '@/lib/utils'
import { parseUTCDate } from '@/lib/utils'
import { SubscriptionConversationDialog } from './SubscriptionConversationDialog'
import { EnhancedMarkdown } from '@/components/common/EnhancedMarkdown'

/**
 * Generic subscription info interface for the history dialog.
 * This allows the dialog to be used with different subscription response types.
 */
export interface HistoryDialogSubscription {
  id: number
  display_name: string
}

interface DiscoverHistoryDialogProps {
  subscription: HistoryDialogSubscription | null
  open: boolean
  onOpenChange: (open: boolean) => void
}

// Status configuration for execution history display
const statusConfig: Record<
  BackgroundExecutionStatus,
  { icon: React.ReactNode; text: string; color: string; bgColor: string }
> = {
  PENDING: {
    icon: <Clock className="h-4 w-4" />,
    text: 'status_pending',
    color: 'text-text-muted',
    bgColor: 'bg-gray-100 dark:bg-gray-800',
  },
  RUNNING: {
    icon: <Loader2 className="h-4 w-4 animate-spin" />,
    text: 'status_running',
    color: 'text-primary',
    bgColor: 'bg-primary/10',
  },
  COMPLETED: {
    icon: <CheckCircle2 className="h-4 w-4" />,
    text: 'status_completed',
    color: 'text-green-600',
    bgColor: 'bg-green-50 dark:bg-green-900/20',
  },
  FAILED: {
    icon: <XCircle className="h-4 w-4" />,
    text: 'status_failed',
    color: 'text-red-500',
    bgColor: 'bg-red-50 dark:bg-red-900/20',
  },
  RETRYING: {
    icon: <RefreshCw className="h-4 w-4 animate-spin" />,
    text: 'status_retrying',
    color: 'text-amber-500',
    bgColor: 'bg-amber-50 dark:bg-amber-900/20',
  },
  CANCELLED: {
    icon: <AlertCircle className="h-4 w-4" />,
    text: 'status_cancelled',
    color: 'text-text-muted',
    bgColor: 'bg-gray-100 dark:bg-gray-800',
  },
  COMPLETED_SILENT: {
    icon: <VolumeX className="h-4 w-4" />,
    text: 'status_completed_silent',
    color: 'text-text-muted',
    bgColor: 'bg-gray-100 dark:bg-gray-800',
  },
}

export function DiscoverHistoryDialog({
  subscription,
  open,
  onOpenChange,
}: DiscoverHistoryDialogProps) {
  const { t } = useTranslation('feed')
  const { theme } = useTheme()
  const [executions, setExecutions] = useState<BackgroundExecution[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Dialog state for viewing conversation
  const [dialogTaskId, setDialogTaskId] = useState<number | null>(null)

  // Format relative time for execution history
  const formatRelativeTime = useCallback(
    (dateStr: string) => {
      try {
        const date = parseUTCDate(dateStr)
        if (!date || isNaN(date.getTime())) return '-'

        const now = new Date()
        const diffMs = now.getTime() - date.getTime()
        const diffMins = Math.floor(diffMs / 60000)
        const diffHours = Math.floor(diffMs / 3600000)
        const diffDays = Math.floor(diffMs / 86400000)

        if (diffMins < 1) return t('common:time.just_now')
        if (diffMins < 60) return t('common:time.minutes_ago', { count: diffMins })
        if (diffHours < 24) return t('common:time.hours_ago', { count: diffHours })
        return t('common:time.days_ago', { count: diffDays })
      } catch {
        return '-'
      }
    },
    [t]
  )

  // Format full datetime
  const formatFullDateTime = (dateStr: string) => {
    try {
      const date = parseUTCDate(dateStr)
      if (!date || isNaN(date.getTime())) return '-'
      return date.toLocaleString()
    } catch {
      return '-'
    }
  }

  // Fetch execution history when dialog opens
  useEffect(() => {
    if (open && subscription) {
      setLoading(true)
      setError(null)
      subscriptionApis
        .getExecutions({ page: 1, limit: 5 }, subscription.id)
        .then(response => {
          setExecutions(response.items)
        })
        .catch((err: Error) => {
          console.error('[DiscoverHistoryDialog] Failed to load executions:', err)
          setError(err.message || t('common:errors.unknown'))
        })
        .finally(() => {
          setLoading(false)
        })
    }
  }, [open, subscription, t])

  // Reset state when dialog closes
  useEffect(() => {
    if (!open) {
      setExecutions([])
      setError(null)
    }
  }, [open])

  // Handle view conversation
  const handleViewConversation = (taskId: number) => {
    setDialogTaskId(taskId)
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-2xl max-h-[80vh] flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <History className="h-5 w-5" />
              <span className="truncate">{t('recent_executions')}</span>
            </DialogTitle>
            <DialogDescription>
              {subscription?.display_name && (
                <span className="text-text-muted">{subscription.display_name}</span>
              )}
            </DialogDescription>
          </DialogHeader>

          {/* Content area */}
          <div className="flex-1 overflow-y-auto py-4 min-h-[300px]">
            {loading ? (
              <div className="flex h-full items-center justify-center">
                <div className="flex flex-col items-center gap-3 text-text-muted">
                  <Loader2 className="h-8 w-8 animate-spin text-primary" />
                  <span>{t('common:actions.loading')}</span>
                </div>
              </div>
            ) : error ? (
              <div className="flex h-full flex-col items-center justify-center gap-3 text-text-muted">
                <AlertCircle className="h-10 w-10 text-red-500" />
                <p className="text-sm text-red-600">{error}</p>
                <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
                  {t('common:actions.close')}
                </Button>
              </div>
            ) : executions.length === 0 ? (
              <div className="flex h-full items-center justify-center text-text-muted">
                <div className="flex flex-col items-center gap-2">
                  <History className="h-10 w-10 opacity-50" />
                  <p>{t('no_executions')}</p>
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                {executions.map(exec => {
                  const status = statusConfig[exec.status]
                  return (
                    <div
                      key={exec.id}
                      className={cn(
                        'rounded-lg border border-border p-4 transition-colors hover:bg-surface/50',
                        status.bgColor
                      )}
                    >
                      {/* Header row */}
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-2">
                          <div className={cn('flex-shrink-0', status.color)}>{status.icon}</div>
                          <span className={cn('font-medium text-sm', status.color)}>
                            {t(status.text)}
                          </span>
                        </div>
                        <span className="text-xs text-text-muted">
                          {formatRelativeTime(exec.created_at)}
                        </span>
                      </div>

                      {/* Details */}
                      <div className="space-y-2 text-sm">
                        {/* Trigger reason */}
                        {exec.trigger_reason && (
                          <div className="text-text-secondary">
                            <span className="text-text-muted">{t('trigger_reason')}: </span>
                            {exec.trigger_reason}
                          </div>
                        )}

                        {/* Full timestamp */}
                        <div className="text-text-muted text-xs">
                          {formatFullDateTime(exec.created_at)}
                        </div>

                        {/* Result summary with markdown */}
                        {exec.result_summary && (
                          <div className="bg-base/50 rounded p-2 text-xs prose prose-xs max-w-none dark:prose-invert">
                            <EnhancedMarkdown source={exec.result_summary} theme={theme} />
                          </div>
                        )}

                        {/* Error message */}
                        {exec.error_message && (
                          <div className="text-red-500 bg-red-50 dark:bg-red-900/10 rounded p-2 text-xs">
                            {exec.error_message}
                          </div>
                        )}
                      </div>

                      {/* View conversation button */}
                      {exec.task_id && (
                        <div className="mt-3 pt-3 border-t border-border/50">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => handleViewConversation(exec.task_id!)}
                            className="gap-1.5"
                          >
                            <MessageSquare className="h-3.5 w-3.5" />
                            {t('feed.view_conversation')}
                          </Button>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="flex justify-end pt-4 border-t border-border">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              {t('common:actions.close')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Conversation Dialog */}
      <SubscriptionConversationDialog
        taskId={dialogTaskId}
        open={dialogTaskId !== null}
        onOpenChange={open => {
          if (!open) setDialogTaskId(null)
        }}
      />
    </>
  )
}
