'use client'

// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Subscription detail page component.
 * Shows subscription info, followers, and allows follow/unfollow.
 */
import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  ArrowLeft,
  CalendarClock,
  Check,
  Clock,
  Eye,
  EyeOff,
  Loader2,
  Plus,
  Share2,
  Timer,
  Users,
  Webhook,
} from 'lucide-react'
import { toast } from 'sonner'
import { useTranslation } from '@/hooks/useTranslation'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { subscriptionApis } from '@/apis/subscription'
import type {
  Subscription,
  SubscriptionFollowerResponse,
  SubscriptionTriggerType,
} from '@/types/subscription'
import { paths } from '@/config/paths'
import { useUser } from '@/features/common/UserContext'
import { SubscriptionShareDialog } from './SubscriptionShareDialog'

interface SubscriptionDetailPageProps {
  subscriptionId: number
}

const triggerTypeIcons: Record<SubscriptionTriggerType, React.ReactNode> = {
  cron: <CalendarClock className="h-4 w-4" />,
  interval: <Timer className="h-4 w-4" />,
  one_time: <Clock className="h-4 w-4" />,
  event: <Webhook className="h-4 w-4" />,
}

export function SubscriptionDetailPage({ subscriptionId }: SubscriptionDetailPageProps) {
  const { t } = useTranslation('feed')
  const router = useRouter()
  const { user } = useUser()

  // State
  const [subscription, setSubscription] = useState<Subscription | null>(null)
  const [loading, setLoading] = useState(true)
  const [followers, setFollowers] = useState<SubscriptionFollowerResponse[]>([])
  const [followersLoading, setFollowersLoading] = useState(false)
  const [followersTotal, setFollowersTotal] = useState(0)
  const [isFollowing, setIsFollowing] = useState(false)
  const [followLoading, setFollowLoading] = useState(false)
  const [shareDialogOpen, setShareDialogOpen] = useState(false)

  // Check if current user is the owner
  const isOwner = subscription && user && subscription.user_id === user.id

  // Load subscription
  const loadSubscription = useCallback(async () => {
    try {
      setLoading(true)
      const data = await subscriptionApis.getSubscription(subscriptionId)
      setSubscription(data)
      setIsFollowing(data.is_following)
    } catch (error) {
      console.error('Failed to load subscription:', error)
      toast.error(t('common:errors.load_failed'))
    } finally {
      setLoading(false)
    }
  }, [subscriptionId, t])

  // Load followers (owner only)
  const loadFollowers = useCallback(async () => {
    if (!isOwner) return

    try {
      setFollowersLoading(true)
      const response = await subscriptionApis.getFollowers(subscriptionId, { page: 1, limit: 50 })
      setFollowers(response.items)
      setFollowersTotal(response.total)
    } catch (error) {
      console.error('Failed to load followers:', error)
    } finally {
      setFollowersLoading(false)
    }
  }, [subscriptionId, isOwner])

  // Initial load
  useEffect(() => {
    loadSubscription()
  }, [loadSubscription])

  // Load followers when owner
  useEffect(() => {
    if (isOwner) {
      loadFollowers()
    }
  }, [isOwner, loadFollowers])

  // Handle follow/unfollow
  const handleFollow = useCallback(async () => {
    if (!subscription) return

    try {
      setFollowLoading(true)
      if (isFollowing) {
        await subscriptionApis.unfollowSubscription(subscriptionId)
        setIsFollowing(false)
        setSubscription(prev =>
          prev ? { ...prev, followers_count: Math.max(0, prev.followers_count - 1) } : null
        )
        toast.success(t('unfollow_success'))
      } else {
        await subscriptionApis.followSubscription(subscriptionId)
        setIsFollowing(true)
        setSubscription(prev =>
          prev ? { ...prev, followers_count: prev.followers_count + 1 } : null
        )
        toast.success(t('follow_success'))
      }
    } catch (error) {
      console.error('Failed to follow/unfollow:', error)
      toast.error(isFollowing ? t('unfollow_failed') : t('follow_failed'))
    } finally {
      setFollowLoading(false)
    }
  }, [subscription, subscriptionId, isFollowing, t])

  // Get trigger label
  const getTriggerLabel = (sub: Subscription): string => {
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

  if (loading) {
    return (
      <div className="h-full bg-surface/30 flex items-center justify-center">
        <div className="flex flex-col items-center gap-3 text-text-muted">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
          <span>{t('common:actions.loading')}</span>
        </div>
      </div>
    )
  }

  if (!subscription) {
    return (
      <div className="h-full bg-surface/30 flex items-center justify-center">
        <div className="text-center text-text-muted">
          <p>{t('common:errors.not_found')}</p>
          <Button variant="link" onClick={() => router.push(paths.feed.getHref())}>
            {t('common:actions.go_back')}
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="h-full bg-surface/30 flex flex-col">
      {/* Header */}
      <div className="border-b border-border px-4 py-3">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => router.back()}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <h1 className="text-lg font-semibold flex-1 truncate">{subscription.display_name}</h1>

          {/* Actions */}
          <div className="flex items-center gap-2">
            {isOwner && (
              <Button variant="outline" size="sm" onClick={() => setShareDialogOpen(true)}>
                <Share2 className="h-4 w-4 mr-1.5" />
                {t('share')}
              </Button>
            )}
            {!isOwner && (
              <Button
                variant={isFollowing ? 'ghost' : 'default'}
                size="sm"
                onClick={handleFollow}
                disabled={followLoading}
                className={
                  isFollowing
                    ? 'text-text-muted hover:text-destructive hover:bg-destructive/10'
                    : ''
                }
              >
                {followLoading ? (
                  <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
                ) : isFollowing ? (
                  <Check className="h-4 w-4 mr-1.5" />
                ) : (
                  <Plus className="h-4 w-4 mr-1.5" />
                )}
                {isFollowing ? t('following') : t('follow')}
              </Button>
            )}
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        <div className="p-4 space-y-6">
          {/* Basic Info */}
          <div className="space-y-4">
            {/* Description */}
            {subscription.description && (
              <p className="text-text-secondary">{subscription.description}</p>
            )}

            {/* Meta info */}
            <div className="flex flex-wrap items-center gap-3">
              {/* Visibility */}
              <Badge variant="info" className="flex items-center gap-1">
                {subscription.visibility === 'public' ? (
                  <>
                    <Eye className="h-3 w-3" />
                    {t('visibility_public')}
                  </>
                ) : (
                  <>
                    <EyeOff className="h-3 w-3" />
                    {t('visibility_private')}
                  </>
                )}
              </Badge>

              {/* Task type */}
              <Badge variant={subscription.task_type === 'execution' ? 'default' : 'secondary'}>
                {subscription.task_type === 'execution'
                  ? t('task_type_execution')
                  : t('task_type_collection')}
              </Badge>

              {/* Trigger type */}
              <Badge variant="info" className="flex items-center gap-1">
                {triggerTypeIcons[subscription.trigger_type]}
                {getTriggerLabel(subscription)}
              </Badge>

              {/* Followers count */}
              <span className="flex items-center gap-1 text-sm text-text-muted">
                <Users className="h-4 w-4" />
                {t('followers_count', { count: subscription.followers_count })}
              </span>
            </div>

            {/* Owner info */}
            {subscription.owner_username && (
              <p className="text-sm text-text-muted">
                {t('owner')}: @{subscription.owner_username}
              </p>
            )}
          </div>

          {/* Owner-only: Followers list */}
          {isOwner && (
            <div className="border-t border-border pt-4">
              <Tabs defaultValue="followers">
                <TabsList>
                  <TabsTrigger value="followers">
                    {t('followers')} ({followersTotal})
                  </TabsTrigger>
                </TabsList>
                <TabsContent value="followers" className="mt-4">
                  {followersLoading ? (
                    <div className="flex items-center justify-center py-8">
                      <Loader2 className="h-6 w-6 animate-spin text-primary" />
                    </div>
                  ) : followers.length === 0 ? (
                    <div className="text-center py-8 text-text-muted">
                      <Users className="h-8 w-8 mx-auto mb-2 opacity-50" />
                      <p>{t('discover_empty')}</p>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {followers.map(follower => (
                        <div
                          key={follower.user_id}
                          className="flex items-center justify-between p-3 rounded-lg bg-surface/50"
                        >
                          <div>
                            <span className="font-medium">@{follower.username}</span>
                            <Badge variant="info" className="ml-2 text-xs">
                              {follower.follow_type === 'direct' ? t('follow') : t('invitations')}
                            </Badge>
                          </div>
                          <span className="text-xs text-text-muted">
                            {new Date(follower.followed_at).toLocaleDateString()}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </TabsContent>
              </Tabs>
            </div>
          )}
        </div>
      </div>

      {/* Share Dialog */}
      {isOwner && (
        <SubscriptionShareDialog
          subscription={subscription}
          open={shareDialogOpen}
          onOpenChange={setShareDialogOpen}
        />
      )}
    </div>
  )
}
