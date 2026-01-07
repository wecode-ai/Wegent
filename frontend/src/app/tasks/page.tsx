// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { Suspense, useState } from 'react'
import { teamService } from '@/features/tasks/service/teamService'
import TopNavigation from '@/features/layout/TopNavigation'
import { TaskSidebar } from '@/features/tasks/components/sidebar'
import { TaskParamSync } from '@/features/tasks/components/params'
import { TeamShareHandler } from '@/features/tasks/components/share'
import OidcTokenHandler from '@/features/login/components/OidcTokenHandler'
import '@/app/tasks/tasks.css'
import '@/features/common/scrollbar.css'
import { GithubStarButton } from '@/features/layout/GithubStarButton'
import { ThemeToggle } from '@/features/theme/ThemeToggle'
import { useIsMobile } from '@/features/layout/hooks/useMediaQuery'
import { Team } from '@/types/api'
import { UserProvider } from '@/features/common/UserContext'
import { TaskContextProvider } from '@/features/tasks/contexts/taskContext'
import { ChatStreamProvider } from '@/features/tasks/contexts/chatStreamContext'
import { SocketProvider } from '@/contexts/SocketContext'
import { ChatArea } from '@/features/tasks/components/chat'

function TasksPageContent() {
  // Team state from service
  const { teams, isTeamsLoading, refreshTeams } = teamService.useTeams()

  // Mobile detection
  const isMobile = useIsMobile()

  // Mobile sidebar state
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false)

  // Selected team state for sharing
  const [selectedTeamForNewTask, setSelectedTeamForNewTask] = useState<Team | null>(null)

  const handleRefreshTeams = async (): Promise<Team[]> => {
    return await refreshTeams()
  }

  return (
    <>
      {/* Handle OIDC token from URL parameters */}
      <OidcTokenHandler />
      <Suspense>
        <TaskParamSync />
      </Suspense>
      <Suspense>
        <TeamShareHandler
          teams={teams}
          onTeamSelected={setSelectedTeamForNewTask}
          onRefreshTeams={handleRefreshTeams}
        />
      </Suspense>
      <div className="flex smart-h-screen bg-base text-text-primary box-border">
        {/* Responsive sidebar */}
        <TaskSidebar
          isMobileSidebarOpen={isMobileSidebarOpen}
          setIsMobileSidebarOpen={setIsMobileSidebarOpen}
          pageType="code"
        />
        {/* Main content area */}
        <div className="flex-1 flex flex-col min-w-0">
          {/* Top navigation */}
          <TopNavigation
            activePage="code"
            showLogo={false}
            onMobileSidebarToggle={() => setIsMobileSidebarOpen(true)}
          >
            {isMobile ? <ThemeToggle /> : <GithubStarButton />}
          </TopNavigation>
          {/* Chat area */}
          <ChatArea
            teams={teams}
            isTeamsLoading={isTeamsLoading}
            selectedTeamForNewTask={selectedTeamForNewTask}
            taskType="code"
          />
        </div>
      </div>
    </>
  )
}

export default function TasksPage() {
  return (
    <UserProvider>
      <SocketProvider>
        <TaskContextProvider>
          <ChatStreamProvider>
            <TasksPageContent />
          </ChatStreamProvider>
        </TaskContextProvider>
      </SocketProvider>
    </UserProvider>
  )
}
