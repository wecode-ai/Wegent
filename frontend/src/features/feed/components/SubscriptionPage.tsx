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
import { Compass, Eye, EyeOff, Plus, Store, User } from 'lucide-react'
import { SubscriptionProvider, useSubscriptionContext } from '../contexts/subscriptionContext'
import { SubscriptionTimeline } from './SubscriptionTimeline'
import { SubscriptionForm } from './SubscriptionForm'
import { SubscriptionList } from './SubscriptionList'
import { FollowingSubscriptionList } from './FollowingSubscriptionList'
import { RentalSubscriptionList } from './RentalSubscriptionList'
import { DiscoverPageInline } from './DiscoverPageInline'
import { MarketPageInline } from './MarketPageInline'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import type { Subscription } from '@/types/subscription'

/**
 * Tab configuration for extensibility.
 * Add new tabs here as the feature grows.
 */
export type FeedTabValue = 'all' | 'discover' | 'market' | 'mine'

/**
 * Sub-tab type for "mine" tab
 */
type MineSubTabValue = 'my_created' | 'my_following' | 'shared_to_me' | 'my_rentals'

function SubscriptionPageContent() {
  const { t } = useTranslation('feed')
  const [isFormOpen, setIsFormOpen] = useState(false)
  const [formInitialData, setFormInitialData] = useState<Record<string, unknown> | undefined>(
    undefined
  )
  const [editingSubscription, setEditingSubscription] = useState<Subscription | null>(null)
  const [activeTab, setActiveTab] = useState<FeedTabValue>('all')
  const [mineSubTab, setMineSubTab] = useState<MineSubTabValue>('my_created')
  const { refreshSubscriptions, refreshExecutions, showSilentExecutions, setShowSilentExecutions } =
    useSubscriptionContext()

  const handleCreateSubscription = useCallback(() => {
    setEditingSubscription(null)
    setFormInitialData(undefined)
    setIsFormOpen(true)
  }, [])

  const handleGoToMine = useCallback(() => {
    setActiveTab('mine')
  }, [])

  const handleEditSubscription = useCallback((subscription: Subscription) => {
    setEditingSubscription(subscription)
    setFormInitialData(undefined)
    setIsFormOpen(true)
  }, [])

  const handleFormSuccess = useCallback(() => {
    refreshSubscriptions()
    refreshExecutions()
    // Clear initial data after successful creation
    setFormInitialData(undefined)
    setEditingSubscription(null)
  }, [refreshSubscriptions, refreshExecutions])

  const handleInvitationHandled = useCallback(() => {
    // Refresh executions to show newly followed subscriptions
    refreshExecutions()
  }, [refreshExecutions])

  // Listen for scheme URL events to open create subscription dialog
  useEffect(() => {
    const handleOpenDialog = (e: Event) => {
      const detail = (e as CustomEvent).detail as {
        type?: string
        params?: Record<string, unknown>
      }
      if (detail?.type === 'create-subscription') {
        // Parse the data parameter if provided
        if (detail.params?.data && typeof detail.params.data === 'string') {
          try {
            const parsedData = JSON.parse(detail.params.data as string)
            setFormInitialData(parsedData)
          } catch (error) {
            console.error('Failed to parse scheme URL data parameter:', error)
          }
        }
        setIsFormOpen(true)
      }
    }

    window.addEventListener('wegent:open-dialog', handleOpenDialog)

    // Check for pending dialog in sessionStorage (from navigation)
    const pendingDialog = sessionStorage.getItem('wegent:pending-dialog')
    if (pendingDialog) {
      try {
        const data = JSON.parse(pendingDialog) as {
          type?: string
          params?: Record<string, unknown>
        }
        sessionStorage.removeItem('wegent:pending-dialog')

        if (data.type === 'create-subscription') {
          // Parse the data parameter if provided
          if (data.params?.data && typeof data.params.data === 'string') {
            try {
              const parsedData = JSON.parse(data.params.data as string)
              setFormInitialData(parsedData)
            } catch (error) {
              console.error('Failed to parse scheme URL data parameter:', error)
            }
          }

          // Delay to ensure component is fully mounted
          setTimeout(() => {
            setIsFormOpen(true)
          }, 300)
        }
      } catch (error) {
        console.error('Failed to parse pending dialog:', error)
      }
    }

    return () => {
      window.removeEventListener('wegent:open-dialog', handleOpenDialog)
    }
  }, [])

  const handleRentalSuccess = useCallback(() => {
    // Refresh subscriptions to show newly rented subscriptions
    refreshSubscriptions()
    refreshExecutions()
  }, [refreshSubscriptions, refreshExecutions])

  return (
    <div className="h-full bg-surface/30 flex flex-col">
      {/* Tab navigation */}
      <div className="border-b border-border px-4 pt-3 bg-base flex items-end justify-between">
        <Tabs
          value={activeTab}
          onValueChange={value => setActiveTab(value as FeedTabValue)}
          className="w-fit"
        >
          <TabsList className="bg-transparent p-0 h-auto gap-4 w-fit">
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
            <TabsTrigger
              value="mine"
              className="px-1 pb-3 pt-0 rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none hover:bg-transparent flex items-center gap-1.5"
            >
              <User className="h-4 w-4" />
              {t('tabs.mine')}
            </TabsTrigger>
          </TabsList>
        </Tabs>
        {/* Silent executions toggle - only show on "all" tab */}
        {activeTab === 'all' && (
          <button
            onClick={() => setShowSilentExecutions(!showSilentExecutions)}
            className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 mb-1.5 rounded-md text-xs font-medium transition-colors ${
              showSilentExecutions
                ? 'bg-primary/10 text-primary'
                : 'bg-surface text-text-muted hover:text-text-primary hover:bg-surface-hover'
            }`}
            title={showSilentExecutions ? t('feed.hide_silent') : t('feed.show_silent')}
          >
            {showSilentExecutions ? (
              <Eye className="h-3.5 w-3.5" />
            ) : (
              <EyeOff className="h-3.5 w-3.5" />
            )}
            {t('feed.silent_executions')}
          </button>
        )}
        {/* Create button - only show on "mine" tab with "my_created" sub-tab */}
        {activeTab === 'mine' && mineSubTab === 'my_created' && (
          <Button onClick={handleCreateSubscription} size="sm" className="mb-1.5">
            <Plus className="h-4 w-4 mr-1.5" />
            {t('create_subscription')}
          </Button>
        )}
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-hidden flex flex-col">
        {activeTab === 'all' && (
          <SubscriptionTimeline
            onCreateSubscription={handleCreateSubscription}
            onGoToMine={handleGoToMine}
          />
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
        {activeTab === 'mine' && (
          <div className="h-full flex flex-col">
            {/* Sub-tab navigation for "mine" */}
            <div className="border-b border-border bg-base">
              <Tabs
                value={mineSubTab}
                onValueChange={value => setMineSubTab(value as MineSubTabValue)}
                className="w-full"
              >
                <TabsList className="w-full justify-start bg-transparent p-0 h-auto gap-0 rounded-none">
                  <TabsTrigger
                    value="my_created"
                    className="px-4 py-2.5 rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none hover:bg-transparent text-sm"
                  >
                    {t('tabs_my_created')}
                  </TabsTrigger>
                  <TabsTrigger
                    value="my_following"
                    className="px-4 py-2.5 rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none hover:bg-transparent text-sm"
                  >
                    {t('tabs_my_following')}
                  </TabsTrigger>
                  <TabsTrigger
                    value="shared_to_me"
                    className="px-4 py-2.5 rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none hover:bg-transparent text-sm"
                  >
                    {t('tabs_shared_to_me')}
                  </TabsTrigger>
                  <TabsTrigger
                    value="my_rentals"
                    className="px-4 py-2.5 rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none hover:bg-transparent text-sm"
                  >
                    {t('tabs_my_rentals')}
                  </TabsTrigger>
                </TabsList>
              </Tabs>
            </div>

            {/* Sub-tab content */}
            <div className="flex-1 overflow-hidden">
              {mineSubTab === 'my_created' && (
                <SubscriptionList
                  onCreateSubscription={handleCreateSubscription}
                  onEditSubscription={handleEditSubscription}
                />
              )}
              {mineSubTab === 'my_following' && <FollowingSubscriptionList followType="direct" />}
              {mineSubTab === 'shared_to_me' && <FollowingSubscriptionList followType="invited" />}
              {mineSubTab === 'my_rentals' && <RentalSubscriptionList />}
            </div>
          </div>
        )}
      </div>

      <SubscriptionForm
        open={isFormOpen}
        onOpenChange={setIsFormOpen}
        subscription={editingSubscription}
        onSuccess={handleFormSuccess}
        initialData={formInitialData}
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
