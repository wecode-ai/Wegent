'use client'

// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Discover Feed Card Component - Masonry layout card for subscription discovery
 * Displays subscription execution results in a rich, Pinterest/Xiaohongshu-style feed
 */
import { useState, useCallback, useRef, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import {
  Users,
  History,
  ChevronDown,
  ChevronUp,
  Bot,
  Clock,
  CheckCircle2,
  XCircle,
  Loader2,
  RefreshCw,
  AlertCircle,
  VolumeX,
} from 'lucide-react'
import { toast } from 'sonner'
import { useTranslation } from '@/hooks/useTranslation'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import type {
  DiscoverSubscriptionResponse,
  BackgroundExecution,
  BackgroundExecutionStatus,
} from '@/types/subscription'
import { paths } from '@/config/paths'
import { useUser } from '@/features/common/UserContext'
import { parseUTCDate } from '@/lib/utils'
import { EnhancedMarkdown } from '@/components/common/EnhancedMarkdown'
import { useTheme } from '@/features/theme/ThemeProvider'

// Status configuration for execution display
const statusConfig: Record<
  BackgroundExecutionStatus,
  { icon: React.ReactNode; text: string; color: string; bgColor: string }
> = {
  PENDING: {
    icon: <Clock className="h-3 w-3" />,
    text: 'status_pending',
    color: 'text-text-muted',
    bgColor: 'bg-gray-100 dark:bg-gray-800',
  },
  RUNNING: {
    icon: <Loader2 className="h-3 w-3 animate-spin" />,
    text: 'status_running',
    color: 'text-primary',
    bgColor: 'bg-primary/10',
  },
  COMPLETED: {
    icon: <CheckCircle2 className="h-3 w-3" />,
    text: 'status_completed',
    color: 'text-green-600',
    bgColor: 'bg-green-50 dark:bg-green-900/20',
  },
  FAILED: {
    icon: <XCircle className="h-3 w-3" />,
    text: 'status_failed',
    color: 'text-red-500',
    bgColor: 'bg-red-50 dark:bg-red-900/20',
  },
  RETRYING: {
    icon: <RefreshCw className="h-3 w-3 animate-spin" />,
    text: 'status_retrying',
    color: 'text-amber-500',
    bgColor: 'bg-amber-50 dark:bg-amber-900/20',
  },
  CANCELLED: {
    icon: <AlertCircle className="h-3 w-3" />,
    text: 'status_cancelled',
    color: 'text-text-muted',
    bgColor: 'bg-gray-100 dark:bg-gray-800',
  },
  COMPLETED_SILENT: {
    icon: <VolumeX className="h-3 w-3" />,
    text: 'status_completed_silent',
    color: 'text-text-muted',
    bgColor: 'bg-gray-100 dark:bg-gray-800',
  },
}

interface DiscoverFeedCardProps {
  subscription: DiscoverSubscriptionResponse
  latestExecution?: BackgroundExecution
  isFollowing: boolean
  onFollow: (subscriptionId: number) => Promise<void>
  onUnfollow: (subscriptionId: number) => Promise<void>
  onClick: (subscription: DiscoverSubscriptionResponse) => void
}

export function DiscoverFeedCard({
  subscription,
  latestExecution,
  isFollowing: initialIsFollowing,
  onFollow,
  onUnfollow,
  onClick,
}: DiscoverFeedCardProps) {
  const { t } = useTranslation('feed')
  const router = useRouter()
  const { user } = useUser()
  const { theme } = useTheme()

  const [isExpanded, setIsExpanded] = useState(false)
  const [isFollowing, setIsFollowing] = useState(initialIsFollowing)
  const [isFollowLoading, setIsFollowLoading] = useState(false)
  const [needsExpansion, setNeedsExpansion] = useState(false)
  const contentRef = useRef<HTMLDivElement>(null)

  // Check if content needs expansion (more than ~300px height)
  useEffect(() => {
    if (contentRef.current) {
      const contentHeight = contentRef.current.scrollHeight
      setNeedsExpansion(contentHeight > 350)
    }
  }, [latestExecution?.result_summary])

  // Handle follow/unfollow toggle
  const handleFollowClick = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation()

      if (isFollowLoading) return

      setIsFollowLoading(true)
      try {
        if (isFollowing) {
          await onUnfollow(subscription.id)
          setIsFollowing(false)
          toast.success(t('unfollow_success'))
        } else {
          await onFollow(subscription.id)
          setIsFollowing(true)
          toast.success(t('follow_success'))
        }
      } catch (error) {
        console.error('Failed to toggle follow:', error)
        toast.error(isFollowing ? t('unfollow_failed') : t('follow_failed'))
      } finally {
        setIsFollowLoading(false)
      }
    },
    [isFollowing, isFollowLoading, onFollow, onUnfollow, subscription.id, t]
  )

  // Handle view subscription detail
  const handleViewSubscription = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      router.push(paths.feedSubscriptionDetail.getHref(subscription.id))
    },
    [router, subscription.id]
  )

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

  // Get execution status config
  const execConfig = latestExecution ? statusConfig[latestExecution.status] : null

  // Check if this is the user's own subscription
  const isOwnSubscription = user?.id === subscription.owner_user_id

  return (
    <div className="discover-feed-item">
      <div className="discover-feed-card" onClick={() => onClick(subscription)}>
        {/* Content Area */}
        <div
          ref={contentRef}
          className={`discover-feed-content ${!isExpanded && needsExpansion ? 'collapsed' : ''}`}
        >
          {/* Header Row: Status + Time + Follow Button */}
          <div className="flex items-center justify-between gap-2 mb-3">
            <div className="flex items-center gap-2 min-w-0 flex-1">
              {latestExecution && execConfig ? (
                <>
                  <span
                    className={`discover-feed-status ${execConfig.bgColor} ${execConfig.color}`}
                  >
                    {execConfig.icon}
                    <span>{t(execConfig.text)}</span>
                  </span>
                  <span className="text-xs text-text-muted truncate">
                    {formatRelativeTime(latestExecution.created_at)}
                  </span>
                </>
              ) : (
                <span className="text-xs text-text-muted">{t('no_executions_yet')}</span>
              )}
            </div>
            {/* Follow Button - Top Right */}
            {!isOwnSubscription && (
              <button
                onClick={handleFollowClick}
                disabled={isFollowLoading}
                className={`text-xs font-medium shrink-0 transition-colors ${
                  isFollowing
                    ? 'text-text-muted hover:text-destructive'
                    : 'text-primary hover:text-primary/80'
                }`}
              >
                {isFollowLoading ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : isFollowing ? (
                  t('following')
                ) : (
                  <span className="flex items-center gap-0.5">+ {t('follow')}</span>
                )}
              </button>
            )}
          </div>

          {/* Empty State - No Execution */}
          {!latestExecution && (
            <div className="flex flex-col items-center justify-center py-8 text-text-muted">
              <Bot className="h-10 w-10 mb-2 opacity-30" />
              <span className="text-sm">{t('no_executions_yet')}</span>
            </div>
          )}

          {/* Markdown Content */}
          {latestExecution?.result_summary && (
            <div className="prose prose-sm max-w-none dark:prose-invert">
              <EnhancedMarkdown source={latestExecution.result_summary} theme={theme} />
            </div>
          )}

          {/* Error Message */}
          {latestExecution?.error_message && (
            <div className="mt-3 p-3 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800">
              <div className="flex items-center gap-1.5 text-xs font-medium text-red-600 dark:text-red-400 mb-1">
                <AlertCircle className="h-3.5 w-3.5" />
                {t('feed.error_occurred')}
              </div>
              <div className="text-xs text-red-700 dark:text-red-300 line-clamp-3">
                {latestExecution.error_message}
              </div>
            </div>
          )}
        </div>

        {/* Expand/Collapse Button */}
        {needsExpansion && (
          <button
            className="discover-feed-expand-btn flex items-center justify-center gap-1"
            onClick={e => {
              e.stopPropagation()
              setIsExpanded(!isExpanded)
            }}
          >
            {isExpanded ? (
              <>
                <ChevronUp className="h-4 w-4" />
                {t('feed.collapse')}
              </>
            ) : (
              <>
                <ChevronDown className="h-4 w-4" />
                {t('feed.expand')}
              </>
            )}
          </button>
        )}

        {/* Footer Area - New Design */}
        <div className="discover-feed-footer">
          {/* Row 1: Title + Author + History Button */}
          <div className="flex items-center justify-between gap-2 mb-1">
            <div className="flex items-center gap-1.5 min-w-0 flex-1">
              <button
                onClick={handleViewSubscription}
                className="discover-feed-title"
                title={subscription.display_name}
              >
                {subscription.display_name}
              </button>
              <span className="text-xs text-text-muted truncate shrink-1">
                @{subscription.owner_username}
              </span>
            </div>
            {/* History Button */}
            <Button
              variant="ghost"
              size="sm"
              onClick={e => {
                e.stopPropagation()
                onClick(subscription)
              }}
              className="h-6 w-6 p-0 text-text-muted hover:text-primary shrink-0"
              title={t('view_history')}
            >
              <History className="h-3.5 w-3.5" />
            </Button>
          </div>

          {/* Row 2: Stats (left) + Type (right) */}
          <div className="flex items-center justify-between text-xs text-text-muted">
            <span className="flex items-center gap-0.5">
              <Users className="h-3 w-3" />
              {subscription.followers_count}
            </span>
            <Badge
              variant={subscription.task_type === 'execution' ? 'default' : 'secondary'}
              className="text-[10px] px-1 py-0 h-3.5"
            >
              {subscription.task_type === 'execution'
                ? t('task_type_execution')
                : t('task_type_collection')}
            </Badge>
          </div>
        </div>
      </div>
    </div>
  )
}

// Skeleton Loading Card
export function DiscoverFeedCardSkeleton() {
  return (
    <div className="discover-feed-item">
      <div className="discover-feed-skeleton">
        <div className="discover-feed-skeleton-content">
          <div className="discover-feed-skeleton-line short" />
          <div className="discover-feed-skeleton-line" />
          <div className="discover-feed-skeleton-line" />
          <div className="discover-feed-skeleton-line short" />
        </div>
        <div className="discover-feed-skeleton-footer">
          <div className="discover-feed-skeleton-line short" />
        </div>
      </div>
    </div>
  )
}
