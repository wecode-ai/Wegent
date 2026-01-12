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
import { FlowList, FlowForm } from '@/features/flows/components'
import { FlowProvider, useFlowContext } from '@/features/flows/contexts/flowContext'
import { Button } from '@/components/ui/button'
import '@/app/tasks/tasks.css'
import '@/features/common/scrollbar.css'
import { useIsMobile } from '@/features/layout/hooks/useMediaQuery'
import { useTranslation } from '@/hooks/useTranslation'
import { ThemeToggle } from '@/features/theme/ThemeToggle'
import type { Flow } from '@/types/flow'

/**
 * Flow Subscriptions Management Page
 *
 * Page for managing flow subscriptions (我的订阅).
 */
function SubscriptionsPageContent() {
  const { t } = useTranslation('flow')
  const router = useRouter()
  const { refreshFlows, refreshExecutions } = useFlowContext()

  // Form state
  const [formOpen, setFormOpen] = useState(false)
  const [editingFlow, setEditingFlow] = useState<Flow | null>(null)

  const handleCreateFlow = useCallback(() => {
    setEditingFlow(null)
    setFormOpen(true)
  }, [])

  const handleEditFlow = useCallback((flow: Flow) => {
    setEditingFlow(flow)
    setFormOpen(true)
  }, [])

  const handleFormSuccess = useCallback(() => {
    refreshFlows()
    refreshExecutions()
  }, [refreshFlows, refreshExecutions])

  const handleBack = () => {
    router.push('/flow')
  }

  return (
    <div className="flex h-full flex-col bg-base">
      {/* Back button header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-border bg-white">
        <Button variant="ghost" size="icon" className="h-9 w-9" onClick={handleBack}>
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <h1 className="text-lg font-semibold">{t('my_flows')}</h1>
      </div>

      {/* Flow list */}
      <div className="flex-1 overflow-hidden">
        <FlowList onCreateFlow={handleCreateFlow} onEditFlow={handleEditFlow} />
      </div>

      {/* Form Dialog */}
      <FlowForm
        open={formOpen}
        onOpenChange={setFormOpen}
        flow={editingFlow}
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
    <FlowProvider>
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
    </FlowProvider>
  )
}
