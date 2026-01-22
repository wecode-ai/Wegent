'use client'

// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Inline version of Discover page for embedding in tabs.
 * Allows users to browse and follow public subscriptions without navigation header.
 * Uses card layout with click-to-expand history dialog.
 */
import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  AlertCircle,
  Check,
  CheckCircle2,
  Clock,
  History,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  TrendingUp,
  Users,
  VolumeX,
  XCircle,
} from 'lucide-react'
import { toast } from 'sonner'
import { useTranslation } from '@/hooks/useTranslation'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { subscriptionApis } from '@/apis/subscription'
import type {
  DiscoverSubscriptionResponse,
  BackgroundExecution,
  BackgroundExecutionStatus,
} from '@/types/subscription'
import { paths } from '@/config/paths'
import { useUser } from '@/features/common/UserContext'
import { parseUTCDate } from '@/lib/utils'
import { DiscoverHistoryDialog } from './DiscoverHistoryDialog'
import { EnhancedMarkdown } from '@/components/common/EnhancedMarkdown'
import { useTheme } from '@/features/theme/ThemeProvider'

type SortBy = 'popularity' | 'recent'

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
  COMPLETED_SILENT: {
    icon: <VolumeX className="h-3 w-3" />,
    text: 'status_completed_silent',
    color: 'text-text-muted',
  },
}

interface DiscoverPageInlineProps {
  onInvitationHandled?: () => void
}

