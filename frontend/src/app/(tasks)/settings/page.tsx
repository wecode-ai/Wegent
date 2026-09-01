// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { Suspense, useEffect, useMemo, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import TopNavigation from '@/features/layout/TopNavigation'
import GreyTestButton from '@/features/layout/components/GreyTestButton'
import {
  TaskSidebar,
  ResizableSidebar,
  CollapsedSidebarButtons,
} from '@/features/tasks/components/sidebar'
import { SettingsTabNav, SettingsTabId } from '@/features/settings/components/SettingsTabNav'
import IntegrationsPage from '@/features/settings/components/IntegrationsPage'
import NotificationSettings from '@/features/settings/components/NotificationSettings'
import { GroupManager } from '@/features/settings/components/groups/GroupManager'
import PublishedAppsPage from '@wecode/components/settings/PublishedAppsPage'
import DeveloperCredentials from '@/features/settings/components/DeveloperCredentials'
import { PetSettings } from '@/features/pet/components/PetSettings'
import { useTranslation } from '@/hooks/useTranslation'
import { GithubStarButton } from '@/features/layout/GithubStarButton'
import { ThemeToggle } from '@/features/theme/ThemeToggle'
import { useIsMobile } from '@/features/layout/hooks/useMediaQuery'
import { paths } from '@/config/paths'
import '@/app/tasks/tasks.css'
import '@/features/common/scrollbar.css'

const settingsTabs = new Set<SettingsTabId>([
  'general',
  'integrations',
  'api-keys',
  'group-manager',
  'published-apps',
  'pet',
])

function normalizeSettingsTab(tab: string | null): SettingsTabId {
  if (tab && settingsTabs.has(tab as SettingsTabId)) {
    return tab as SettingsTabId
  }
  return 'general'
}

function SettingsContent() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { t } = useTranslation()
  const isMobile = useIsMobile()

  const getInitialTab = (): SettingsTabId => {
    return normalizeSettingsTab(searchParams.get('tab'))
  }

  const [activeTab, setActiveTab] = useState<SettingsTabId>(getInitialTab)

  // Sync state with URL parameters.
  useEffect(() => {
    const mappedTab = normalizeSettingsTab(searchParams.get('tab'))
    if (mappedTab !== activeTab) {
      setActiveTab(mappedTab)
    }
  }, [activeTab, searchParams])

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

  const handleNewTask = () => {
    router.replace(paths.chat.getHref())
  }

  const handleTabChange = (tab: SettingsTabId) => {
    setActiveTab(tab)
    router.replace(`?tab=${tab}`)
  }

  const currentComponent = useMemo(() => {
    switch (activeTab) {
      case 'group-manager':
        return <GroupManager />
      case 'integrations':
        return <IntegrationsPage />
      case 'general':
        return <NotificationSettings />
      case 'api-keys':
        return <DeveloperCredentials />
      case 'published-apps':
        return <PublishedAppsPage />
      case 'pet':
        return <PetSettings />
      default:
        return <NotificationSettings />
    }
  }, [activeTab])

  return (
    <div className="flex smart-h-screen bg-base text-text-primary box-border">
      {/* Collapsed sidebar floating buttons */}
      {isCollapsed && !isMobile && (
        <CollapsedSidebarButtons onExpand={handleToggleCollapsed} onNewTask={handleNewTask} />
      )}

      {/* Resizable sidebar with TaskSidebar */}
      <ResizableSidebar isCollapsed={isCollapsed} onToggleCollapsed={handleToggleCollapsed}>
        <TaskSidebar
          isMobileSidebarOpen={isMobileSidebarOpen}
          setIsMobileSidebarOpen={setIsMobileSidebarOpen}
          pageType="chat"
          isCollapsed={isCollapsed}
          onToggleCollapsed={handleToggleCollapsed}
        />
      </ResizableSidebar>

      {/* Main content area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top navigation */}
        <TopNavigation
          activePage="dashboard"
          variant="with-sidebar"
          title={t('common:settings.title')}
          onMobileSidebarToggle={() => setIsMobileSidebarOpen(true)}
          isSidebarCollapsed={isCollapsed}
        >
          <GreyTestButton />
          {isMobile ? <ThemeToggle /> : <GithubStarButton />}
        </TopNavigation>

        {/* Tab navigation */}
        <SettingsTabNav activeTab={activeTab} onTabChange={handleTabChange} />

        {/* Settings content area */}
        <div className="flex-1 overflow-y-auto px-4 py-4 md:px-8 md:py-6">{currentComponent}</div>
      </div>
    </div>
  )
}

export default function SettingsPage() {
  return (
    <Suspense fallback={<div>Loading...</div>}>
      <SettingsContent />
    </Suspense>
  )
}
