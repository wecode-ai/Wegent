'use client'

// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Subscription configuration list component.
 */
import { useCallback, useState } from 'react'
import {
  AlertCircle,
  CalendarClock,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clock,
  Copy,
  Edit,
  Hash,
  History,
  Key,
  Loader2,
  MessageSquare,
  MoreHorizontal,
  Play,
  Plus,
  RefreshCw,
  Timer,
  Trash2,
  Webhook,
  XCircle,
} from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown'
import { Switch } from '@/components/ui/switch'
import { Badge } from '@/components/ui/badge'
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
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useIsMobile } from '@/features/layout/hooks/useMediaQuery'
import { useSubscriptionContext } from '../contexts/subscriptionContext'
import { subscriptionApis } from '@/apis/subscription'
import type {
  Subscription,
  SubscriptionTriggerType,
  BackgroundExecution,
  BackgroundExecutionStatus,
} from '@/types/subscription'
import { toast } from 'sonner'
import { formatUTCDate, parseUTCDate } from '@/lib/utils'
import { SubscriptionConversationDialog } from './SubscriptionConversationDialog'

interface SubscriptionListProps {
  onCreateSubscription: () => void
  onEditSubscription: (subscription: Subscription) => void
}

const triggerTypeIcons: Record<SubscriptionTriggerType, React.ReactNode> = {
  cron: <CalendarClock className="h-4 w-4" />,
  interval: <Timer className="h-4 w-4" />,
  one_time: <Clock className="h-4 w-4" />,
  event: <Webhook className="h-4 w-4" />,
}

// Status configuration for execution history display
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

