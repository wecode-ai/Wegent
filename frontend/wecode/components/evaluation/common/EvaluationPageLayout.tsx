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

  if (isMobile) {
    return (
      <div className="flex h-dvh flex-col bg-base text-text-primary">
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
    <div className="flex h-dvh overflow-hidden bg-base text-text-primary">
      {isSidebarCollapsed ? (
        <CollapsedSidebarButtons
          onExpand={() => setIsSidebarCollapsed(false)}
          onNewTask={() => {}}
        />
      ) : (
        <ResizableSidebar
          minWidth={220}
          maxWidth={400}
          defaultWidth={280}
          storageKey="evaluation-sidebar-width"
        >
          <TaskSidebar
            isMobileSidebarOpen={isMobileSidebarOpen}
            setIsMobileSidebarOpen={setIsMobileSidebarOpen}
            pageType="evaluation"
            isCollapsed={isSidebarCollapsed}
            onToggleCollapsed={() => setIsSidebarCollapsed(!isSidebarCollapsed)}
          />
        </ResizableSidebar>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <TopNavigation activePage="evaluation" />
        <main className="flex-1 overflow-auto">{children}</main>
      </div>
    </div>
  )
}