export function DiscoverPageInline({ onInvitationHandled }: DiscoverPageInlineProps) {
  const { t } = useTranslation('feed')
  const router = useRouter()
  const { user } = useUser()
  const { theme } = useTheme()

  // State
  const [subscriptions, setSubscriptions] = useState<DiscoverSubscriptionResponse[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [sortBy, setSortBy] = useState<SortBy>('popularity')
  const [search, setSearch] = useState('')
  const [searchInput, setSearchInput] = useState('')
  const [followingIds, setFollowingIds] = useState<Set<number>>(new Set())

  // State for latest execution preview
  const [executionHistory, setExecutionHistory] = useState<Record<number, BackgroundExecution[]>>(
    {}
  )

  // Dialog state for viewing execution history
  const [historyDialogSubscription, setHistoryDialogSubscription] =
    useState<DiscoverSubscriptionResponse | null>(null)

  // Load latest execution for a subscription (for card preview)
  const loadLatestExecution = useCallback(async (subscriptionId: number) => {
    try {
      const response = await subscriptionApis.getExecutions({ page: 1, limit: 1 }, subscriptionId)
      if (response.items.length > 0) {
        setExecutionHistory(prev => ({
          ...prev,
          [subscriptionId]: response.items,
        }))
      }
    } catch (error) {
      // Silently fail for latest execution loading
      console.error('Failed to load latest execution:', error)
    }
  }, [])

  // Load subscriptions
  const loadSubscriptions = useCallback(
    async (pageNum: number, append: boolean = false) => {
      try {
        if (append) {
          setLoadingMore(true)
        } else {
          setLoading(true)
        }

        const response = await subscriptionApis.discoverSubscriptions({
          page: pageNum,
          limit: 20,
          sortBy,
          search: search || undefined,
        })

        if (append) {
          setSubscriptions(prev => [...prev, ...response.items])
        } else {
          setSubscriptions(response.items)
        }
        setTotal(response.total)

        // Track which subscriptions user is following
        const followingSet = new Set<number>()
        response.items.forEach(sub => {
          if (sub.is_following) {
            followingSet.add(sub.id)
          }
        })
        if (append) {
          setFollowingIds(prev => new Set([...prev, ...followingSet]))
        } else {
          setFollowingIds(followingSet)
        }

        // Load latest execution for each subscription (for card preview)
        response.items.forEach(sub => {
          loadLatestExecution(sub.id)
        })
      } catch (error) {
        console.error('Failed to load subscriptions:', error)
        toast.error(t('common:errors.load_failed'))
      } finally {
        setLoading(false)
        setLoadingMore(false)
      }
    },
    [sortBy, search, t, loadLatestExecution]
  )

  // Initial load
  useEffect(() => {
    setPage(1)
    loadSubscriptions(1, false)
  }, [sortBy, search, loadSubscriptions])

  // Handle search
  const handleSearch = useCallback(() => {
    setSearch(searchInput)
  }, [searchInput])

  // Handle follow/unfollow
  const handleFollow = useCallback(
    async (e: React.MouseEvent, subscriptionId: number) => {
      e.stopPropagation() // Prevent card click
      const isFollowing = followingIds.has(subscriptionId)

      try {
        if (isFollowing) {
          await subscriptionApis.unfollowSubscription(subscriptionId)
          setFollowingIds(prev => {
            const next = new Set(prev)
            next.delete(subscriptionId)
            return next
          })
          // Update followers count in list
          setSubscriptions(prev =>
            prev.map(sub =>
              sub.id === subscriptionId
                ? {
                    ...sub,
                    followers_count: Math.max(0, sub.followers_count - 1),
                    is_following: false,
                  }
                : sub
            )
          )
          toast.success(t('unfollow_success'))
        } else {
          await subscriptionApis.followSubscription(subscriptionId)
          setFollowingIds(prev => new Set([...prev, subscriptionId]))
          // Update followers count in list
          setSubscriptions(prev =>
            prev.map(sub =>
              sub.id === subscriptionId
                ? { ...sub, followers_count: sub.followers_count + 1, is_following: true }
                : sub
            )
          )
          toast.success(t('follow_success'))
          // Notify parent to refresh executions
          onInvitationHandled?.()
        }
      } catch (error) {
        console.error('Failed to follow/unfollow:', error)
        toast.error(isFollowing ? t('unfollow_failed') : t('follow_failed'))
      }
    },
    [followingIds, t, onInvitationHandled]
  )

  // Load more
  const handleLoadMore = useCallback(() => {
    const nextPage = page + 1
    setPage(nextPage)
    loadSubscriptions(nextPage, true)
  }, [page, loadSubscriptions])

  // Navigate to subscription detail
  const handleViewSubscription = useCallback(
    (e: React.MouseEvent, subscriptionId: number) => {
      e.stopPropagation() // Prevent card click
      router.push(paths.feedSubscriptionDetail.getHref(subscriptionId))
    },
    [router]
  )

  // Handle card click - open history dialog
  const handleCardClick = useCallback((subscription: DiscoverSubscriptionResponse) => {
    setHistoryDialogSubscription(subscription)
  }, [])

  // Format relative time
  const formatRelativeTime = useCallback(
    (dateString: string) => {
      const date = parseUTCDate(dateString)
      if (!date) return dateString
      const now = new Date()
      const diffMs = now.getTime() - date.getTime()
      const diffMins = Math.floor(diffMs / 60000)
      const diffHours = Math.floor(diffMs / 3600000)
      const diffDays = Math.floor(diffMs / 86400000)

      if (diffMins < 1) return t('common:time.just_now')
      if (diffMins < 60) return t('common:time.minutes_ago', { count: diffMins })
      if (diffHours < 24) return t('common:time.hours_ago', { count: diffHours })
      return t('common:time.days_ago', { count: diffDays })
    },
    [t]
  )

  return (
    <div className="h-full flex flex-col">
      {/* Search and Sort */}
      <div className="px-4 py-3 border-b border-border">
        <div className="flex items-center gap-3">
          <div className="flex-1 relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-text-muted" />
            <Input
              value={searchInput}
              onChange={e => setSearchInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleSearch()}
              placeholder={t('discover_search_placeholder')}
              className="pl-9 h-9"
            />
          </div>
          <Select value={sortBy} onValueChange={value => setSortBy(value as SortBy)}>
            <SelectTrigger className="w-[140px] h-9">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="popularity">
                <div className="flex items-center gap-2">
                  <TrendingUp className="h-4 w-4" />
                  {t('sort_by_popularity')}
                </div>
              </SelectItem>
              <SelectItem value="recent">
                <div className="flex items-center gap-2">
                  <Clock className="h-4 w-4" />
                  {t('sort_by_recent')}
                </div>
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Content - Card Grid */}
      <div className="flex-1 overflow-y-auto p-4">
        {loading ? (
          <div className="flex h-60 items-center justify-center">
            <div className="flex flex-col items-center gap-3 text-text-muted">
              <Loader2 className="h-8 w-8 animate-spin text-primary" />
              <span>{t('common:actions.loading')}</span>
            </div>
          </div>
        ) : subscriptions.length === 0 ? (
          <div className="flex h-60 flex-col items-center justify-center gap-4 text-text-muted px-4">
            <div className="h-20 w-20 rounded-full bg-surface flex items-center justify-center">
              <Sparkles className="h-10 w-10 text-text-muted/30" />
            </div>
            <div className="text-center">
              <p className="font-medium text-text-primary text-lg mb-1">{t('discover_empty')}</p>
            </div>
          </div>
        ) : (
          <>
            {/* Card Grid */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {subscriptions.map(subscription => {
                const latestExecution = executionHistory[subscription.id]?.[0]
                const execConfig = latestExecution ? statusConfig[latestExecution.status] : null

                return (
                  <div
                    key={subscription.id}
                    onClick={() => handleCardClick(subscription)}
                    className="group bg-surface border border-border rounded-xl p-4 hover:shadow-md hover:border-primary/30 transition-all cursor-pointer flex flex-col h-full"
                  >
                    {/* Card Header */}
                    <div className="flex items-start justify-between mb-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <button
                            onClick={e => handleViewSubscription(e, subscription.id)}
                            className="font-semibold text-text-primary hover:text-primary transition-colors truncate text-left"
                          >
                            {subscription.display_name}
                          </button>
                        </div>
                        <div className="flex items-center gap-2">
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
                      </div>

                      {/* Follow Button - hide for own subscriptions */}
                      {user?.id !== subscription.owner_user_id && (
                        <Button
                          variant={followingIds.has(subscription.id) ? 'ghost' : 'default'}
                          size="sm"
                          onClick={e => handleFollow(e, subscription.id)}
                          className={
                            followingIds.has(subscription.id)
                              ? 'shrink-0 ml-2 text-text-muted hover:text-destructive hover:bg-destructive/10'
                              : 'shrink-0 ml-2'
                          }
                        >
                          {followingIds.has(subscription.id) ? (
                            <>
                              <Check className="h-4 w-4 mr-1" />
                              {t('following')}
                            </>
                          ) : (
                            <>
                              <Plus className="h-4 w-4 mr-1" />
                              {t('follow')}
                            </>
                          )}
                        </Button>
                      )}
                    </div>

                    {/* Content area - grows to fill available space */}
                    <div className="flex-1">
                      {/* Description */}
                      {subscription.description && (
                        <p className="text-sm text-text-muted line-clamp-2 mb-3">
                          {subscription.description}
                        </p>
                      )}

                      {/* Latest Execution Preview */}
                      {latestExecution && execConfig && (
                        <div className="rounded-lg border border-border/50 bg-base/50 overflow-hidden mb-3">
                          <div className="flex items-center gap-1.5 px-3 py-2 text-xs bg-surface/50 border-b border-border/30">
                            <span className={execConfig.color}>{execConfig.icon}</span>
                            <span className={execConfig.color}>{t(execConfig.text)}</span>
                            <span className="text-text-muted ml-auto">
                              {formatRelativeTime(latestExecution.created_at)}
                            </span>
                          </div>
                          {latestExecution.result_summary && (
                            <div className="px-3 py-2 text-xs prose prose-xs max-w-none dark:prose-invert line-clamp-3 overflow-hidden">
                              <EnhancedMarkdown
                                source={latestExecution.result_summary}
                                theme={theme}
                              />
                            </div>
                          )}
                          {latestExecution.status === 'FAILED' && latestExecution.error_message && (
                            <div className="px-3 py-2 text-xs text-red-500 bg-red-50 dark:bg-red-950/20 line-clamp-2">
                              {latestExecution.error_message}
                            </div>
                          )}
                        </div>
                      )}
                    </div>

                    {/* Card Footer - always at bottom */}
                    <div className="flex items-center justify-between text-xs text-text-muted pt-2 border-t border-border/50 mt-auto">
                      <div className="flex items-center gap-3">
                        <span className="flex items-center gap-1">
                          <Users className="h-3.5 w-3.5" />
                          {subscription.followers_count}
                        </span>
                        <span>@{subscription.owner_username}</span>
                      </div>
                      <div className="flex items-center gap-1 text-primary opacity-0 group-hover:opacity-100 transition-opacity">
                        <History className="h-3.5 w-3.5" />
                        <span>{t('view_history')}</span>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>

            {/* Load more */}
            {subscriptions.length < total && (
              <div className="flex justify-center py-6">
                <Button
                  variant="outline"
                  onClick={handleLoadMore}
                  disabled={loadingMore}
                  className="rounded-full px-6"
                >
                  {loadingMore ? (
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
          </>
        )}
      </div>

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
