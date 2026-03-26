// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import {
  TaskSidebar,
  ResizableSidebar,
  CollapsedSidebarButtons,
} from '@/features/tasks/components/sidebar'
import { InboxProvider, InboxPage as InboxPageContent } from '@/features/inbox'
import { useIsMobile } from '@/features/layout/hooks/useMediaQuery'
import '@/app/tasks/tasks.css'
import '@/features/common/scrollbar.css'

/**
 * Inbox Page with Sidebar
 *
 * Main page for Work Queue module with left sidebar.
 * Allows users to view and manage forwarded messages.
 */
export default function InboxPage() {
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
    <InboxProvider>
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
            pageType="inbox"
            isCollapsed={isCollapsed}
            onToggleCollapsed={handleToggleCollapsed}
          />
        </ResizableSidebar>

        {/* Main content area - Inbox page content */}
        <div className="flex-1 overflow-hidden">
          <InboxPageContent />
        </div>
      </div>
    </InboxProvider>
  )
}
