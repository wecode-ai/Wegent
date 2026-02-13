// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { ReactNode, useState } from 'react'
import { useIsMobile } from '@/features/layout/hooks/useMediaQuery'
import {
  TaskSidebar,
  ResizableSidebar,
  CollapsedSidebarButtons,
} from '@/features/tasks/components/sidebar'
import TopNavigation from '@/features/layout/TopNavigation'
import '@/app/tasks/tasks.css'
import '@/features/common/scrollbar.css'

interface EvaluationPageLayoutProps {
  children: ReactNode
}

/**
 * Shared layout component for evaluation pages.
 * Provides consistent sidebar and navigation across all evaluation routes.
 */
export function EvaluationPageLayout({ children }: EvaluationPageLayoutProps) {
  const isMobile = useIsMobile()
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false)
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false)

  const handleToggleCollapsed = () => {
    setIsSidebarCollapsed(!isSidebarCollapsed)
  }

  if (isMobile) {
    return (
      <div className="flex smart-h-screen flex-col bg-base text-text-primary box-border">
        <TaskSidebar
          isMobileSidebarOpen={isMobileSidebarOpen}
          setIsMobileSidebarOpen={setIsMobileSidebarOpen}
          pageType="evaluation"
        />
        <div className="flex-1 overflow-auto">{children}</div>
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
        <TopNavigation activePage="evaluation" />
        <main className="flex-1 overflow-auto">{children}</main>
      </div>
    </div>
  )
}
