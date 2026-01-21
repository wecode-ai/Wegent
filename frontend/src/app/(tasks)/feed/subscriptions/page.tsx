// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { ArrowLeft, Plus } from 'lucide-react'
import TopNavigation from '@/features/layout/TopNavigation'
import {
  TaskSidebar,
  ResizableSidebar,
  CollapsedSidebarButtons,
} from '@/features/tasks/components/sidebar'
import {
  SubscriptionList,
  SubscriptionForm,
  FollowingSubscriptionList,
} from '@/features/feed/components'
import {
  SubscriptionProvider,
  useSubscriptionContext,
} from '@/features/feed/contexts/subscriptionContext'
import { Button } from '@/components/ui/button'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import '@/app/tasks/tasks.css'
import '@/features/common/scrollbar.css'
import { useIsMobile } from '@/features/layout/hooks/useMediaQuery'
import { useTranslation } from '@/hooks/useTranslation'
import { ThemeToggle } from '@/features/theme/ThemeToggle'
import type { Subscription } from '@/types/subscription'

/**
 * Tab type for subscription management
 */
type SubscriptionTabValue = 'my_created' | 'my_following' | 'shared_to_me'

/**
 * Flow Subscriptions Management Page
 *
 * Page for managing all types of subscriptions:
 * - My Created: Subscriptions created by the user
 * - My Following: Public subscriptions the user follows directly
 * - Shared to Me: Subscriptions shared to the user via invitation
 */
function SubscriptionsPageContent() {
  const { t } = useTranslation('feed')
  const router = useRouter()
  const { refreshSubscriptions, refreshExecutions } = useSubscriptionContext()

  // Tab state
  const [activeTab, setActiveTab] = useState<SubscriptionTabValue>('my_created')

  // Form state
  const [formOpen, setFormOpen] = useState(false)
  const [editingSubscription, setEditingSubscription] = useState<Subscription | null>(null)

  const handleCreateSubscription = useCallback(() => {
    setEditingSubscription(null)
    setFormOpen(true)
  }, [])

  const handleEditSubscription = useCallback((subscription: Subscription) => {
    setEditingSubscription(subscription)
    setFormOpen(true)
  }, [])

  const handleFormSuccess = useCallback(() => {
    refreshSubscriptions()
    refreshExecutions()
  }, [refreshSubscriptions, refreshExecutions])

  const handleBack = () => {
    router.push('/feed')
  }

  return (
    <div className="flex h-full flex-col bg-base">
      {/* Back button header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-surface">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" className="h-9 w-9" onClick={handleBack}>
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <h1 className="text-lg font-semibold">{t('feed.manage')}</h1>
        </div>
        {activeTab === 'my_created' && (
          <Button onClick={handleCreateSubscription} size="sm">
            <Plus className="h-4 w-4 mr-1.5" />
            {t('create_subscription')}
          </Button>
        )}
      </div>

      {/* Tab navigation */}
      <div className="border-b border-border bg-surface/50">
        <Tabs
          value={activeTab}
          onValueChange={value => setActiveTab(value as SubscriptionTabValue)}
          className="w-full"
        >
          <TabsList className="w-full justify-start bg-transparent p-0 h-auto gap-0 rounded-none">
            <TabsTrigger
              value="my_created"
              className="px-4 py-3 rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none hover:bg-transparent"
            >
              {t('tabs_my_created')}
            </TabsTrigger>
            <TabsTrigger
              value="my_following"
              className="px-4 py-3 rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none hover:bg-transparent"
            >
              {t('tabs_my_following')}
            </TabsTrigger>
            <TabsTrigger
              value="shared_to_me"
              className="px-4 py-3 rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none hover:bg-transparent"
            >
              {t('tabs_shared_to_me')}
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-hidden">
        {activeTab === 'my_created' && (
          <SubscriptionList
            onCreateSubscription={handleCreateSubscription}
            onEditSubscription={handleEditSubscription}
          />
        )}
        {activeTab === 'my_following' && <FollowingSubscriptionList followType="direct" />}
        {activeTab === 'shared_to_me' && <FollowingSubscriptionList followType="invited" />}
      </div>

      {/* Form Dialog */}
      <SubscriptionForm
        open={formOpen}
        onOpenChange={setFormOpen}
        subscription={editingSubscription}
        onSuccess={handleFormSuccess}
      />
    </div>
  )
}

export default function SubscriptionsPage() {
  const { t } = useTranslation()
  const router = useRouter()

  // Mobile detection
  const isMobile = useIsMobile()

  // Mobile sidebar state
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false)

  // Collapsed sidebar state
  const [isCollapsed, setIsCollapsed] = useState(false)

  // Load collapsed state from localStorage
  useEffect(() => {
    const savedCollapsed = localStorage.getItem('task-sidebar-collapsed')
    if (savedCollapsed === 'true') {
      setIsCollapsed(true)
    }
  }, [])

  const handleToggleCollapsed = () => {
    setIsCollapsed(prev => {
      const newValue = !prev
      localStorage.setItem('task-sidebar-collapsed', String(newValue))
      return newValue
    })
  }

  // Handle new task from collapsed sidebar button
  const handleNewTask = () => {
    router.push('/chat')
  }

  return (
    <SubscriptionProvider>
      <div className="flex smart-h-screen bg-base text-text-primary box-border">
        {/* Collapsed sidebar floating buttons */}
        {isCollapsed && !isMobile && (
          <CollapsedSidebarButtons onNewTask={handleNewTask} onExpand={handleToggleCollapsed} />
        )}

        {/* Responsive resizable sidebar */}
        <ResizableSidebar isCollapsed={isCollapsed} onToggleCollapsed={handleToggleCollapsed}>
          <TaskSidebar
            isMobileSidebarOpen={isMobileSidebarOpen}
            setIsMobileSidebarOpen={setIsMobileSidebarOpen}
            pageType="flow"
            isCollapsed={isCollapsed}
            onToggleCollapsed={handleToggleCollapsed}
          />
        </ResizableSidebar>

        <div className="flex-1 flex flex-col min-w-0">
          {/* Top navigation */}
          <TopNavigation
            activePage="dashboard"
            variant="with-sidebar"
            title={t('common:navigation.flow')}
            onMobileSidebarToggle={() => setIsMobileSidebarOpen(true)}
            isSidebarCollapsed={isCollapsed}
          >
            <ThemeToggle />
          </TopNavigation>

          {/* Main content area - Subscriptions page content */}
          <div className="flex-1 overflow-hidden">
            <SubscriptionsPageContent />
          </div>
        </div>
      </div>
    </SubscriptionProvider>
  )
}