export function SubscriptionList({
  onCreateSubscription,
  onEditSubscription,
}: SubscriptionListProps) {
  const { t } = useTranslation('feed')
  const isMobile = useIsMobile()
  const {
    subscriptions,
    subscriptionsLoading,
    subscriptionsTotal,
    refreshSubscriptions,
    loadMoreSubscriptions,
    refreshExecutions,
  } = useSubscriptionContext()

  const [deleteConfirmSubscription, setDeleteConfirmSubscription] = useState<Subscription | null>(
    null
  )
  const [actionLoading, setActionLoading] = useState<number | null>(null)

  // State for expanded subscription execution history
  const [expandedSubscriptionId, setExpandedSubscriptionId] = useState<number | null>(null)
  const [executionHistory, setExecutionHistory] = useState<Record<number, BackgroundExecution[]>>(
    {}
  )
  const [executionHistoryLoading, setExecutionHistoryLoading] = useState<number | null>(null)

  // Dialog state for viewing conversation
  const [dialogTaskId, setDialogTaskId] = useState<number | null>(null)

  // Load execution history for a subscription
  const loadExecutionHistory = useCallback(
    async (subscriptionId: number) => {
      if (executionHistory[subscriptionId]) {
        // Already loaded, just toggle
        setExpandedSubscriptionId(prev => (prev === subscriptionId ? null : subscriptionId))
        return
      }

      setExecutionHistoryLoading(subscriptionId)
      try {
        const response = await subscriptionApis.getExecutions({ page: 1, limit: 5 }, subscriptionId)
        setExecutionHistory(prev => ({
          ...prev,
          [subscriptionId]: response.items,
        }))
        setExpandedSubscriptionId(subscriptionId)
      } catch (error) {
        console.error('Failed to load execution history:', error)
        toast.error(t('load_history_failed'))
      } finally {
        setExecutionHistoryLoading(null)
      }
    },
    [executionHistory, t]
  )

  // Format relative time for execution history
  const formatRelativeTime = (dateStr: string) => {
    try {
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

  // Handle view conversation
  const handleViewConversation = (taskId: number) => {
    setDialogTaskId(taskId)
  }

  // Refresh execution history when trigger is successful
  const handleTriggerWithRefresh = useCallback(
    async (subscription: Subscription) => {
      setActionLoading(subscription.id)
      try {
        await subscriptionApis.triggerSubscription(subscription.id)
        toast.success(t('trigger_success'))
        // Refresh executions to show the new execution in timeline
        refreshExecutions()
        // Clear cached execution history for this subscription so it reloads
        setExecutionHistory(prev => {
          const newHistory = { ...prev }
          delete newHistory[subscription.id]
          return newHistory
        })
        // If this subscription is expanded, reload its history
        if (expandedSubscriptionId === subscription.id) {
          setExpandedSubscriptionId(null)
          setTimeout(() => loadExecutionHistory(subscription.id), 500)
        }
      } catch (error) {
        console.error('Failed to trigger subscription:', error)
        toast.error(t('trigger_failed'))
      } finally {
        setActionLoading(null)
      }
    },
    [t, refreshExecutions, expandedSubscriptionId, loadExecutionHistory]
  )

  const handleToggle = useCallback(
    async (subscription: Subscription, enabled: boolean) => {
      setActionLoading(subscription.id)
      try {
        await subscriptionApis.toggleSubscription(subscription.id, enabled)
        await refreshSubscriptions()
        toast.success(enabled ? t('enabled_success') : t('disabled_success'))
      } catch (error) {
        console.error('Failed to toggle subscription:', error)
        toast.error(t('toggle_failed'))
      } finally {
        setActionLoading(null)
      }
    },
    [refreshSubscriptions, t]
  )

  const handleDelete = useCallback(async () => {
    if (!deleteConfirmSubscription) return

    setActionLoading(deleteConfirmSubscription.id)
    try {
      await subscriptionApis.deleteSubscription(deleteConfirmSubscription.id)
      await refreshSubscriptions()
      toast.success(t('delete_success'))
    } catch (error) {
      console.error('Failed to delete subscription:', error)
      toast.error(t('delete_failed'))
    } finally {
      setActionLoading(null)
      setDeleteConfirmSubscription(null)
    }
  }, [deleteConfirmSubscription, refreshSubscriptions, t])

  const handleCopyWebhookUrl = useCallback(
    async (subscription: Subscription) => {
      if (!subscription.webhook_url) return
      try {
        // Construct full URL
        const baseUrl = window.location.origin
        const fullUrl = `${baseUrl}${subscription.webhook_url}`
        await navigator.clipboard.writeText(fullUrl)
        toast.success(t('webhook_url_copied'))
      } catch (error) {
        console.error('Failed to copy webhook URL:', error)
        toast.error(t('copy_failed'))
      }
    },
    [t]
  )

  const handleCopyWebhooksecret = useCallback(
    async (subscription: Subscription) => {
      if (!subscription.webhook_secret) return
      try {
        await navigator.clipboard.writeText(subscription.webhook_secret)
        toast.success(t('webhook_secret_copied'))
      } catch (error) {
        console.error('Failed to copy webhook secret:', error)
        toast.error(t('copy_failed'))
      }
    },
    [t]
  )

  const handleCopySubscriptionId = useCallback(
    async (subscription: Subscription) => {
      try {
        await navigator.clipboard.writeText(String(subscription.id))
        toast.success(t('subscription_id_copied'))
      } catch (error) {
        console.error('Failed to copy subscription ID:', error)
        toast.error(t('copy_failed'))
      }
    },
    [t]
  )

  const formatNextExecution = (dateStr?: string) => {
    return formatUTCDate(dateStr)
  }

  const getTriggerLabel = (subscription: Subscription): string => {
    const config = subscription.trigger_config || {}
    switch (subscription.trigger_type) {
      case 'cron':
        return String(config.expression || 'Cron')
      case 'interval':
        return `${config.value || ''} ${config.unit || ''}`.trim() || 'Interval'
      case 'one_time':
        return t('trigger_one_time')
      case 'event':
        return config.event_type === 'webhook' ? 'Webhook' : 'Git Push'
      default:
        return subscription.trigger_type || 'Unknown'
    }
  }

  return (
    <div className="flex h-full flex-col">
      {/* List */}
      <div className="flex-1 overflow-y-auto">
        {subscriptionsLoading && subscriptions.length === 0 ? (
          <div className="flex h-40 items-center justify-center text-text-muted">
            {t('common:actions.loading')}
          </div>
        ) : subscriptions.length === 0 ? (
          <div className="flex h-40 flex-col items-center justify-center gap-2 text-text-muted">
            <p>{t('no_subscriptions')}</p>
            <Button variant="outline" onClick={onCreateSubscription} size="sm">
              <Plus className="mr-1.5 h-4 w-4" />
              {t('create_first_subscription')}
            </Button>
          </div>
        ) : (
          <div className="divide-y divide-border">
            {subscriptions.map(subscription => {
              const isExpanded = expandedSubscriptionId === subscription.id
              const history = executionHistory[subscription.id] || []
              const isLoadingHistory = executionHistoryLoading === subscription.id

              return (
                <div key={subscription.id} className="border-b border-border last:border-b-0">
                  {/* Main subscription row */}
                  <div className="flex items-center gap-4 px-4 py-3 hover:bg-surface/50">
                    {/* Icon and Name */}
                    <div className="flex min-w-0 flex-1 items-center gap-3">
                      <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-surface text-text-secondary">
                        {triggerTypeIcons[subscription.trigger_type]}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="truncate font-medium">{subscription.display_name}</span>
                          <Badge
                            variant={
                              subscription.task_type === 'execution' ? 'default' : 'secondary'
                            }
                            className="text-xs"
                          >
                            {subscription.task_type === 'execution'
                              ? t('task_type_execution')
                              : t('task_type_collection')}
                          </Badge>
                        </div>
                        <div className="flex items-center gap-2 text-xs text-text-muted">
                          <span>{getTriggerLabel(subscription)}</span>
                          {subscription.trigger_type !== 'event' && (
                            <>
                              <span>·</span>
                              <span>
                                {t('next_execution')}:{' '}
                                {formatNextExecution(subscription.next_execution_time)}
                              </span>
                            </>
                          )}
                          {subscription.trigger_type === 'event' && subscription.webhook_url && (
                            <>
                              <span>·</span>
                              <span className="truncate max-w-[200px]">
                                {subscription.webhook_url}
                              </span>
                            </>
                          )}
                        </div>
                      </div>
                    </div>

                    {/* Stats with expand button */}
                    <div className="hidden sm:flex items-center gap-2">
                      <button
                        onClick={() => loadExecutionHistory(subscription.id)}
                        className="flex items-center gap-1.5 px-2 py-1 rounded-md hover:bg-surface transition-colors text-text-muted hover:text-text-primary"
                        disabled={isLoadingHistory}
                      >
                        {isLoadingHistory ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <History className="h-3.5 w-3.5" />
                        )}
                        <span className="text-sm font-medium">{subscription.execution_count}</span>
                        <span className="text-xs">{t('executions')}</span>
                        {isExpanded ? (
                          <ChevronUp className="h-3.5 w-3.5" />
                        ) : (
                          <ChevronDown className="h-3.5 w-3.5" />
                        )}
                      </button>
                    </div>

                    {/* Toggle */}
                    <Switch
                      checked={subscription.enabled}
                      onCheckedChange={enabled => handleToggle(subscription, enabled)}
                      disabled={actionLoading === subscription.id}
                    />

                    {/* Actions - Desktop: Direct buttons, Mobile: Dropdown menu */}
                    {isMobile ? (
                      // Mobile: Dropdown menu
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8"
                            aria-label={t('common:actions.more')}
                          >
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem
                            onClick={() => loadExecutionHistory(subscription.id)}
                            disabled={isLoadingHistory}
                          >
                            <History className="mr-2 h-4 w-4" />
                            {t('view_history')}
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            onClick={() => handleTriggerWithRefresh(subscription)}
                            disabled={actionLoading === subscription.id}
                          >
                            <Play className="mr-2 h-4 w-4" />
                            {t('trigger_now')}
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onClick={() => onEditSubscription(subscription)}
                            disabled={actionLoading === subscription.id}
                          >
                            <Edit className="mr-2 h-4 w-4" />
                            {t('edit')}
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onClick={() => handleCopySubscriptionId(subscription)}
                            disabled={actionLoading === subscription.id}
                          >
                            <Hash className="mr-2 h-4 w-4" />
                            {t('copy_subscription_id')}
                          </DropdownMenuItem>
                          {/* Webhook copy options for event triggers */}
                          {subscription.trigger_type === 'event' && subscription.webhook_url && (
                            <>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                onClick={() => handleCopyWebhookUrl(subscription)}
                                disabled={actionLoading === subscription.id}
                              >
                                <Copy className="mr-2 h-4 w-4" />
                                {t('copy_webhook_url')}
                              </DropdownMenuItem>
                              {subscription.webhook_secret && (
                                <DropdownMenuItem
                                  onClick={() => handleCopyWebhooksecret(subscription)}
                                  disabled={actionLoading === subscription.id}
                                >
                                  <Key className="mr-2 h-4 w-4" />
                                  {t('copy_webhook_secret')}
                                </DropdownMenuItem>
                              )}
                            </>
                          )}
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            onClick={() => setDeleteConfirmSubscription(subscription)}
                            className="text-destructive"
                            disabled={actionLoading === subscription.id}
                          >
                            <Trash2 className="mr-2 h-4 w-4" />
                            {t('delete')}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    ) : (
                      // Desktop: Direct action buttons
                      <TooltipProvider delayDuration={300}>
                        <div className="flex items-center gap-1">
                          {/* Trigger button */}
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8"
                                onClick={() => handleTriggerWithRefresh(subscription)}
                                disabled={actionLoading === subscription.id}
                                aria-label={t('trigger_now')}
                              >
                                <Play className="h-4 w-4" />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>{t('trigger_now')}</TooltipContent>
                          </Tooltip>

                          {/* Edit button */}
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8"
                                onClick={() => onEditSubscription(subscription)}
                                disabled={actionLoading === subscription.id}
                                aria-label={t('edit')}
                              >
                                <Edit className="h-4 w-4" />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>{t('edit')}</TooltipContent>
                          </Tooltip>

                          {/* Copy button - Different behavior for event vs non-event types */}
                          {subscription.trigger_type === 'event' && subscription.webhook_url ? (
                            // Event type: Show dropdown with copy options
                            <DropdownMenu>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <DropdownMenuTrigger asChild>
                                    <Button
                                      variant="ghost"
                                      size="icon"
                                      className="h-8 w-8"
                                      disabled={actionLoading === subscription.id}
                                      aria-label={t('common:actions.copy')}
                                    >
                                      <Copy className="h-4 w-4" />
                                    </Button>
                                  </DropdownMenuTrigger>
                                </TooltipTrigger>
                                <TooltipContent>{t('common:actions.copy')}</TooltipContent>
                              </Tooltip>
                              <DropdownMenuContent align="end">
                                <DropdownMenuItem
                                  onClick={() => handleCopySubscriptionId(subscription)}
                                >
                                  <Hash className="mr-2 h-4 w-4" />
                                  {t('copy_subscription_id')}
                                </DropdownMenuItem>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem
                                  onClick={() => handleCopyWebhookUrl(subscription)}
                                >
                                  <Copy className="mr-2 h-4 w-4" />
                                  {t('copy_webhook_url')}
                                </DropdownMenuItem>
                                {subscription.webhook_secret && (
                                  <DropdownMenuItem
                                    onClick={() => handleCopyWebhooksecret(subscription)}
                                  >
                                    <Key className="mr-2 h-4 w-4" />
                                    {t('copy_webhook_secret')}
                                  </DropdownMenuItem>
                                )}
                              </DropdownMenuContent>
                            </DropdownMenu>
                          ) : (
                            // Non-event type: Direct copy subscription ID
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-8 w-8"
                                  onClick={() => handleCopySubscriptionId(subscription)}
                                  disabled={actionLoading === subscription.id}
                                  aria-label={t('copy_subscription_id')}
                                >
                                  <Copy className="h-4 w-4" />
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent>{t('copy_subscription_id')}</TooltipContent>
                            </Tooltip>
                          )}

                          {/* Delete button */}
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8 hover:text-destructive"
                                onClick={() => setDeleteConfirmSubscription(subscription)}
                                disabled={actionLoading === subscription.id}
                                aria-label={t('delete')}
                              >
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>{t('delete')}</TooltipContent>
                          </Tooltip>
                        </div>
                      </TooltipProvider>
                    )}
                  </div>

                  {/* Expanded execution history section */}
                  {isExpanded && (
                    <div className="bg-surface/30 border-t border-border px-4 py-3">
                      <div className="flex items-center gap-2 mb-3">
                        <History className="h-4 w-4 text-text-muted" />
                        <span className="text-sm font-medium text-text-secondary">
                          {t('recent_executions')}
                        </span>
                      </div>

                      {history.length === 0 ? (
                        <div className="text-sm text-text-muted py-2">{t('no_executions')}</div>
                      ) : (
                        <div className="space-y-2">
                          {history.map(exec => {
                            const status = statusConfig[exec.status]
                            return (
                              <div
                                key={exec.id}
                                className="flex items-center gap-3 p-2 rounded-lg bg-base hover:bg-surface/50 transition-colors"
                              >
                                {/* Status icon */}
                                <div className={`flex-shrink-0 ${status.color}`}>{status.icon}</div>

                                {/* Execution info */}
                                <div className="flex-1 min-w-0">
                                  <div className="flex items-center gap-2 text-sm">
                                    <span className={status.color}>{t(status.text)}</span>
                                    <span className="text-text-muted">·</span>
                                    <span className="text-text-muted text-xs">
                                      {formatRelativeTime(exec.created_at)}
                                    </span>
                                    {exec.trigger_reason && (
                                      <>
                                        <span className="text-text-muted">·</span>
                                        <span className="text-text-muted text-xs truncate">
                                          {exec.trigger_reason}
                                        </span>
                                      </>
                                    )}
                                  </div>
                                  {exec.result_summary && (
                                    <div className="text-xs text-text-muted mt-1 line-clamp-2">
                                      {exec.result_summary}
                                    </div>
                                  )}
                                  {exec.error_message && (
                                    <div className="text-xs text-red-500 mt-1 line-clamp-2">
                                      {exec.error_message}
                                    </div>
                                  )}
                                </div>

                                {/* View conversation button */}
                                {exec.task_id && (
                                  <button
                                    onClick={() => handleViewConversation(exec.task_id!)}
                                    className="flex-shrink-0 flex items-center gap-1 text-xs text-primary hover:text-primary/80 transition-colors"
                                  >
                                    <MessageSquare className="h-3.5 w-3.5" />
                                    {t('feed.view_conversation')}
                                  </button>
                                )}
                              </div>
                            )
                          })}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )
            })}

            {/* Load more */}
            {subscriptions.length < subscriptionsTotal && (
              <div className="flex justify-center py-4">
                <Button
                  variant="ghost"
                  onClick={loadMoreSubscriptions}
                  disabled={subscriptionsLoading}
                >
                  {subscriptionsLoading ? t('common:actions.loading') : t('common:tasks.load_more')}
                </Button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Delete Confirmation */}
      <AlertDialog
        open={!!deleteConfirmSubscription}
        onOpenChange={open => !open && setDeleteConfirmSubscription(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('delete_confirm_title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('delete_confirm_message', {
                name: deleteConfirmSubscription?.display_name,
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common:actions.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {t('common:actions.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Conversation Dialog */}
      <SubscriptionConversationDialog
        taskId={dialogTaskId}
        open={dialogTaskId !== null}
        onOpenChange={open => {
          if (!open) setDialogTaskId(null)
        }}
      />
    </div>
  )
}
