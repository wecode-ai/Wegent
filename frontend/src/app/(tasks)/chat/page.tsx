// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import { Suspense, useState, useEffect } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { teamService } from '@/features/tasks/service/teamService';
import TopNavigation from '@/features/layout/TopNavigation';
import TaskSidebar from '@/features/tasks/components/TaskSidebar';
import ResizableSidebar from '@/features/tasks/components/ResizableSidebar';
import CollapsedSidebarButtons from '@/features/tasks/components/CollapsedSidebarButtons';
import OnboardingTour from '@/features/onboarding/OnboardingTour';
import TaskParamSync from '@/features/tasks/components/TaskParamSync';
import TeamShareHandler from '@/features/tasks/components/TeamShareHandler';
import TaskShareHandler from '@/features/tasks/components/TaskShareHandler';
import OidcTokenHandler from '@/features/login/components/OidcTokenHandler';
import '@/app/tasks/tasks.css';
import '@/features/common/scrollbar.css';
import { GithubStarButton } from '@/features/layout/GithubStarButton';
import { ThemeToggle } from '@/features/theme/ThemeToggle';
import { useIsMobile } from '@/features/layout/hooks/useMediaQuery';
import { Team } from '@/types/api';
import ChatArea from '@/features/tasks/components/ChatArea';
import { saveLastTab } from '@/utils/userPreferences';
import { useUser } from '@/features/common/UserContext';
import { useTaskContext } from '@/features/tasks/contexts/taskContext';
import { useChatStreamContext } from '@/features/tasks/contexts/chatStreamContext';
import { paths } from '@/config/paths';

export default function ChatPage() {
  // Team state from service
  const { teams, isTeamsLoading, refreshTeams } = teamService.useTeams();

  // Task context for refreshing task list
  const { refreshTasks } = useTaskContext();

  // Chat stream context
  const { clearAllStreams } = useChatStreamContext();

  // User state for git token check
  const { user } = useUser();

  // Router for navigation
  const router = useRouter();

  // Check for share_id in URL
  const searchParams = useSearchParams();
  const hasShareId = !!searchParams.get('share_id');

  // Check for pending task share from public page (after login)
  useEffect(() => {
    const pendingToken = localStorage.getItem('pendingTaskShare');
    if (pendingToken) {
      // Clear the pending token
      localStorage.removeItem('pendingTaskShare');
      // Redirect to chat page with taskShare parameter to trigger the copy modal
      router.push(`/chat?taskShare=${pendingToken}`);
    }
  }, [router]);

  // Mobile detection
  const isMobile = useIsMobile();

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

  // Check if user has git token
  const hasGitToken = !!(user?.git_info && user.git_info.length > 0);

  // Load collapsed state from localStorage
  useEffect(() => {
    const savedCollapsed = localStorage.getItem('task-sidebar-collapsed');
    if (savedCollapsed === 'true') {
      setIsCollapsed(true);
    }
  }, []);

  // Save last active tab to localStorage
  useEffect(() => {
    saveLastTab('chat');
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
    router.replace(paths.chat.getHref());
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
      <Suspense>
        <TaskShareHandler onTaskCopied={refreshTasks} />
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
        {/* Collapsed sidebar floating buttons */}
        {isCollapsed && !isMobile && (
          <CollapsedSidebarButtons onExpand={handleToggleCollapsed} onNewTask={handleNewTask} />
        )}
        {/* Responsive resizable sidebar */}
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
            activePage="chat"
            variant="with-sidebar"
            onMobileSidebarToggle={() => setIsMobileSidebarOpen(true)}
          >
            {shareButton}
            {isMobile ? <ThemeToggle /> : <GithubStarButton />}
          </TopNavigation>
          {/* Chat area without repository selector */}
          <ChatArea
            teams={teams}
            isTeamsLoading={isTeamsLoading}
            selectedTeamForNewTask={selectedTeamForNewTask}
            showRepositorySelector={false}
            taskType="chat"
            onShareButtonRender={handleShareButtonRender}
          />
        </div>
      </div>
    </>
  );
}
