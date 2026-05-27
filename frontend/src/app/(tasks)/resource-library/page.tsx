// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'

import '@/app/tasks/tasks.css'
import '@/features/common/scrollbar.css'
import { paths } from '@/config/paths'
import ResourceLibraryPage from '@/features/resource-library/ResourceLibraryPage'
import { useIsMobile } from '@/features/layout/hooks/useMediaQuery'
import TopNavigation from '@/features/layout/TopNavigation'
import {
  CollapsedSidebarButtons,
  ResizableSidebar,
  TaskSidebar,
} from '@/features/tasks/components/sidebar'
import { useChatStreamContext } from '@/features/tasks/contexts/chatStreamContext'
import { useTaskContext } from '@/features/tasks/contexts/taskContext'
import { useTranslation } from '@/hooks/useTranslation'

export default function Page() {
  const router = useRouter()
  const isMobile = useIsMobile()
  const { t } = useTranslation('resource-library')
  const { clearAllStreams } = useChatStreamContext()
  const { setSelectedTask } = useTaskContext()
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false)
  const [isCollapsed, setIsCollapsed] = useState(false)

  useEffect(() => {
    const savedCollapsed = localStorage.getItem('task-sidebar-collapsed')
    if (savedCollapsed === 'true') {
      setIsCollapsed(true)
    }
  }, [])

  const handleToggleCollapsed = () => {
    setIsCollapsed(prev => {
      const nextValue = !prev
      localStorage.setItem('task-sidebar-collapsed', String(nextValue))
      return nextValue
    })
  }

  const handleNewTask = () => {
    setSelectedTask(null)
    clearAllStreams()
    router.replace(paths.chat.getHref())
  }

  return (
    <div className="flex smart-h-screen bg-base text-text-primary box-border">
      {isCollapsed && !isMobile && (
        <CollapsedSidebarButtons onExpand={handleToggleCollapsed} onNewTask={handleNewTask} />
      )}

      <ResizableSidebar isCollapsed={isCollapsed} onToggleCollapsed={handleToggleCollapsed}>
        <TaskSidebar
          isMobileSidebarOpen={isMobileSidebarOpen}
          setIsMobileSidebarOpen={setIsMobileSidebarOpen}
          pageType="resource-library"
          isCollapsed={isCollapsed}
          onToggleCollapsed={handleToggleCollapsed}
        />
      </ResizableSidebar>

      <div className="flex min-w-0 flex-1 flex-col">
        <TopNavigation
          variant="with-sidebar"
          title={t('title')}
          onMobileSidebarToggle={() => setIsMobileSidebarOpen(true)}
          isSidebarCollapsed={isCollapsed}
        />
        <div className="min-h-0 flex-1 overflow-hidden">
          <ResourceLibraryPage />
        </div>
      </div>
    </div>
  )
}
