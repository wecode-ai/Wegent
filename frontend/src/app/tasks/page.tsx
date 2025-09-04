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

export default function TasksPage() {
  // Team state from service
  const { teams, isTeamsLoading } = teamService.useTeams()

  return (
    <UserProvider>
      <TaskContextProvider>
        <Suspense>
          <TaskParamSync />
        </Suspense>
          {/* 新手引导弹窗 */}
          <BeginnerGuideModal
            teams={teams}
            teamLoading={isTeamsLoading}
          />
          <div className="flex h-screen bg-[#0d1117] text-white">
            {/* 左侧边栏 */}
            <TaskSidebar />
            {/* 主内容区 */}
            <div className="flex-1 flex flex-col">
              {/* 顶部导航 */}
              <TopNavigation activePage="tasks" showLogo={false}>
                <UserMenu position="right-10" />
              </TopNavigation>
              {/* 聊天区 */}
              <ChatArea teams={teams} isTeamsLoading={isTeamsLoading} />
            </div>
          </div>
      </TaskContextProvider>
    </UserProvider>
  )
}
