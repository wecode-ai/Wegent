// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { Suspense, useState, useCallback, useEffect, useMemo } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import dynamic from 'next/dynamic'
import Link from 'next/link'
import TopNavigation from '@/features/layout/TopNavigation'
import { TaskSidebar, ResizableSidebar } from '@/features/tasks/components/sidebar'
import { AdminTabNav } from '@/features/admin/components/AdminTabNav'
import type { AdminTabId } from '@/features/admin/components/AdminTabNav'
import { ShieldExclamationIcon } from '@heroicons/react/24/outline'
import { UserProvider, useUser } from '@/features/common/UserContext'
import { TaskSessionProvider } from '@/features/tasks/session/TaskSession'
import { SocketProvider } from '@/contexts/SocketContext'
import { DeviceProvider } from '@/contexts/DeviceContext'
import { ProjectProvider } from '@/features/projects/contexts/projectContext'
import { useTranslation } from '@/hooks/useTranslation'
import { GithubStarButton } from '@/features/layout/GithubStarButton'
import { ThemeToggle } from '@/features/theme/ThemeToggle'
import { useIsMobile } from '@/features/layout/hooks/useMediaQuery'
import { Button } from '@/components/ui/button'
import '@/app/tasks/tasks.css'
import '@/features/common/scrollbar.css'

const UserList = dynamic(() => import('@/features/admin/components/UserList'), { ssr: false })
const PublicModelList = dynamic(() => import('@/features/admin/components/PublicModelList'), {
  ssr: false,
})
const PublicRetrieverList = dynamic(
  () => import('@/features/admin/components/PublicRetrieverList'),
  { ssr: false }
)
const PublicSkillList = dynamic(() => import('@/features/admin/components/PublicSkillList'), {
  ssr: false,
})
const SystemPluginList = dynamic(() => import('@/features/admin/components/SystemPluginList'), {
  ssr: false,
})
const PublicGhostList = dynamic(() => import('@/features/admin/components/PublicGhostList'), {
  ssr: false,
})
const PublicShellList = dynamic(() => import('@/features/admin/components/PublicShellList'), {
  ssr: false,
})
const PublicTeamList = dynamic(() => import('@/features/admin/components/PublicTeamList'), {
  ssr: false,
})
const PublicBotList = dynamic(() => import('@/features/admin/components/PublicBotList'), {
  ssr: false,
})
const TemplateList = dynamic(() => import('@/features/admin/components/TemplateList'), {
  ssr: false,
})
const ApiKeyManagement = dynamic(() => import('@/features/admin/components/ApiKeyManagement'), {
  ssr: false,
})
const SystemConfigPanel = dynamic(() => import('@/features/admin/components/SystemConfigPanel'), {
  ssr: false,
})
const BackgroundExecutionMonitorPanel = dynamic(
  () => import('@/features/admin/components/BackgroundExecutionMonitorPanel'),
  { ssr: false }
)
const DeviceMonitorPanel = dynamic(() => import('@/features/admin/components/DeviceMonitorPanel'), {
  ssr: false,
})
const IMChannelList = dynamic(() => import('@/features/admin/components/IMChannelList'), {
  ssr: false,
})
const GlobalAdminSetupWizard = dynamic(
  () => import('@/features/admin/components/GlobalAdminSetupWizard'),
  { ssr: false }
)

function AccessDenied() {
  const { t } = useTranslation()

  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] text-center px-4">
      <ShieldExclamationIcon className="w-16 h-16 text-text-muted mb-4" />
      <h1 className="text-2xl font-semibold text-text-primary mb-2">
        {t('admin:access_denied.title')}
      </h1>
      <p className="text-text-muted mb-6 max-w-md">{t('admin:access_denied.message')}</p>
      <Link href="/">
        <Button>{t('admin:access_denied.go_home')}</Button>
      </Link>
    </div>
  )
}

function AdminContent() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { t } = useTranslation()
  const { user, isLoading } = useUser()
  const isMobile = useIsMobile()

  // Check if user is admin
  const isAdmin = user?.role === 'admin'

  // Get initial tab from URL
  const getInitialTab = (): AdminTabId => {
    const tab = searchParams.get('tab')
    if (
      tab &&
      [
        'users',
        'public-models',
        'public-retrievers',
        'public-skills',
        'plugins',
        'public-ghosts',
        'public-shells',
        'public-teams',
        'public-bots',
        'templates',
        'api-keys',
        'system-config',
        'im-channels',
        'monitor',
        'device-monitor',
      ].includes(tab)
    ) {
      return tab as AdminTabId
    }
    return 'users'
  }

  const [activeTab, setActiveTab] = useState<AdminTabId>(getInitialTab)

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

  // Handle tab change
  const handleTabChange = useCallback(
    (tab: AdminTabId) => {
      setActiveTab(tab)
      router.replace(`?tab=${tab}`)
    },
    [router]
  )

  // Render content based on active tab
  const currentComponent = useMemo(() => {
    switch (activeTab) {
      case 'users':
        return <UserList />
      case 'public-models':
        return <PublicModelList />
      case 'public-retrievers':
        return <PublicRetrieverList />
      case 'public-skills':
        return <PublicSkillList />
      case 'plugins':
        return <SystemPluginList />
      case 'public-ghosts':
        return <PublicGhostList />
      case 'public-shells':
        return <PublicShellList />
      case 'public-teams':
        return <PublicTeamList />
      case 'public-bots':
        return <PublicBotList />
      case 'templates':
        return <TemplateList />
      case 'api-keys':
        return <ApiKeyManagement />
      case 'system-config':
        return <SystemConfigPanel />
      case 'im-channels':
        return <IMChannelList />
      case 'monitor':
        return <BackgroundExecutionMonitorPanel />
      case 'device-monitor':
        return <DeviceMonitorPanel />
      default:
        return <UserList />
    }
  }, [activeTab])

  // Show loading state
  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    )
  }

  // Show access denied if not admin
  if (!isAdmin) {
    return (
      <div className="flex smart-h-screen bg-base text-text-primary box-border">
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
          <TopNavigation
            activePage="dashboard"
            variant="with-sidebar"
            title={t('admin:title')}
            onMobileSidebarToggle={() => setIsMobileSidebarOpen(true)}
          >
            {isMobile ? <ThemeToggle /> : <GithubStarButton />}
          </TopNavigation>
          <AccessDenied />
        </div>
      </div>
    )
  }

  return (
    <div className="flex smart-h-screen bg-base text-text-primary box-border">
      {/* Admin Setup Wizard */}
      <GlobalAdminSetupWizard />

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
          title={t('admin:title')}
          onMobileSidebarToggle={() => setIsMobileSidebarOpen(true)}
        >
          {isMobile ? <ThemeToggle /> : <GithubStarButton />}
        </TopNavigation>

        {/* Tab navigation */}
        <AdminTabNav activeTab={activeTab} onTabChange={handleTabChange} />

        {/* Admin content area */}
        <div className="flex-1 overflow-y-auto px-4 py-4 md:px-8 md:py-6">{currentComponent}</div>
      </div>
    </div>
  )
}

export default function AdminPage() {
  return (
    <UserProvider>
      <SocketProvider>
        <DeviceProvider>
          <ProjectProvider>
            <TaskSessionProvider>
              <Suspense fallback={<div>Loading...</div>}>
                <AdminContent />
              </Suspense>
            </TaskSessionProvider>
          </ProjectProvider>
        </DeviceProvider>
      </SocketProvider>
    </UserProvider>
  )
}
