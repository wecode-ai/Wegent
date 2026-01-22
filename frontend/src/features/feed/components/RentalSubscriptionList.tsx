'use client'

// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Rental subscription list component.
 * Displays subscriptions that the user has rented from the market.
 */
import { useCallback, useEffect, useState } from 'react'
import {
  CalendarClock,
  Clock,
  Loader2,
  Play,
  ShoppingBag,
  Timer,
  Trash2,
  Webhook,
} from 'lucide-react'
import { toast } from 'sonner'
import { useTranslation } from '@/hooks/useTranslation'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
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
import { subscriptionApis } from '@/apis/subscription'
import type { RentalSubscriptionResponse, SubscriptionTriggerType } from '@/types/subscription'
import { formatUTCDate } from '@/lib/utils'
import { useSubscriptionContext } from '../contexts/subscriptionContext'

const triggerTypeIcons: Record<SubscriptionTriggerType, React.ReactNode> = {
  cron: <CalendarClock className="h-4 w-4" />,
  interval: <Timer className="h-4 w-4" />,
  one_time: <Clock className="h-4 w-4" />,
  event: <Webhook className="h-4 w-4" />,
}

export function RentalSubscriptionList() {
  const { t } = useTranslation('feed')
  const { refreshExecutions } = useSubscriptionContext()

  // State
  const [rentals, setRentals] = useState<RentalSubscriptionResponse[]>([])
  const [loading, setLoading] = useState(true)
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [actionLoading, setActionLoading] = useState<number | null>(null)
  const [pendingCancel, setPendingCancel] = useState<RentalSubscriptionResponse | null>(null)

  // Load rental subscriptions
  const loadRentals = useCallback(
    async (pageNum: number, append = false) => {
      try {
        if (!append) {
          setLoading(true)
        }
        const response = await subscriptionApis.getMyRentals({
          page: pageNum,
          limit: 20,
        })

        if (append) {
          setRentals(prev => [...prev, ...response.items])
        } else {
          setRentals(response.items)
        }
        setTotal(response.total)
      } catch (error) {
        console.error('Failed to load rental subscriptions:', error)
        toast.error(t('common:errors.load_failed'))
      } finally {
        setLoading(false)
      }
    },
    [t]
  )

  // Initial load
  useEffect(() => {
    loadRentals(1)
  }, [loadRentals])

  // Load more
  const handleLoadMore = useCallback(() => {
    const nextPage = page + 1
    setPage(nextPage)
    loadRentals(nextPage, true)
  }, [page, loadRentals])

  // Handle toggle enabled
  const handleToggle = useCallback(
    async (rental: RentalSubscriptionResponse, enabled: boolean) => {
      setActionLoading(rental.id)
      try {
        await subscriptionApis.toggleSubscription(rental.id, enabled)
        // Update local state
        setRentals(prev => prev.map(r => (r.id === rental.id ? { ...r, enabled } : r)))
        toast.success(enabled ? t('enabled_success') : t('disabled_success'))
      } catch (error) {
        console.error('Failed to toggle rental subscription:', error)
        toast.error(t('toggle_failed'))
      } finally {
        setActionLoading(null)
      }
    },
    [t]
  )

  // Handle trigger now
  const handleTrigger = useCallback(
    async (rental: RentalSubscriptionResponse) => {
      setActionLoading(rental.id)
      try {
        await subscriptionApis.triggerSubscription(rental.id)
        toast.success(t('trigger_success'))
        refreshExecutions()
      } catch (error) {
        console.error('Failed to trigger rental subscription:', error)
        toast.error(t('trigger_failed'))
      } finally {
        setActionLoading(null)
      }
    },
    [t, refreshExecutions]
  )

  // Handle cancel rental click
  const handleCancelClick = useCallback((rental: RentalSubscriptionResponse) => {
    setPendingCancel(rental)
  }, [])

  // Confirm cancel rental
  const handleConfirmCancel = useCallback(async () => {
    if (!pendingCancel || actionLoading) return

    try {
      setActionLoading(pendingCancel.id)
      await subscriptionApis.deleteSubscription(pendingCancel.id)
      toast.success(t('delete_success'))
      // Remove from list
      setRentals(prev => prev.filter(r => r.id !== pendingCancel.id))
      setTotal(prev => Math.max(0, prev - 1))
    } catch (error) {
      console.error('Failed to cancel rental:', error)
      toast.error(t('delete_failed'))
    } finally {
      setActionLoading(null)
      setPendingCancel(null)
    }
  }, [pendingCancel, actionLoading, t])

  // Get trigger label
  const getTriggerLabel = (rental: RentalSubscriptionResponse): string => {
    const config = rental.trigger_config || {}
    switch (rental.trigger_type) {
      case 'cron':
        return String(config.expression || 'Cron')
      case 'interval':
        return `${config.value || ''} ${config.unit || ''}`.trim() || 'Interval'
      case 'one_time':
        return t('trigger_one_time')
      case 'event':
        return config.event_type === 'webhook' ? 'Webhook' : 'Git Push'
      default:
        return rental.trigger_type || 'Unknown'
    }
  }

  // Format next execution time
  const formatNextExecution = (dateStr?: string) => {
    return formatUTCDate(dateStr)
  }

  if (loading && rentals.length === 0) {
    return (
      <div className="flex h-40 items-center justify-center text-text-muted">
        <Loader2 className="h-6 w-6 animate-spin text-primary mr-2" />
        {t('common:actions.loading')}
      </div>
    )
  }

  if (rentals.length === 0) {
    return (
      <div className="flex h-40 flex-col items-center justify-center gap-3 text-text-muted">
        <ShoppingBag className="h-10 w-10 text-text-muted/30" />
        <div className="text-center">
          <p className="font-medium text-text-primary">{t('market.no_rentals')}</p>
          <p className="text-sm mt-1">{t('market.no_rentals_hint')}</p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      {/* List */}
      <div className="flex-1 overflow-y-auto">
        <div className="divide-y divide-border">
          {rentals.map(rental => (
            <div key={rental.id} className="flex items-center gap-4 px-4 py-3 hover:bg-surface/50">
              {/* Icon and Name */}
              <div className="flex min-w-0 flex-1 items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-surface text-text-secondary">
                  {triggerTypeIcons[rental.trigger_type]}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium">{rental.display_name}</span>
                    <Badge variant="secondary" className="text-xs">
                      <ShoppingBag className="h-3 w-3 mr-1" />
                      {t('market.rented')}
                    </Badge>
                  </div>
                  <div className="flex items-center gap-2 text-xs text-text-muted">
                    <span>
                      {t('market.source_subscription')}: {rental.source_subscription_display_name}
                    </span>
                    <span>·</span>
                    <span>@{rental.source_owner_username}</span>
                    <span>·</span>
                    <span>{getTriggerLabel(rental)}</span>
                    {rental.next_execution_time && (
                      <>
                        <span>·</span>
                        <span>
                          {t('next_execution')}: {formatNextExecution(rental.next_execution_time)}
                        </span>
                      </>
                    )}
                  </div>
                </div>
              </div>

              {/* Execution count */}
              <div className="hidden sm:flex items-center gap-1.5 text-text-muted">
                <span className="text-sm font-medium">{rental.execution_count}</span>
                <span className="text-xs">{t('executions')}</span>
              </div>

              {/* Toggle */}
              <Switch
                checked={rental.enabled}
                onCheckedChange={enabled => handleToggle(rental, enabled)}
                disabled={actionLoading === rental.id}
              />

              {/* Actions */}
              <TooltipProvider delayDuration={300}>
                <div className="flex items-center gap-1">
                  {/* Trigger button */}
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        onClick={() => handleTrigger(rental)}
                        disabled={actionLoading === rental.id}
                        aria-label={t('trigger_now')}
                      >
                        <Play className="h-4 w-4" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>{t('trigger_now')}</TooltipContent>
                  </Tooltip>

                  {/* Cancel rental button */}
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 hover:text-destructive"
                        onClick={() => handleCancelClick(rental)}
                        disabled={actionLoading === rental.id}
                        aria-label={t('market.cancel_rental')}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>{t('market.cancel_rental')}</TooltipContent>
                  </Tooltip>
                </div>
              </TooltipProvider>
            </div>
          ))}
        </div>

        {/* Load more */}
        {rentals.length < total && (
          <div className="flex justify-center py-4">
            <Button variant="ghost" onClick={handleLoadMore} disabled={loading}>
              {loading ? t('common:actions.loading') : t('common:tasks.load_more')}
            </Button>
          </div>
        )}
      </div>

      {/* Cancel Rental Confirmation Dialog */}
      <AlertDialog
        open={pendingCancel !== null}
        onOpenChange={open => {
          if (!open) setPendingCancel(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('market.cancel_rental_confirm_title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('market.cancel_rental_confirm_message')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common:actions.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleConfirmCancel}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {t('market.cancel_rental')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
