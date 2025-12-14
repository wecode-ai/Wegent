// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import { Suspense, useState, useEffect, useMemo } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { teamService } from '@/features/tasks/service/teamService';
import TopNavigation from '@/features/layout/TopNavigation';
import TaskSidebar from '@/features/tasks/components/TaskSidebar';
import ResizableSidebar from '@/features/tasks/components/ResizableSidebar';
import CollapsedSidebarButtons from '@/features/tasks/components/CollapsedSidebarButtons';
import OnboardingTour from '@/features/onboarding/OnboardingTour';
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
import { ThemeToggle } from '@/features/theme/ThemeToggle';
import { Team } from '@/types/api';
import { useTaskContext } from '@/features/tasks/contexts/taskContext';
import { useChatStreamContext } from '@/features/tasks/contexts/chatStreamContext';
import { saveLastTab } from '@/utils/userPreferences';
import { useIsMobile } from '@/features/layout/hooks/useMediaQuery';
import { calculateOpenLinks } from '@/utils/openLinks';
import { useUser } from '@/features/common/UserContext';
import { paths } from '@/config/paths';

export default function CodePage() {
  // Get search params to check for taskId
  const searchParams = useSearchParams();
  const taskId = searchParams.get('taskId');
  const hasTaskId = !!taskId;
  const hasShareId = !!searchParams.get('share_id');

  // Team state from service
  const { teams, isTeamsLoading, refreshTeams } = teamService.useTeams();

  // Task context for workbench data
  const { selectedTaskDetail } = useTaskContext();

  // Chat stream context
  const { clearAllStreams } = useChatStreamContext();

  // Router for navigation
  const router = useRouter();

  // User state for git token check
  const { user } = useUser();

  // Mobile sidebar state
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false);

  // Collapsed sidebar state
  const [isCollapsed, setIsCollapsed] = useState(false);

  // Selected team state for sharing
  const [selectedTeamForNewTask, setSelectedTeamForNewTask] = useState<Team | null>(null);

  // Share button state
  const [shareButton, setShareButton] = useState<React.ReactNode>(null);

  const handleShareButtonRender = (button: React.ReactNode) => {
    setShareButton(button);
  };

  // Workbench state - default to true when taskId exists
  const [isWorkbenchOpen, setIsWorkbenchOpen] = useState(true);

  // Mobile detection
  const isMobile = useIsMobile();

  // Check if user has git token
  const hasGitToken = !!(user?.git_info && user.git_info.length > 0);

  // Load collapsed state from localStorage
  useEffect(() => {
    const savedCollapsed = localStorage.getItem('task-sidebar-collapsed');
    if (savedCollapsed === 'true') {
      setIsCollapsed(true);
    }
  }, []);

  // Auto-open workbench when taskId is present
  useEffect(() => {
    if (hasTaskId) {
      setIsWorkbenchOpen(true);
    }
  }, [hasTaskId]);

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

  // Calculate thinking data from subtasks for timeline
  const thinkingData = useMemo(() => {
    if (!selectedTaskDetail?.subtasks || selectedTaskDetail.subtasks.length === 0) {
      return null;
    }

    // Extract thinking from the latest subtask result
    const latestSubtask = selectedTaskDetail.subtasks[selectedTaskDetail.subtasks.length - 1];
    if (latestSubtask?.result && typeof latestSubtask.result === 'object') {
      const result = latestSubtask.result as { thinking?: unknown[] };
      if (result.thinking && Array.isArray(result.thinking)) {
        return result.thinking as Array<{
          title: string;
          next_action: string;
          details?: Record<string, unknown>;
        }>;
      }
    }

    return null;
  }, [selectedTaskDetail]);

  // Save last active tab to localStorage
  useEffect(() => {
    saveLastTab('code');
  }, []);

  const handleRefreshTeams = async (): Promise<Team[]> => {
    return await refreshTeams();
  };

  const handleToggleCollapsed = () => {
    setIsCollapsed(prev => {
      const newValue = !prev;
      localStorage.setItem('task-sidebar-collapsed', String(newValue));
      return newValue;
    });
  };

  // Handle new task from collapsed sidebar button
  const handleNewTask = () => {
    clearAllStreams();
    router.replace(paths.code.getHref());
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
        currentPage="code"
        isLoading={isTeamsLoading}
        hasShareId={hasShareId}
      />
      <div className="flex smart-h-screen bg-base text-text-primary box-border">
        {/* Collapsed sidebar floating buttons */}
        {isCollapsed && !isMobile && (
          <CollapsedSidebarButtons onExpand={handleToggleCollapsed} onNewTask={handleNewTask} />
        )}
        {/* Responsive resizable sidebar - fixed, not affected by right panel */}
        <ResizableSidebar isCollapsed={isCollapsed} onToggleCollapsed={handleToggleCollapsed}>
          <TaskSidebar
            isMobileSidebarOpen={isMobileSidebarOpen}
            setIsMobileSidebarOpen={setIsMobileSidebarOpen}
            pageType="code"
            isCollapsed={isCollapsed}
            onToggleCollapsed={handleToggleCollapsed}
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
            {shareButton}
            {isMobile ? <ThemeToggle /> : <GithubStarButton />}
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
                width: hasTaskId && isWorkbenchOpen && !isMobile ? '60%' : '100%',
              }}
            >
              <ChatArea
                teams={teams}
                isTeamsLoading={isTeamsLoading}
                selectedTeamForNewTask={selectedTeamForNewTask}
                taskType="code"
                onShareButtonRender={handleShareButtonRender}
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
                taskTitle={selectedTaskDetail?.title}
                taskNumber={selectedTaskDetail ? `#${selectedTaskDetail.id}` : undefined}
                thinking={thinkingData}
              />
            )}
          </div>
        </div>
      </div>
    </>
  );
}
