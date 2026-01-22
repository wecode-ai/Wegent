'use client'

// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Main Subscription page component - Twitter/Weibo style feed.
 * Displays AI agent activities as a pure social media-like feed.
 * Supports multiple tabs for extensibility.
 */
import { useState, useCallback } from 'react'
import { Compass, Store } from 'lucide-react'
import { SubscriptionProvider, useSubscriptionContext } from '../contexts/subscriptionContext'
import { SubscriptionTimeline } from './SubscriptionTimeline'
import { SubscriptionForm } from './SubscriptionForm'
import { DiscoverPageInline } from './DiscoverPageInline'
import { MarketPageInline } from './MarketPageInline'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useTranslation } from '@/hooks/useTranslation'

/**
 * Tab configuration for extensibility.
 * Add new tabs here as the feature grows.
 */
export type FeedTabValue = 'all' | 'discover' | 'market'

function SubscriptionPageContent() {
  const { t } = useTranslation('feed')
  const [isFormOpen, setIsFormOpen] = useState(false)
  const [activeTab, setActiveTab] = useState<FeedTabValue>('all')
  const { refreshSubscriptions, refreshExecutions } = useSubscriptionContext()

  const handleCreateSubscription = useCallback(() => {
    setIsFormOpen(true)
  }, [])

  const handleFormSuccess = useCallback(() => {
    refreshSubscriptions()
    refreshExecutions()
  }, [refreshSubscriptions, refreshExecutions])

  const handleInvitationHandled = useCallback(() => {
    // Refresh executions to show newly followed subscriptions
    refreshExecutions()
  }, [refreshExecutions])

  const handleRentalSuccess = useCallback(() => {
    // Refresh subscriptions to show newly rented subscriptions
    refreshSubscriptions()
    refreshExecutions()
  }, [refreshSubscriptions, refreshExecutions])

  return (
    <div className="h-full bg-surface/30 flex flex-col">
      {/* Tab navigation */}
      <div className="border-b border-border px-4 pt-3 bg-base">
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
            <TabsTrigger
              value="market"
              className="px-1 pb-3 pt-0 rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none hover:bg-transparent flex items-center gap-1.5"
            >
              <Store className="h-4 w-4" />
              {t('market.tab')}
            </TabsTrigger>
          </TabsList>
        </Tabs>
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
        {activeTab === 'market' && (
          <div className="h-full">
            <MarketPageInline onRentalSuccess={handleRentalSuccess} />
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
