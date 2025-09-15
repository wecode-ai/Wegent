// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { Suspense} from 'react'
import { UserProvider } from '@/features/common/UserContext'
import { TaskContextProvider } from '@/features/tasks/contexts/taskContext'
import { teamService } from '@/features/tasks/service/teamService'
import TopNavigation from '@/features/layout/TopNavigation'
import UserMenu from '@/features/layout/UserMenu'
import TaskSidebar from '@/features/tasks/components/TaskSidebar'
import BeginnerGuideModal from '@/features/tasks/components/BeginnerGuideModal'
import ChatArea from '@/features/tasks/components/ChatArea'
import TaskParamSync from '@/features/tasks/components/TaskParamSync'
import '@/app/tasks/tasks.css'
import '@/features/common/scrollbar.css'

export default function TasksPage() {
  // Team state from service
  const { teams, isTeamsLoading } = teamService.useTeams()

  return (
    <UserProvider>
      <TaskContextProvider>
        <Suspense>
          <TaskParamSync />
        </Suspense>
          {/* Beginner guide modal */}
          <BeginnerGuideModal
            teams={teams}
            teamLoading={isTeamsLoading}
          />
          <div className="flex h-screen bg-[#0d1117] text-white">
            {/* Left sidebar */}
            <TaskSidebar />
            {/* Main content area */}
            <div className="flex-1 flex flex-col">
              {/* Top navigation */}
              <TopNavigation activePage="tasks" showLogo={false}>
                <UserMenu position="right-10" />
              </TopNavigation>
              {/* Chat area */}
              <ChatArea teams={teams} isTeamsLoading={isTeamsLoading} />
            </div>
          </div>
      </TaskContextProvider>
    </UserProvider>
  )
}
