// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { Suspense, useState, useEffect, useMemo, useCallback } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import TopNavigation from '@/features/layout/TopNavigation'
import {
  TaskSidebar,
  ResizableSidebar,
  CollapsedSidebarButtons,
} from '@/features/tasks/components/sidebar'
import { SettingsTabNav, SettingsTabId } from '@/features/settings/components/SettingsTabNav'
import GitHubIntegration from '@/features/settings/components/GitHubIntegration'
import NotificationSettings from '@/features/settings/components/NotificationSettings'
import { GroupManager } from '@/features/settings/components/groups/GroupManager'
import { ModelListWithScope } from '@/features/settings/components/ModelListWithScope'
import { ShellListWithScope } from '@/features/settings/components/ShellListWithScope'
import { SkillListWithScope } from '@/features/settings/components/SkillListWithScope'
import { TeamListWithScope } from '@/features/settings/components/TeamListWithScope'
import ApiKeyList from '@/features/settings/components/ApiKeyList'
import { RetrieverListWithScope } from '@/features/settings/components/RetrieverListWithScope'
import { useTranslation } from '@/hooks/useTranslation'
import { GithubStarButton } from '@/features/layout/GithubStarButton'
import { ThemeToggle } from '@/features/theme/ThemeToggle'
import { useIsMobile } from '@/features/layout/hooks/useMediaQuery'
import { paths } from '@/config/paths'
import '@/app/tasks/tasks.css'
import '@/features/common/scrollbar.css'

function SettingsContent() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { t } = useTranslation()
  const isMobile = useIsMobile()

  // Refresh trigger for SettingsTabNav groups list
  const [groupsRefreshTrigger, setGroupsRefreshTrigger] = useState(0)

  // Get initial tab from URL with backward compatibility
  const getInitialTab = (): SettingsTabId => {
    const tab = searchParams.get('tab')
    const section = searchParams.get('section')

    // Backward compatibility: map old section+tab format to new tab IDs
    if (section && tab) {
      return tab as SettingsTabId
    }

    // Direct tab parameter
    if (tab) {
      // Map old simple tab values to new format
      const tabMap: Record<string, SettingsTabId> = {
        team: 'personal-team',
        models: 'personal-models',
        shells: 'personal-shells',
      }
      return (tabMap[tab] || tab) as SettingsTabId
    }

    // Default to personal-team (智能体) as the entry module
    return 'personal-team'
  }

  const [activeTab, setActiveTab] = useState<SettingsTabId>(getInitialTab)

  // Selected group state for group scope
  const [selectedGroup, setSelectedGroup] = useState<string | null>(() => {
    return searchParams.get('group') || null
  })

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
    router.replace(paths.chat.getHref())
  }

  // Handle tab change
  const handleTabChange = (tab: SettingsTabId) => {
    setActiveTab(tab)
    // Update URL with new tab
    const section = tab.startsWith('personal-')
      ? 'personal'
      : tab.startsWith('group-')
        ? 'groups'
        : tab
    const groupParam = selectedGroup ? `&group=${encodeURIComponent(selectedGroup)}` : ''
    router.replace(`?section=${section}&tab=${tab}${groupParam}`)
  }

  // Handle group change
  const handleGroupChange = useCallback(
    (groupName: string | null) => {
      setSelectedGroup(groupName)
      // Update URL with group parameter
      const section = activeTab.startsWith('personal-')
        ? 'personal'
        : activeTab.startsWith('group-')
          ? 'groups'
          : activeTab
      const groupParam = groupName ? `&group=${encodeURIComponent(groupName)}` : ''
      router.replace(`?section=${section}&tab=${activeTab}${groupParam}`)
    },
    [activeTab, router]
  )

  // Render content based on active tab
  // Render content based on active tab
  const currentComponent = useMemo(() => {
    switch (activeTab) {
      case 'personal-models':
        return <ModelListWithScope scope="personal" />
      case 'personal-shells':
        return <ShellListWithScope scope="personal" />
      case 'personal-skills':
        return <SkillListWithScope scope="personal" />
      case 'personal-team':
        return <TeamListWithScope scope="personal" />
      case 'personal-retrievers':
        return <RetrieverListWithScope scope="personal" />
      case 'group-manager':
        return <GroupManager onGroupsChange={() => setGroupsRefreshTrigger(prev => prev + 1)} />
      case 'group-models':
        return (
          <ModelListWithScope
            scope="group"
            selectedGroup={selectedGroup}
            onGroupChange={setSelectedGroup}
          />
        )
      case 'group-shells':
        return (
          <ShellListWithScope
            scope="group"
            selectedGroup={selectedGroup}
            onGroupChange={setSelectedGroup}
          />
        )
      case 'group-skills':
        return (
          <SkillListWithScope
            scope="group"
            selectedGroup={selectedGroup}
            onGroupChange={setSelectedGroup}
          />
        )
      case 'group-team':
        return (
          <TeamListWithScope
            scope="group"
            selectedGroup={selectedGroup}
            onGroupChange={setSelectedGroup}
          />
        )
      case 'group-retrievers':
        return (
          <RetrieverListWithScope
            scope="group"
            selectedGroup={selectedGroup}
            onGroupChange={setSelectedGroup}
          />
        )
      case 'integrations':
        return <GitHubIntegration />
      case 'general':
        return <NotificationSettings />
      case 'api-keys':
        return <ApiKeyList />
      default:
        // Default to personal-team (智能体)
        return <TeamListWithScope scope="personal" />
    }
  }, [activeTab, selectedGroup])
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
          {isMobile ? <ThemeToggle /> : <GithubStarButton />}
        </TopNavigation>

        {/* Tab navigation */}
        <SettingsTabNav
          activeTab={activeTab}
          onTabChange={handleTabChange}
          selectedGroup={selectedGroup}
          onGroupChange={handleGroupChange}
          refreshTrigger={groupsRefreshTrigger}
        />

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
