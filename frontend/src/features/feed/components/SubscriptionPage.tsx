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
import { Compass } from 'lucide-react'
import { SubscriptionProvider, useSubscriptionContext } from '../contexts/subscriptionContext'
import { SubscriptionTimeline } from './SubscriptionTimeline'
import { SubscriptionForm } from './SubscriptionForm'
import { DiscoverPageInline } from './DiscoverPageInline'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useTranslation } from '@/hooks/useTranslation'

/**
 * Tab configuration for extensibility.
 * Add new tabs here as the feature grows.
 */
export type FeedTabValue = 'all' | 'discover'

function SubscriptionPageContent() {
  const { t } = useTranslation('feed')
  const [isFormOpen, setIsFormOpen] = useState(false)
  const [formInitialData, setFormInitialData] = useState<Record<string, unknown> | undefined>(
    undefined
  )
  const [activeTab, setActiveTab] = useState<FeedTabValue>('all')
  const { refreshSubscriptions, refreshExecutions } = useSubscriptionContext()

  const handleCreateSubscription = useCallback(() => {
    setIsFormOpen(true)
  }, [])

  const handleFormSuccess = useCallback(() => {
    refreshSubscriptions()
    refreshExecutions()
    // Clear initial data after successful creation
    setFormInitialData(undefined)
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
      </div>

      <SubscriptionForm
        open={isFormOpen}
        onOpenChange={setIsFormOpen}
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
