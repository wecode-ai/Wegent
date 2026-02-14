// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { ReactNode, useState, useEffect } from 'react'
import { useIsMobile } from '@/features/layout/hooks/useMediaQuery'
import {
  TaskSidebar,
  ResizableSidebar,
  CollapsedSidebarButtons,
} from '@/features/tasks/components/sidebar'
import TopNavigation from '@/features/layout/TopNavigation'
import { ThemeToggle } from '@/features/theme/ThemeToggle'
import { GithubStarButton } from '@/features/layout/GithubStarButton'
import { useTranslation } from '@/hooks/useTranslation'
import '@/app/tasks/tasks.css'
import '@/features/common/scrollbar.css'

interface EvaluationPageLayoutProps {
  children: ReactNode
  /** Optional page title to display in TopNavigation */
  title?: string
}

/**
 * Shared layout component for evaluation pages.
 * Provides consistent sidebar and navigation across all evaluation routes.
 *
 * Follows the same pattern as other pages (chat, devices) for mobile support:
 * - Mobile: TopNavigation with sidebar toggle button
 * - Desktop: ResizableSidebar with collapsible state
 */
export function EvaluationPageLayout({ children, title }: EvaluationPageLayoutProps) {
  const isMobile = useIsMobile()
  const { t } = useTranslation('evaluation')
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false)
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false)

  // Load collapsed state from localStorage
  useEffect(() => {
    const savedCollapsed = localStorage.getItem('task-sidebar-collapsed')
    if (savedCollapsed === 'true') {
      setIsSidebarCollapsed(true)
    }
  }, [])

  const handleToggleCollapsed = () => {
    setIsSidebarCollapsed(prev => {
      const newValue = !prev
      localStorage.setItem('task-sidebar-collapsed', String(newValue))
      return newValue
    })
  }

  if (isMobile) {
    return (
      <div className="flex smart-h-screen flex-col bg-base text-text-primary box-border">
        {/* Mobile sidebar - use TaskSidebar's built-in MobileSidebar component */}
        <TaskSidebar
          isMobileSidebarOpen={isMobileSidebarOpen}
          setIsMobileSidebarOpen={setIsMobileSidebarOpen}
          pageType="evaluation"
          isCollapsed={false}
          onToggleCollapsed={() => {}}
        />
        {/* Main content area */}
        <div className="flex-1 flex flex-col min-w-0">
          {/* Top navigation - mobile optimized with sidebar toggle */}
          <TopNavigation
            activePage="evaluation"
            variant="with-sidebar"
            title={title || t('title')}
            onMobileSidebarToggle={() => setIsMobileSidebarOpen(true)}
            isSidebarCollapsed={false}
          >
            <ThemeToggle />
          </TopNavigation>
          <main className="flex-1 overflow-auto">{children}</main>
        </div>
      </div>
    )
  }

  return (
    <div className="flex smart-h-screen bg-base text-text-primary box-border">
      {/* Collapsed sidebar floating buttons */}
      {isSidebarCollapsed && (
        <CollapsedSidebarButtons onExpand={handleToggleCollapsed} onNewTask={() => {}} />
      )}
      {/* Responsive resizable sidebar */}
      <ResizableSidebar isCollapsed={isSidebarCollapsed} onToggleCollapsed={handleToggleCollapsed}>
        <TaskSidebar
          isMobileSidebarOpen={false}
          setIsMobileSidebarOpen={() => {}}
          pageType="evaluation"
          isCollapsed={isSidebarCollapsed}
          onToggleCollapsed={handleToggleCollapsed}
        />
      </ResizableSidebar>
      {/* Main content area */}
      <div className="flex-1 flex flex-col min-w-0">
        <TopNavigation
          activePage="evaluation"
          variant="with-sidebar"
          title={title || t('title')}
          onMobileSidebarToggle={() => setIsMobileSidebarOpen(true)}
          isSidebarCollapsed={isSidebarCollapsed}
        >
          <GithubStarButton />
        </TopNavigation>
        <main className="flex-1 overflow-auto">{children}</main>
      </div>
    </div>
  )
}
