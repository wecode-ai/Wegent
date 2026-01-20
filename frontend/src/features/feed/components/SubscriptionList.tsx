'use client'

// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Subscription configuration list component.
 */
import { useCallback, useState } from 'react'
import {
  CalendarClock,
  Clock,
  Copy,
  Edit,
  Hash,
  Key,
  MoreHorizontal,
  Play,
  Plus,
  Timer,
  Trash2,
  Webhook,
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
import type { Subscription, SubscriptionTriggerType } from '@/types/subscription'
import { toast } from 'sonner'
import { formatUTCDate } from '@/lib/utils'

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

  const handleTrigger = useCallback(
    async (subscription: Subscription) => {
      setActionLoading(subscription.id)
      try {
        await subscriptionApis.triggerSubscription(subscription.id)
        toast.success(t('trigger_success'))
        // Refresh executions to show the new execution in timeline
        refreshExecutions()
      } catch (error) {
        console.error('Failed to trigger subscription:', error)
        toast.error(t('trigger_failed'))
      } finally {
        setActionLoading(null)
      }
    },
    [t, refreshExecutions]
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
            {subscriptions.map(subscription => (
              <div
                key={subscription.id}
                className="flex items-center gap-4 px-4 py-3 hover:bg-surface/50"
              >
                {/* Icon and Name */}
                <div className="flex min-w-0 flex-1 items-center gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-surface text-text-secondary">
                    {triggerTypeIcons[subscription.trigger_type]}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-medium">{subscription.display_name}</span>
                      <Badge
                        variant={subscription.task_type === 'execution' ? 'default' : 'secondary'}
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
                          <span className="truncate max-w-[200px]">{subscription.webhook_url}</span>
                        </>
                      )}
                    </div>
                  </div>
                </div>

                {/* Stats */}
                <div className="hidden text-center sm:block">
                  <div className="text-sm font-medium">{subscription.execution_count}</div>
                  <div className="text-xs text-text-muted">{t('executions')}</div>
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
                      <Button variant="ghost" size="icon" className="h-8 w-8">
                        <MoreHorizontal className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem
                        onClick={() => handleTrigger(subscription)}
                        disabled={actionLoading === subscription.id}
                      >
                        <Play className="mr-2 h-4 w-4" />
                        {t('trigger_now')}
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => onEditSubscription(subscription)}>
                        <Edit className="mr-2 h-4 w-4" />
                        {t('edit')}
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => handleCopySubscriptionId(subscription)}>
                        <Hash className="mr-2 h-4 w-4" />
                        {t('copy_subscription_id')}
                      </DropdownMenuItem>
                      {/* Webhook copy options for event triggers */}
                      {subscription.trigger_type === 'event' && subscription.webhook_url && (
                        <>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem onClick={() => handleCopyWebhookUrl(subscription)}>
                            <Copy className="mr-2 h-4 w-4" />
                            {t('copy_webhook_url')}
                          </DropdownMenuItem>
                          {subscription.webhook_secret && (
                            <DropdownMenuItem onClick={() => handleCopyWebhooksecret(subscription)}>
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
                            onClick={() => handleTrigger(subscription)}
                            disabled={actionLoading === subscription.id}
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
                            <DropdownMenuItem onClick={() => handleCopyWebhookUrl(subscription)}>
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
            ))}

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
    </div>
  )
}
