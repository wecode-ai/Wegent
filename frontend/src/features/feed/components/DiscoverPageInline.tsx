'use client'

// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Inline version of Discover page for embedding in tabs.
 * Uses Pinterest/Xiaohongshu-style masonry feed layout for rich content display.
 */
import { useCallback, useEffect, useState, useMemo } from 'react'
import { Loader2, Search, Sparkles, TrendingUp, Clock } from 'lucide-react'
import { toast } from 'sonner'
import { useTranslation } from '@/hooks/useTranslation'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { subscriptionApis } from '@/apis/subscription'
import type { DiscoverSubscriptionResponse, BackgroundExecution } from '@/types/subscription'
import { DiscoverHistoryDialog } from './DiscoverHistoryDialog'
import { DiscoverFeedCard, DiscoverFeedCardSkeleton } from './DiscoverFeedCard'
import './discover-feed.css'
import { useMediaQuery } from '@/hooks/useMediaQuery'

type SortBy = 'popularity' | 'recent'

interface DiscoverPageInlineProps {
  onInvitationHandled?: () => void
}

// Distribute items into columns for masonry layout
function distributeToColumns<T>(items: T[], columnCount: number): T[][] {
  const columns: T[][] = Array.from({ length: columnCount }, () => [])
  items.forEach((item, index) => {
    const columnIndex = index % columnCount
    columns[columnIndex].push(item)
  })
  return columns
}

export function DiscoverPageInline({ onInvitationHandled }: DiscoverPageInlineProps) {
  const { t } = useTranslation('feed')

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

  // Get column count based on screen size
  const isMobile = useMediaQuery('(max-width: 767px)')
  const isTablet = useMediaQuery('(min-width: 768px) and (max-width: 1279px)')
  const isDesktop = useMediaQuery('(min-width: 1280px) and (max-width: 1535px)')

  const columnCount = useMemo(() => {
    if (isMobile) return 1
    if (isTablet) return 2
    if (isDesktop) return 3
    return 4
  }, [isMobile, isTablet, isDesktop])

  // Distribute subscriptions to columns
  const columnData = useMemo(
    () => distributeToColumns(subscriptions, columnCount),
    [subscriptions, columnCount]
  )

  // State for latest execution preview
  const [executionHistory, setExecutionHistory] = useState<Record<number, BackgroundExecution>>({})

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
          [subscriptionId]: response.items[0],
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

  // Handle follow
  const handleFollow = useCallback(
    async (subscriptionId: number) => {
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
      // Notify parent to refresh executions
      onInvitationHandled?.()
    },
    [onInvitationHandled]
  )

  // Handle unfollow
  const handleUnfollow = useCallback(async (subscriptionId: number) => {
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
  }, [])

  // Load more
  const handleLoadMore = useCallback(() => {
    const nextPage = page + 1
    setPage(nextPage)
    loadSubscriptions(nextPage, true)
  }, [page, loadSubscriptions])

  // Handle card click - open history dialog
  const handleCardClick = useCallback((subscription: DiscoverSubscriptionResponse) => {
    setHistoryDialogSubscription(subscription)
  }, [])

  // Render loading skeletons
  const renderSkeletons = () => (
    <>
      {[...Array(6)].map((_, i) => (
        <DiscoverFeedCardSkeleton key={i} />
      ))}
    </>
  )

  return (
    <div className="h-full flex flex-col">
      {/* Search and Sort */}
      <div className="px-4 py-3 border-b border-border bg-base">
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

      {/* Content - Masonry Feed */}
      <div className="flex-1 overflow-y-auto discover-feed-scroll-container bg-base">
        {loading ? (
          <div className="discover-feed-masonry">{renderSkeletons()}</div>
        ) : subscriptions.length === 0 ? (
          <div className="discover-feed-empty">
            <div className="discover-feed-empty-icon">
              <Sparkles className="h-10 w-10 text-text-muted/30" />
            </div>
            <p className="discover-feed-empty-title">{t('discover_empty')}</p>
            <p className="discover-feed-empty-hint">{t('discover_empty_hint')}</p>
          </div>
        ) : (
          <>
            {/* Masonry Feed Grid - Balanced Columns */}
            <div className="discover-feed-masonry">
              {columnData.map((column, columnIndex) => (
                <div key={columnIndex} className="discover-feed-column">
                  {column.map(subscription => (
                    <DiscoverFeedCard
                      key={subscription.id}
                      subscription={subscription}
                      latestExecution={executionHistory[subscription.id]}
                      isFollowing={followingIds.has(subscription.id)}
                      onFollow={handleFollow}
                      onUnfollow={handleUnfollow}
                      onClick={handleCardClick}
                    />
                  ))}
                </div>
              ))}
            </div>

            {/* Load more */}
            {subscriptions.length < total && (
              <div className="discover-feed-load-more">
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
