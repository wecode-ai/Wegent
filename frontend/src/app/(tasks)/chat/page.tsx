// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import { Suspense, useState, useEffect } from 'react';
import { useSearchParams } from 'next/navigation';
import { teamService } from '@/features/tasks/service/teamService';
import TopNavigation from '@/features/layout/TopNavigation';
import UserMenu from '@/features/layout/UserMenu';
import TaskSidebar from '@/features/tasks/components/TaskSidebar';
import ResizableSidebar from '@/features/tasks/components/ResizableSidebar';
import OnboardingTour from '@/features/onboarding/OnboardingTour';
import TaskParamSync from '@/features/tasks/components/TaskParamSync';
import TeamShareHandler from '@/features/tasks/components/TeamShareHandler';
import OidcTokenHandler from '@/features/login/components/OidcTokenHandler';
import '@/app/tasks/tasks.css';
import '@/features/common/scrollbar.css';
import { GithubStarButton } from '@/features/layout/GithubStarButton';
import { Team } from '@/types/api';
import ChatArea from '@/features/tasks/components/ChatArea';
import { saveLastTab } from '@/utils/userPreferences';
import { useUser } from '@/features/common/UserContext';

export default function ChatPage() {
  // Team state from service
  const { teams, isTeamsLoading, refreshTeams } = teamService.useTeams();

  // User state for git token check
  const { user } = useUser();

  // Check for share_id in URL
  const searchParams = useSearchParams();
  const hasShareId = !!searchParams.get('share_id');

  // Mobile sidebar state
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false);

  // Selected team state for sharing
  const [selectedTeamForNewTask, setSelectedTeamForNewTask] = useState<Team | null>(null);

  // Check if user has git token
  const hasGitToken = !!(user?.git_info && user.git_info.length > 0);

  // Save last active tab to localStorage
  useEffect(() => {
    saveLastTab('chat');
  }, []);

  const handleRefreshTeams = async (): Promise<Team[]> => {
    return await refreshTeams();
  };

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
      {/* Onboarding tour */}
      <OnboardingTour
        hasTeams={teams.length > 0}
        hasGitToken={hasGitToken}
        currentPage="chat"
        isLoading={isTeamsLoading}
        hasShareId={hasShareId}
      />
      <div className="flex smart-h-screen bg-base text-text-primary box-border">
        {/* Responsive resizable sidebar */}
        <ResizableSidebar>
          <TaskSidebar
            isMobileSidebarOpen={isMobileSidebarOpen}
            setIsMobileSidebarOpen={setIsMobileSidebarOpen}
            pageType="chat"
          />
        </ResizableSidebar>
        {/* Main content area */}
        <div className="flex-1 flex flex-col min-w-0">
          {/* Top navigation */}
          <TopNavigation
            activePage="chat"
            variant="with-sidebar"
            onMobileSidebarToggle={() => setIsMobileSidebarOpen(true)}
          >
            <GithubStarButton />
            <UserMenu />
          </TopNavigation>
          {/* Chat area without repository selector */}
          <ChatArea
            teams={teams}
            isTeamsLoading={isTeamsLoading}
            selectedTeamForNewTask={selectedTeamForNewTask}
            showRepositorySelector={false}
            taskType="chat"
          />
        </div>
      </div>
    </>
  );
}
