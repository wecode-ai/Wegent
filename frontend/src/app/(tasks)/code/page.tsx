// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import { Suspense, useState, useEffect, useMemo } from 'react';
import { useSearchParams } from 'next/navigation';
import { teamService } from '@/features/tasks/service/teamService';
import TopNavigation from '@/features/layout/TopNavigation';
import UserMenu from '@/features/layout/UserMenu';
import TaskSidebar from '@/features/tasks/components/TaskSidebar';
import ResizableSidebar from '@/features/tasks/components/ResizableSidebar';
import BeginnerGuideModal from '@/features/tasks/components/BeginnerGuideModal';
import ChatArea from '@/features/tasks/components/ChatArea';
import TaskParamSync from '@/features/tasks/components/TaskParamSync';
import TeamShareHandler from '@/features/tasks/components/TeamShareHandler';
import OidcTokenHandler from '@/features/login/components/OidcTokenHandler';
import Workbench from '@/features/tasks/components/Workbench';
import WorkbenchToggle from '@/features/layout/WorkbenchToggle';
import OpenMenu from '@/features/tasks/components/OpenMenu';
import '@/app/tasks/tasks.css';
import '@/features/common/scrollbar.css';
import { GithubStarButton } from '@/features/layout/GithubStarButton';
import { Team } from '@/types/api';
import { useTaskContext } from '@/features/tasks/contexts/taskContext';
import { saveLastTab } from '@/utils/userPreferences';
import { useIsMobile } from '@/features/layout/hooks/useMediaQuery';
import { calculateOpenLinks } from '@/utils/openLinks';

export default function CodePage() {
  // Get search params to check for taskId
  const searchParams = useSearchParams();
  const taskId = searchParams.get('taskId');
  const hasTaskId = !!taskId;

  // Team state from service
  const { teams, isTeamsLoading, refreshTeams } = teamService.useTeams();

  // Task context for workbench data
  const { selectedTaskDetail } = useTaskContext();

  // Mobile sidebar state
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false);

  // Selected team state for sharing
  const [selectedTeamForNewTask, setSelectedTeamForNewTask] = useState<Team | null>(null);

  // Workbench state - only open if there's a taskId
  const [isWorkbenchOpen, setIsWorkbenchOpen] = useState(hasTaskId);

  // Mobile detection
  const isMobile = useIsMobile();

  // Determine if workbench should show loading state
  const isWorkbenchLoading =
    hasTaskId &&
    !selectedTaskDetail?.workbench &&
    selectedTaskDetail?.status !== 'COMPLETED' &&
    selectedTaskDetail?.status !== 'FAILED' &&
    selectedTaskDetail?.status !== 'CANCELLED';

  // Calculate open links from task detail
  const openLinks = useMemo(() => {
    return calculateOpenLinks(selectedTaskDetail);
  }, [selectedTaskDetail]);

  // Save last active tab to localStorage
  useEffect(() => {
    saveLastTab('code');
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
      {/* Beginner guide modal */}
      <BeginnerGuideModal teams={teams} teamLoading={isTeamsLoading} />
      <div className="flex smart-h-screen bg-base text-text-primary box-border">
        {/* Responsive resizable sidebar - fixed, not affected by right panel */}
        <ResizableSidebar>
          <TaskSidebar
            isMobileSidebarOpen={isMobileSidebarOpen}
            setIsMobileSidebarOpen={setIsMobileSidebarOpen}
            pageType="code"
          />
        </ResizableSidebar>
        {/* Main content area with right panel*/}
        <div className="flex-1 flex flex-col min-w-0">
          {/* Top navigation - fixed, not affected by right panel*/}
          <TopNavigation
            activePage="code"
            variant="with-sidebar"
            onMobileSidebarToggle={() => setIsMobileSidebarOpen(true)}
          >
            <GithubStarButton />
            <UserMenu />
            {hasTaskId && <OpenMenu openLinks={openLinks} />}
            {hasTaskId && (
              <WorkbenchToggle
                isOpen={isWorkbenchOpen}
                onOpen={() => setIsWorkbenchOpen(true)}
                onClose={() => setIsWorkbenchOpen(false)}
              />
            )}
          </TopNavigation>
          {/* Content area with split layout */}
          {/* Content area with split layout */}
          <div className="flex flex-1 min-h-0">
            {/* Chat area - affected by workbench */}
            <div
              className="transition-all duration-300 ease-in-out flex flex-col min-h-0"
              style={{
                width: hasTaskId && isWorkbenchOpen && !isMobile ? '50%' : '100%',
              }}
            >
              <ChatArea
                teams={teams}
                isTeamsLoading={isTeamsLoading}
                selectedTeamForNewTask={selectedTeamForNewTask}
                taskType="code"
              />
            </div>

            {/* Workbench component - only show if there's a taskId and not on mobile */}
            {hasTaskId && !isMobile && (
              <Workbench
                isOpen={isWorkbenchOpen}
                onClose={() => setIsWorkbenchOpen(false)}
                onOpen={() => setIsWorkbenchOpen(true)}
                workbenchData={selectedTaskDetail?.workbench}
                isLoading={isWorkbenchLoading}
              />
            )}
          </div>
        </div>
      </div>
    </>
  );
}
