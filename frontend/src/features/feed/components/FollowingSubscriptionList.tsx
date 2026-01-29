'use client'

// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Following subscription list component.
 * Displays subscriptions that the user follows (either directly or via invitation).
 */
import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  CalendarClock,
  Clock,
  Compass,
  Loader2,
  Share2,
  Timer,
  UserMinus,
  Users,
  Webhook,
} from 'lucide-react'
import { toast } from 'sonner'
import { useTranslation } from '@/hooks/useTranslation'
import { Button } from '@/components/ui/button'
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
import { subscriptionApis } from '@/apis/subscription'
import type {
  FollowingSubscriptionResponse,
  FollowType,
  SubscriptionTriggerType,
} from '@/types/subscription'
import { paths } from '@/config/paths'
import { parseUTCDate } from '@/lib/utils'
import { DiscoverHistoryDialog, type HistoryDialogSubscription } from './DiscoverHistoryDialog'

interface FollowingSubscriptionListProps {
  /**
   * Filter by follow type:
   * - 'direct': Show only directly followed subscriptions (我关注的)
   * - 'invited': Show only invitation-based subscriptions (分享给我的)
   * - undefined: Show all following subscriptions
   */
  followType?: FollowType
}

const triggerTypeIcons: Record<SubscriptionTriggerType, React.ReactNode> = {
  cron: <CalendarClock className="h-4 w-4" />,
  interval: <Timer className="h-4 w-4" />,
  one_time: <Clock className="h-4 w-4" />,
  event: <Webhook className="h-4 w-4" />,
}

