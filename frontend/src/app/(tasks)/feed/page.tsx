// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { Settings, Bell } from 'lucide-react'
import TopNavigation from '@/features/layout/TopNavigation'
import {
  TaskSidebar,
  ResizableSidebar,
  CollapsedSidebarButtons,
} from '@/features/tasks/components/sidebar'
import { SubscriptionPage as SubscriptionPageContent } from '@/features/feed/components'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import '@/app/tasks/tasks.css'
import '@/features/common/scrollbar.css'
import { useIsMobile } from '@/features/layout/hooks/useMediaQuery'
import { useTranslation } from '@/hooks/useTranslation'
import { subscriptionApis } from '@/apis/subscription'

/**
 * Subscription Page with Sidebar
 *
 * Main page for Subscription (订阅) module with left sidebar.
 * Allows users to configure automated task triggers and view execution results.
 */
export default function SubscriptionPage() {
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

  // Handle go to subscriptions settings
  const handleGoToSubscriptions = () => {
    router.push('/feed/subscriptions')
  }

  // Handle go to invitations
  const handleGoToInvitations = () => {
    router.push('/feed/invitations')
  }

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

  return (
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
          <Button
            variant="outline"
            size="sm"
            onClick={handleGoToInvitations}
            className="h-9 gap-1.5 relative"
          >
            <Bell className="h-4 w-4" />
            {t('feed:invitations')}
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
          <Button
            variant="outline"
            size="sm"
            className="h-9 gap-1.5"
            onClick={handleGoToSubscriptions}
          >
            <Settings className="h-4 w-4" />
            {t('feed:feed.manage')}
          </Button>
        </TopNavigation>

        {/* Main content area - Subscription page content */}
        <div className="flex-1 overflow-hidden">
          <SubscriptionPageContent />
        </div>
      </div>
    </div>
  )
}
