'use client'

// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Main Subscription page component - Twitter/Weibo style feed.
 * Displays AI agent activities as a pure social media-like feed.
 * Supports multiple tabs for extensibility.
 */
import { useState, useCallback, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { Compass, Mail } from 'lucide-react'
import { SubscriptionProvider, useSubscriptionContext } from '../contexts/subscriptionContext'
import { SubscriptionTimeline } from './SubscriptionTimeline'
import { SubscriptionForm } from './SubscriptionForm'
import { DiscoverPageInline } from './DiscoverPageInline'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { useTranslation } from '@/hooks/useTranslation'
import { subscriptionApis } from '@/apis/subscription'
import { paths } from '@/config/paths'

/**
 * Tab configuration for extensibility.
 * Add new tabs here as the feature grows.
 */
export type FeedTabValue = 'all' | 'discover'

function SubscriptionPageContent() {
  const { t } = useTranslation('feed')
  const router = useRouter()
  const [isFormOpen, setIsFormOpen] = useState(false)
  const [activeTab, setActiveTab] = useState<FeedTabValue>('all')
  const { refreshSubscriptions, refreshExecutions } = useSubscriptionContext()

  // Pending invitations count
  const [pendingInvitationsCount, setPendingInvitationsCount] = useState(0)

  // Load pending invitations count
  useEffect(() => {
    const loadPendingCount = async () => {
      try {
        const response = await subscriptionApis.getPendingInvitations({ page: 1, limit: 1 })
        setPendingInvitationsCount(response.total)
      } catch (error) {
        console.error('Failed to load pending invitations count:', error)
      }
    }
    loadPendingCount()
  }, [])

  const handleCreateSubscription = useCallback(() => {
    setIsFormOpen(true)
  }, [])

  const handleFormSuccess = useCallback(() => {
    refreshSubscriptions()
    refreshExecutions()
  }, [refreshSubscriptions, refreshExecutions])

  const handleInvitationHandled = useCallback(() => {
    // Refresh pending count
    subscriptionApis.getPendingInvitations({ page: 1, limit: 1 }).then(response => {
      setPendingInvitationsCount(response.total)
    })
    // Refresh executions to show newly followed subscriptions
    refreshExecutions()
  }, [refreshExecutions])

  const handleNavigateToInvitations = useCallback(() => {
    router.push(paths.feedInvitations.getHref())
  }, [router])

  return (
    <div className="h-full bg-surface/30 flex flex-col">
      {/* Tab navigation */}
      <div className="border-b border-border px-4 pt-3">
        <div className="flex items-center justify-between">
          <Tabs value={activeTab} onValueChange={value => setActiveTab(value as FeedTabValue)}>
            <TabsList className="bg-transparent p-0 h-auto gap-4">
              <TabsTrigger
                value="all"
                className="px-1 pb-3 pt-0 rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none hover:bg-transparent"
              >
                {t('tabs.all')}
              </TabsTrigger>
              <TabsTrigger
                value="discover"
                className="px-1 pb-3 pt-0 rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none hover:bg-transparent flex items-center gap-1.5"
              >
                <Compass className="h-4 w-4" />
                {t('discover')}
              </TabsTrigger>
            </TabsList>
          </Tabs>

          {/* Invitations button */}
          <Button
            variant="outline"
            size="sm"
            onClick={handleNavigateToInvitations}
            className="mb-2 relative"
          >
            <Mail className="h-4 w-4 mr-1.5" />
            {t('invitations')}
            {pendingInvitationsCount > 0 && (
              <Badge
                variant="error"
                size="sm"
                className="absolute -top-1.5 -right-1.5 min-w-[18px] h-[18px] p-0 flex items-center justify-center"
              >
                {pendingInvitationsCount}
              </Badge>
            )}
          </Button>
        </div>
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-hidden">
        {activeTab === 'all' && (
          <SubscriptionTimeline onCreateSubscription={handleCreateSubscription} />
        )}
        {activeTab === 'discover' && (
          <div className="h-full">
            <DiscoverPageInline onInvitationHandled={handleInvitationHandled} />
          </div>
        )}
      </div>

      <SubscriptionForm
        open={isFormOpen}
        onOpenChange={setIsFormOpen}
        onSuccess={handleFormSuccess}
      />
    </div>
  )
}

export function SubscriptionPage() {
  return (
    <SubscriptionProvider>
      <SubscriptionPageContent />
    </SubscriptionProvider>
  )
}