export function FollowingSubscriptionList({ followType }: FollowingSubscriptionListProps) {
  const { t } = useTranslation('feed')
  const router = useRouter()

  // State
  const [subscriptions, setSubscriptions] = useState<FollowingSubscriptionResponse[]>([])
  const [loading, setLoading] = useState(true)
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [unfollowingId, setUnfollowingId] = useState<number | null>(null)
  const [pendingUnfollow, setPendingUnfollow] = useState<FollowingSubscriptionResponse | null>(null)
  // History dialog state
  const [historyDialogSubscription, setHistoryDialogSubscription] =
    useState<HistoryDialogSubscription | null>(null)

  // Load following subscriptions
  const loadSubscriptions = useCallback(
    async (pageNum: number, append = false) => {
      try {
        if (!append) {
          setLoading(true)
        }
        const response = await subscriptionApis.getFollowingSubscriptions({
          page: pageNum,
          limit: 20,
        })

        // Filter by follow type if specified
        let filteredItems = response.items
        if (followType) {
          filteredItems = response.items.filter(item => item.follow_type === followType)
        }

        if (append) {
          setSubscriptions(prev => [...prev, ...filteredItems])
        } else {
          setSubscriptions(filteredItems)
        }

        // Update total based on filter
        if (followType) {
          // For filtered results, we need to count matching items
          // This is an approximation since we don't have server-side filtering
          setTotal(filteredItems.length)
        } else {
          setTotal(response.total)
        }
      } catch (error) {
        console.error('Failed to load following subscriptions:', error)
        toast.error(t('common:errors.load_failed'))
      } finally {
        setLoading(false)
      }
    },
    [followType, t]
  )

  // Initial load
  useEffect(() => {
    loadSubscriptions(1)
  }, [loadSubscriptions])

  // Load more
  const handleLoadMore = useCallback(() => {
    const nextPage = page + 1
    setPage(nextPage)
    loadSubscriptions(nextPage, true)
  }, [page, loadSubscriptions])

  // Handle unfollow click
  const handleUnfollowClick = useCallback((item: FollowingSubscriptionResponse) => {
    setPendingUnfollow(item)
  }, [])

  // Confirm unfollow
  const handleConfirmUnfollow = useCallback(async () => {
    if (!pendingUnfollow || unfollowingId) return

    try {
      setUnfollowingId(pendingUnfollow.subscription.id)
      await subscriptionApis.unfollowSubscription(pendingUnfollow.subscription.id)
      toast.success(t('unfollow_success'))
      // Remove from list
      setSubscriptions(prev =>
        prev.filter(item => item.subscription.id !== pendingUnfollow.subscription.id)
      )
      setTotal(prev => Math.max(0, prev - 1))
    } catch (error) {
      console.error('Failed to unfollow subscription:', error)
      toast.error(t('unfollow_failed'))
    } finally {
      setUnfollowingId(null)
      setPendingUnfollow(null)
    }
  }, [pendingUnfollow, unfollowingId, t])

  // Handle click on subscription name - open history dialog
  const handleSubscriptionClick = useCallback(
    (subscription: FollowingSubscriptionResponse['subscription']) => {
      setHistoryDialogSubscription({
        id: subscription.id,
        display_name: subscription.display_name,
      })
    },
    []
  )

  // Navigate to discover page
  const handleGoToDiscover = useCallback(() => {
    router.push(paths.feed.getHref() + '?tab=discover')
  }, [router])

  // Format relative time
  const formatRelativeTime = (dateStr: string) => {
    try {
      const date = parseUTCDate(dateStr)
      if (!date || isNaN(date.getTime())) return '-'
      return date.toLocaleDateString()
    } catch {
      return '-'
    }
  }

  // Get trigger label
  const getTriggerLabel = (sub: FollowingSubscriptionResponse['subscription']): string => {
    const config = sub.trigger_config || {}
    switch (sub.trigger_type) {
      case 'cron':
        return String(config.expression || 'Cron')
      case 'interval':
        return `${config.value || ''} ${config.unit || ''}`.trim() || 'Interval'
      case 'one_time':
        return t('trigger_one_time')
      case 'event':
        return config.event_type === 'webhook' ? 'Webhook' : 'Git Push'
      default:
        return sub.trigger_type || 'Unknown'
    }
  }

  // Determine empty state message based on follow type
  const getEmptyMessage = () => {
    if (followType === 'direct') {
      return {
        title: t('no_following_subscriptions'),
        hint: t('no_following_subscriptions_hint'),
        showDiscoverButton: true,
      }
    } else if (followType === 'invited') {
      return {
        title: t('no_shared_subscriptions'),
        hint: t('no_shared_subscriptions_hint'),
        showDiscoverButton: false,
      }
    }
    return {
      title: t('no_following_subscriptions'),
      hint: t('no_following_subscriptions_hint'),
      showDiscoverButton: true,
    }
  }

  if (loading && subscriptions.length === 0) {
    return (
      <div className="flex h-40 items-center justify-center text-text-muted">
        <Loader2 className="h-6 w-6 animate-spin text-primary mr-2" />
        {t('common:actions.loading')}
      </div>
    )
  }

  if (subscriptions.length === 0) {
    const emptyState = getEmptyMessage()
    return (
      <div className="flex h-40 flex-col items-center justify-center gap-3 text-text-muted">
        {followType === 'invited' ? (
          <Share2 className="h-10 w-10 text-text-muted/30" />
        ) : (
          <Users className="h-10 w-10 text-text-muted/30" />
        )}
        <div className="text-center">
          <p className="font-medium text-text-primary">{emptyState.title}</p>
          <p className="text-sm mt-1">{emptyState.hint}</p>
        </div>
        {emptyState.showDiscoverButton && (
          <Button variant="outline" size="sm" onClick={handleGoToDiscover}>
            <Compass className="h-4 w-4 mr-1.5" />
            {t('discover')}
          </Button>
        )}
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      {/* List */}
      <div className="flex-1 overflow-y-auto">
        <div className="divide-y divide-border">
          {subscriptions.map(item => {
            const subscription = item.subscription

            return (
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
                      <button
                        onClick={() => handleSubscriptionClick(subscription)}
                        className="truncate font-medium hover:text-primary transition-colors text-left"
                      >
                        {subscription.display_name}
                      </button>
                      <Badge
                        variant={subscription.task_type === 'execution' ? 'default' : 'secondary'}
                        className="text-xs"
                      >
                        {subscription.task_type === 'execution'
                          ? t('task_type_execution')
                          : t('task_type_collection')}
                      </Badge>
                      {item.follow_type === 'invited' && (
                        <Badge variant="info" className="text-xs">
                          <Share2 className="h-3 w-3 mr-1" />
                          {t('shared_by')}
                        </Badge>
                      )}
                    </div>
                    <div className="flex items-center gap-2 text-xs text-text-muted">
                      <span>@{subscription.owner_username}</span>
                      <span>·</span>
                      <span>{getTriggerLabel(subscription)}</span>
                      <span>·</span>
                      <span>
                        {t('followed_at')}: {formatRelativeTime(item.followed_at)}
                      </span>
                    </div>
                  </div>
                </div>

                {/* Followers count */}
                <div className="hidden sm:flex items-center gap-1.5 text-text-muted">
                  <Users className="h-3.5 w-3.5" />
                  <span className="text-sm">{subscription.followers_count}</span>
                </div>

                {/* Actions */}
                <div className="flex items-center gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleUnfollowClick(item)}
                    disabled={unfollowingId === subscription.id}
                    className="text-text-muted hover:text-destructive"
                  >
                    {unfollowingId === subscription.id ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <>
                        <UserMinus className="h-4 w-4 mr-1" />
                        {t('unfollow')}
                      </>
                    )}
                  </Button>
                </div>
              </div>
            )
          })}
        </div>

        {/* Load more */}
        {subscriptions.length < total && (
          <div className="flex justify-center py-4">
            <Button variant="ghost" onClick={handleLoadMore} disabled={loading}>
              {loading ? t('common:actions.loading') : t('common:tasks.load_more')}
            </Button>
          </div>
        )}
      </div>

      {/* Unfollow Confirmation Dialog */}
      <AlertDialog
        open={pendingUnfollow !== null}
        onOpenChange={open => {
          if (!open) setPendingUnfollow(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('unfollow_confirm_title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('unfollow_confirm_message', {
                name: pendingUnfollow?.subscription.display_name,
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common:actions.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleConfirmUnfollow}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {t('unfollow')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* History Dialog */}
      <DiscoverHistoryDialog
        subscription={historyDialogSubscription}
        open={historyDialogSubscription !== null}
        onOpenChange={open => {
          if (!open) setHistoryDialogSubscription(null)
        }}
      />
    </div>
  )
}
