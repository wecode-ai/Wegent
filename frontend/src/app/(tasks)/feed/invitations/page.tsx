// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
import TopNavigation from '@/features/layout/TopNavigation'
import {
  TaskSidebar,
  ResizableSidebar,
  CollapsedSidebarButtons,
} from '@/features/tasks/components/sidebar'
import { SubscriptionInvitations } from '@/features/feed/components'
import { Button } from '@/components/ui/button'
import '@/app/tasks/tasks.css'
import '@/features/common/scrollbar.css'
import { useIsMobile } from '@/features/layout/hooks/useMediaQuery'
import { useTranslation } from '@/hooks/useTranslation'

/**
 * Flow Invitations Page
 *
 * Page for viewing and managing subscription invitations.
 */
function InvitationsPageContent() {
  const { t } = useTranslation('feed')
  const router = useRouter()

  const handleBack = () => {
    router.push('/feed')
  }

  const handleInvitationHandled = useCallback(() => {
    // Optionally refresh or navigate after handling invitation
  }, [])

  return (
    <div className="flex h-full flex-col bg-base">
      {/* Back button header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-base">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" className="h-9 w-9" onClick={handleBack}>
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <h1 className="text-lg font-semibold">{t('invitations')}</h1>
        </div>
      </div>

      {/* Invitations list */}
      <div className="flex-1 overflow-auto p-4">
        <SubscriptionInvitations onInvitationHandled={handleInvitationHandled} />
      </div>
    </div>
  )
}

export default function InvitationsPage() {
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
        />

        {/* Main content area - Invitations page content */}
        <div className="flex-1 overflow-hidden">
          <InvitationsPageContent />
        </div>
      </div>
    </div>
  )
}
